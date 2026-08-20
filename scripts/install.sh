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
#
# 示例:
#   ./scripts/install.sh                              # 默认安装到 ~/dsh-web-llm-bridge-data
#   ./scripts/install.sh --base /data/llm-bridge      # 指定数据目录
#   ./scripts/install.sh --profile web --headless     # 指定 profile 并使用无头模式
#
set -euo pipefail

# ---------- 默认值 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="${DSH_BRIDGE_BASE:-$HOME/dsh-web-llm-bridge-data}"
PROFILE="web"
HEADLESS="headed"
INSTALL_BROWSER=1

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
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "==> 创建 Python 虚拟环境: $BASE/.venv"
  python3 -m venv "$BASE/.venv"
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
echo "==> 注册插件到 DSH profile '${PROFILE}'"
if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR" || true
elif [[ -f "$PROFILE_DIR/package.json" ]]; then
  echo "  dsh CLI 不在 PATH，尝试直接写入 profile/package.json"
  if ! grep -q '"dsh-web-llm-bridge"' "$PROFILE_DIR/package.json" 2>/dev/null; then
    # 用 node 的 npm pkg 语法更新（若可用），否则提示手动
    if command -v npm >/dev/null 2>&1 && ( cd "$PROFILE_DIR" && npm pkg set "dependencies.dsh-web-llm-bridge=link:$PLUGIN_DIR" >/dev/null 2>&1 ); then
      echo "  已把 dsh-web-llm-bridge 加入 $PROFILE_DIR/package.json"
    else
      echo "  ! 未能自动写入，请手动在 $PROFILE_DIR/package.json 的 dependencies 加入："
      echo "    \"dsh-web-llm-bridge\": \"link:$PLUGIN_DIR\""
    fi
  else
    echo "  package.json 已包含 dsh-web-llm-bridge，跳过"
  fi
else
  echo "  ! 未找到 DSH profile 目录 ($PROFILE_DIR)，跳过自动注册"
  echo "    请先初始化 DSH web profile（如 dsh init --profile $PROFILE），再运行本脚本。"
fi

# ---------- 5. 生成/更新 profile 配置 (cordis.patch.yml) ----------
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if [[ -d "$PROFILE_DIR" ]]; then
  echo "==> 更新 $PATCH_FILE"
  # 若文件不存在则创建（空 profile 根）
  if [[ ! -f "$PATCH_FILE" ]]; then
    echo "# dsh-llm-web-bridge install.sh generated" > "$PATCH_FILE"
    echo "[]" >> "$PATCH_FILE"
  fi
  # 如果已经配置过则跳过，否则追加
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
PATCH
    echo "  已写入插件配置到 $PATCH_FILE"
  else
    echo "  $PATCH_FILE 已包含 web-llm-bridge 配置，跳过（如需更新请手动编辑）"
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
echo ""
echo " 数据目录: $BASE"
echo " 配置文件: $HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
echo "============================================================"
