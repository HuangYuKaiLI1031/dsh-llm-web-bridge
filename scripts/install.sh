#!/usr/bin/env bash
#
# dsh-llm-web-bridge 一键安装脚本
#
# 自动完成:
#   1. 创建 Python 虚拟环境 + 安装 Playwright
#   2. 下载 Chromium 浏览器
#   3. 检测（可选）中文字体 / Xvfb
#   4. 把插件注册到 DSH profile
#   5. 生成/更新 profile 配置 (cordis.patch.yml)
#
# 用法:
#   ./scripts/install.sh [--base DIR] [--profile NAME] [--headless] [--no-browser]
#                        [--conda-deps [CONDA_EXE]]
#
# 示例:
#   ./scripts/install.sh                              # 默认安装到 ~/dsh-web-llm-bridge-data
#   ./scripts/install.sh --base /data/llm-bridge      # 指定数据目录
#   ./scripts/install.sh --profile web --headless     # 指定 profile 并使用无头模式
#   ./scripts/install.sh --conda-deps                 # 用 conda 装齐 Chromium 系统库（无需 sudo）
#   ./scripts/install.sh --conda-deps /path/to/mamba  # 指定 conda/mamba 可执行文件
#
set -euo pipefail

# ---------- 默认值 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="${DSH_BRIDGE_BASE:-$HOME/dsh-web-llm-bridge-data}"
PROFILE="web"
HEADLESS="headed"
INSTALL_BROWSER=1
CONDA_DEP_ENV="dsh-llm-web-bridge-deps"   # Chromium 系统依赖 conda 环境名
CONDA_EXE=""                               # 空 = 自动探测 conda/mamba

# ---------- 解析参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE="$2"; shift 2;;
    --profile)
      PROFILE="$2"; shift 2;;
    --headless)
      HEADLESS="headless"; shift;;
    --no-browser)
      INSTALL_BROWSER=0; shift;;
    --conda-deps)
      if [[ $# -ge 2 && "$2" != --* ]]; then
        CONDA_EXE="$2"; shift 2
      else
        CONDA_EXE="auto"; shift
      fi;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0;;
    *)
      echo "未知参数: $1"; echo "用 --help 查看用法"; exit 1;;
  esac
done

PYTHON_BIN="${DSH_BRIDGE_PYTHON:-$BASE/.venv/bin/python}"
PLAYWRIGHT_BROWSERS="${DSH_BRIDGE_BROWSERS:-$BASE/.pw-browsers}"

echo "==> 插件目录:  $PLUGIN_DIR"
echo "==> 数据目录:  $BASE"
echo "==> DSH profile: $PROFILE ($HEADLESS 模式)"

# ---------- 0. 准备目录 ----------
mkdir -p "$BASE"

# ---------- 1. Python 虚拟环境 + Playwright ----------
# 部分 Debian/Ubuntu 的系统 python3 缺 ensurepip（需 python3-venv 包），
# 直接 python3 -m venv 会失败。这里先正常尝试；失败则降级为
# --without-pip + get-pip.py 引导安装（无需 sudo/apt），保证安装不被卡死。
create_venv() {
  echo "==> 创建 Python 虚拟环境: $BASE/.venv"
  if python3 -m venv "$BASE/.venv"; then
    return 0
  fi
  echo "  ! python3 -m venv 失败（常见原因：缺少 ensurepip / python3-venv 包）"
  echo "    降级方案：--without-pip + get-pip.py 引导安装 pip"
  rm -rf "$BASE/.venv"
  if ! python3 -m venv --without-pip "$BASE/.venv"; then
    echo "  ✗ 虚拟环境仍创建失败。请任选其一后重试："
    echo "    1) sudo apt install python3-venv   （推荐，安装系统 venv 支持）"
    echo "    2) 用自带 ensurepip 的 Python 重新运行："
    echo "       DSH_BRIDGE_PYTHON=/path/to/python-with-ensurepip ./scripts/install.sh"
    return 1
  fi
  local GETPIP="$BASE/.venv/get-pip.py"
  # 新版 get-pip.py 要求 Python >=3.10；老版本用带版本的 URL（pip/3.9、pip/3.8…）
  local PYVER
  PYVER="$("$BASE/.venv/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  local PIP_URL="https://bootstrap.pypa.io/get-pip.py"
  case "$PYVER" in
    3.8|3.9) PIP_URL="https://bootstrap.pypa.io/pip/$PYVER/get-pip.py" ;;
  esac
  echo "  (venv Python $PYVER，get-pip 来源: $PIP_URL)"
  if curl -fsSL "$PIP_URL" -o "$GETPIP" 2>/dev/null || wget -q "$PIP_URL" -O "$GETPIP" 2>/dev/null; then
    "$BASE/.venv/bin/python" "$GETPIP"
    rm -f "$GETPIP"
    echo "  ✓ 已通过 get-pip.py 安装 pip"
  else
    echo "  ✗ 下载 get-pip.py 失败（请检查网络，或手动执行上面的 apt 方案）"
    return 1
  fi
}

