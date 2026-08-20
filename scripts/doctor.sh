#!/usr/bin/env bash
#
# dsh-llm-web-bridge 环境诊断脚本
#
# 检查所有运行依赖是否就绪，输出 ✓ / ✗ 和修复建议。
#
# 用法: ./scripts/doctor.sh [--base DIR]
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="$HOME/dsh-web-llm-bridge-data"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2;;
    -h|--help) head -20 "$0"; exit 0;;
    *) BASE="$1"; shift;;
  esac
done
PYTHON_BIN="$BASE/.venv/bin/python"
PW_BROWSERS="$BASE/.pw-browsers"

echo "==> 插件目录:  $PLUGIN_DIR"
echo "==> 数据目录:  $BASE"
echo ""

FAIL=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ $name"
  else
    echo "✗ $name"
    FAIL=1
  fi
}

check "插件 package.json 存在" test -f "$PLUGIN_DIR/package.json"
check "Python 虚拟环境存在" test -x "$PYTHON_BIN"
check "playwright Python 包已安装" "$PYTHON_BIN" -c "import playwright; print()"
check "Node 可用" command -v node
check "npm check 语法通过" sh -c "cd '$PLUGIN_DIR' && npm run check"

if [[ -d "$PW_BROWSERS" ]]; then
  echo "✓ Chromium 浏览器目录: $PW_BROWSERS"
else
  echo "✗ Chromium 浏览器目录缺失: $PW_BROWSERS"
  echo "    运行: PLAYWRIGHT_BROWSERS_PATH='$PW_BROWSERS' '$PYTHON_BIN' -m playwright install chromium"
  FAIL=1
fi

# 可选依赖
if command -v Xvfb >/dev/null 2>&1; then
  echo "✓ Xvfb（有头模式可用）"
else
  echo "○ Xvfb 未安装（无头模式不影响；有头/过 Cloudflare 建议安装）"
fi

echo ""
if [[ "$FAIL" == "0" ]]; then
  echo "全部必需依赖就绪 ✓"
else
  echo "存在缺失项，请按上方提示修复后重试。"
fi
exit "$FAIL"