if [[ ! -x "$PYTHON_BIN" ]]; then
  create_venv || exit 1
else
  echo "==> 复用已有虚拟环境: $BASE/.venv"
fi

echo "==> 安装/更新 playwright"
"$PYTHON_BIN" -m pip install --upgrade pip >/dev/null
"$PYTHON_BIN" -m pip install playwright

# ---------- 2. Chromium ----------
if [[ "$INSTALL_BROWSER" == "1" ]]; then
  echo "==> 安装 Chromium 到: $PLAYWRIGHT_BROWSERS"
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS" "$PYTHON_BIN" -m playwright install chromium
else
  echo "==> 跳过浏览器安装 (--no-browser)"
fi

# ---------- 2.5 Chromium 系统依赖（conda，无需 sudo） ----------
# 无 root 权限的机器上系统常缺 libatk/libcups/libxkbcommon/libgbm/pango/cairo 等，
# 用 conda-forge 装到一个专用环境，再把它的 lib 目录经 LD_LIBRARY_PATH 注入守护进程。
CHROME_BIN=""
if [[ -d "$PLAYWRIGHT_BROWSERS" ]]; then
  CHROME_BIN="$(find "$PLAYWRIGHT_BROWSERS" -type f -path '*/chrome-linux/chrome' 2>/dev/null | head -1)"
fi

find_conda() {
  if [[ "$CONDA_EXE" == "auto" || -z "$CONDA_EXE" ]]; then
    for c in mamba conda; do
      if command -v "$c" >/dev/null 2>&1; then echo "$(command -v "$c")"; return 0; fi
    done
    for p in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3" /opt/conda; do
      if [[ -x "$p/bin/conda" ]]; then echo "$p/bin/conda"; return 0; fi
      if [[ -x "$p/bin/mamba" ]]; then echo "$p/bin/mamba"; return 0; fi
    done
    return 1
  else
    echo "$CONDA_EXE"
  fi
}

ensure_conda_deps() {
  local CONDA="$(find_conda)" || { echo "  ✗ 未找到 conda/mamba（可手动指定：--conda-deps /path/to/mamba）"; return 1; }
  echo "==> 用 conda 准备 Chromium 系统库环境: $CONDA_DEP_ENV"
  echo "  (conda: $CONDA)"
  local BASE_ENV="$("$CONDA" env list 2>/dev/null | awk -v e="$CONDA_DEP_ENV" '$1==e{print $NF; exit}')"
  if [[ -z "$BASE_ENV" ]]; then
    echo "  创建 conda 环境 $CONDA_DEP_ENV（首次需下载，稍候）..."
    "$CONDA" create -y -n "$CONDA_DEP_ENV" -c conda-forge \
      atk at-spi2-atk at-spi2-core \
      libcups libxkbcommon \
      xorg-libxcomposite xorg-libxdamage xorg-libxfixes xorg-libxrandr \
      libgbm pango cairo \
      nss nspr alsa-lib expat \
      >/dev/null || { echo "  ✗ conda create 失败，请手动检查网络/渠道后重试"; return 1; }
    BASE_ENV="$("$CONDA" env list 2>/dev/null | awk -v e="$CONDA_DEP_ENV" '$1==e{print $NF; exit}')"
  else
    echo "  复用已有 conda 环境: $BASE_ENV"
  fi
  if [[ -z "$BASE_ENV" || ! -d "$BASE_ENV/lib" ]]; then
    echo "  ✗ 无法定位 conda 环境目录"; return 1
  fi
  echo "$BASE_ENV/lib"
}

missing_libs() {
  [[ -n "$CHROME_BIN" && -x "$CHROME_BIN" ]] || return 0
  ldd "$CHROME_BIN" 2>/dev/null | awk '/not found/{print $1}'
}

LDLIB_PATH=""
if [[ "$CONDA_EXE" != "" ]]; then
  LDLIB_PATH="$(ensure_conda_deps)" && echo "  ✓ Chromium 系统库目录: $LDLIB_PATH"
else
  local_missing="$(missing_libs)"
  if [[ -n "$local_missing" ]]; then
    echo ""
    echo "  ⚠ 检测到 Chromium 缺少系统依赖库："
    echo "$local_missing" | sed 's/^/      /'
    if command -v sudo >/dev/null 2>&1; then
      echo "  修复方式（二选一）："
      echo "    1) sudo 安装系统库:  sudo \"$PYTHON_BIN\" -m playwright install-deps chromium"
      echo "    2) 用 conda（无需 sudo）:  ./scripts/install.sh --conda-deps"
    else
      echo "  修复方式（无需 sudo，推荐）:  重新运行  ./scripts/install.sh --conda-deps"
    fi
    echo ""
  fi
fi

# ---------- 3. 检测可选依赖 ----------
echo "==> 检测可选依赖"
MISSING_OPTS=()

if ! command -v Xvfb >/dev/null 2>&1; then
  MISSING_OPTS+=("Xvfb：有头模式需要。安装: conda create -n xvfb-clean -c conda-forge xvfb 或 apt install xvfb")
else
  echo "  - Xvfb: ✓"
fi
if [[ -d /usr/share/fonts ]] || [[ -d /usr/share/fonts/truetype ]]; then
  echo "  - 中文字体: 系统字体目录存在（若有 CJK 字体则中文正常）"
else
  MISSING_OPTS+=("中文字体：建议安装 Noto Sans SC，否则面板中文可能显示为方块")
fi

if [[ ${#MISSING_OPTS[@]} -gt 0 ]]; then
  echo "  (以下为可选，不影响基本功能:)"
  for msg in "${MISSING_OPTS[@]}"; do echo "    ! $msg"; done
fi

# ---------- 4. 安装到 DSH profile ----------
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
# 本地插件必须以 link: 前缀注册（裸路径会被 dsh 当成 npm 包名，注册不上）。
add_local_via_dsh() {
  if command -v dsh >/dev/null 2>&1; then
    dsh plugin --profile "$PROFILE" add "link:$PLUGIN_DIR" || true
  fi
}

add_local_via_npm() {
  if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
    echo "  ! 未找到 DSH profile 目录 ($PROFILE_DIR)，跳过自动注册"
    echo "    请先初始化 DSH web profile（如 dsh init --profile $PROFILE），再运行本脚本。"
    return 1
  fi
  if grep -q '"dsh-llm-web-bridge"' "$PROFILE_DIR/package.json" 2>/dev/null; then
    echo "  package.json 已包含 dsh-llm-web-bridge，跳过"
    return 0
  fi
  if command -v npm >/dev/null 2>&1 && ( cd "$PROFILE_DIR" && npm pkg set "dependencies.dsh-llm-web-bridge=link:$PLUGIN_DIR" >/dev/null 2>&1 ); then
    echo "  已把 dsh-llm-web-bridge 加入 $PROFILE_DIR/package.json"
    return 0
  fi
  echo "  ! 未能自动写入，请手动在 $PROFILE_DIR/package.json 的 dependencies 加入："
  echo "    \"dsh-llm-web-bridge\": \"link:$PLUGIN_DIR\""
  return 1
}

echo "==> 注册插件到 DSH profile '${PROFILE}'"
add_local_via_dsh
# 双保险：确认 dependencies 里确实有该插件（dsh add 可能因网络/策略没写进去），
# 没有则用 npm pkg set 兜底写入（dsh CLI 分支也会走到这里做校验）。
if ! grep -q '"dsh-llm-web-bridge"' "$PROFILE_DIR/package.json" 2>/dev/null; then
  add_local_via_npm
fi

# ---------- 5. 生成/更新 profile 配置 (cordis.patch.yml) ----------
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
# 组装 ldLibraryPath 配置行（有 conda 依赖环境时才写入）
LDLIB_LINE=""
if [[ -n "$LDLIB_PATH" ]]; then
  LDLIB_LINE="    ldLibraryPath: $LDLIB_PATH"
fi
if [[ -d "$PROFILE_DIR" ]]; then
  echo "==> 更新 $PATCH_FILE"
  # 若文件不存在则创建（空 profile 根）
  if [[ ! -f "$PATCH_FILE" ]]; then
    echo "# dsh-llm-web-bridge install.sh generated" > "$PATCH_FILE"
    echo "[]" >> "$PATCH_FILE"
  fi
  # 如果已经配置过则追加，否则追加
  if ! grep -q "id: web-llm-bridge" "$PATCH_FILE"; then
    # 若当前是空的 "[]"，先替换为合法 YAML 数组
    if grep -q '^\[\]$' "$PATCH_FILE"; then
      sed -i 's/^\[\]$//' "$PATCH_FILE"
    fi
    cat >> "$PATCH_FILE" <<PATCH
- id: web-llm-bridge
  config:
    base: $BASE
    pythonBin: $PYTHON_BIN
    playwrightBrowsers: $PLAYWRIGHT_BROWSERS
    headless: $( [[ "$HEADLESS" == "headless" ]] && echo true || echo false )
${LDLIB_LINE}
PATCH
    echo "  已写入插件配置到 $PATCH_FILE"
  else
    # 已存在：若本次有 conda 依赖且配置里还没有 ldLibraryPath，则补一行
    if [[ -n "$LDLIB_PATH" ]] && ! grep -q "ldLibraryPath:" "$PATCH_FILE"; then
      sed -i "/^    headless:/a\\$LDLIB_LINE" "$PATCH_FILE"
      echo "  已在 $PATCH_FILE 补写 ldLibraryPath"
    else
      echo "  $PATCH_FILE 已包含 web-llm-bridge 配置，跳过（如需更新请手动编辑）"
    fi
  fi
fi

# ---------- 完成 ----------
echo ""
echo "============================================================"
echo " 安装完成!"
echo ""
echo " 下一步:"
echo "   1. 确认 DSH profile 已注册插件：  dsh plugin --profile $PROFILE list | grep web-llm"
echo "   2. 重启 DSH web：                cd ~/.dsh/profiles/$PROFILE && dsh web"
echo "   3. 打开面板 → 配置 → 粘贴 Cookie（Gemini/ChatGPT/豆包）"
if [[ -n "$LDLIB_PATH" ]]; then
  echo ""
  echo "  已启用 conda 系统库环境（无需 sudo）:"
  echo "    ldLibraryPath: $LDLIB_PATH"
fi
echo ""
echo " 数据目录: $BASE"
echo " 配置文件: $HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
echo "============================================================"
