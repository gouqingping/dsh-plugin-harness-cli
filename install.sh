#!/usr/bin/env bash
# dsh-plugin-harness-cli 一键安装脚本（macOS / Linux）
#
# 用法：
#   bash install.sh [--harness-root <path>] [--dsh-home <path>] [--skip-cordis]
# 等价环境变量：
#   DSH_HARNESS_ROOT / DSH_HOME / SKIP_CORDIS=1
#
# 与 install.ps1 行为一致：找 harness → 拷插件 → 建链接 → 注册 cordis.patch.yml。
# 重复执行安全：插件目录整体替换，注册只用标记块维护，不会产生重复条目。
set -euo pipefail

PLUGIN_NAME="dsh-plugin-harness-cli"
PLUGIN_ID="harness-cli"
SCOPE="@deepseek-ai"
MARKER_START="# >>> ${PLUGIN_NAME} >>>"
MARKER_END="# <<< ${PLUGIN_NAME} <<<"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="${SRC_DIR}/plugin"

HARNESS_ROOT="${DSH_HARNESS_ROOT:-}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SKIP_CORDIS="${SKIP_CORDIS:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --harness-root) HARNESS_ROOT="$2"; shift 2 ;;
    --dsh-home) DSH_HOME_DIR="$2"; shift 2 ;;
    --skip-cordis) SKIP_CORDIS=1; shift ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '✅ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) PLATFORM="macOS" ;;
  Linux)  PLATFORM="Linux" ;;
  *)      PLATFORM="$(uname -s)" ;;
esac
say "平台: ${PLATFORM} / bash ${BASH_VERSION%%(*}"

[ -f "${PLUGIN_SRC}/package.json" ] || die "本目录下没有 plugin/package.json，请在解压后的包根目录执行本脚本"

# 1. 找 harness
harness_candidates() {
  [ -n "${DSH_HARNESS_ROOT:-}" ] && printf '%s\n' "$DSH_HARNESS_ROOT"
  local base=""
  case "$PLATFORM" in
    macOS) base="$HOME/Library/Application Support/Seadun/Agent-App/versions" ;;
    *)     base="${XDG_CONFIG_HOME:-$HOME/.config}/Seadun/Agent-App/versions" ;;
  esac
  if [ -d "$base" ]; then
    # 版本目录按名字倒序，优先最新的
    find "$base" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -r | while IFS= read -r v; do
      printf '%s\n' "${v}/runtime/harness"
    done
  fi
}

if [ -z "$HARNESS_ROOT" ]; then
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -d "${candidate}/node_modules" ]; then HARNESS_ROOT="$candidate"; break; fi
  done < <(harness_candidates)
fi

if [ -z "$HARNESS_ROOT" ] || [ ! -d "${HARNESS_ROOT}/node_modules" ]; then
  die "未找到 DSH harness。请用 --harness-root <path> 指定（或设 DSH_HARNESS_ROOT）"
fi
say "使用 harness: ${HARNESS_ROOT}"

# 2. 是否已被 DSH 内置
BUILTIN=0
SCOPE_DIR="${HARNESS_ROOT}/node_modules/${SCOPE}"
if [ -d "$SCOPE_DIR" ]; then
  for pkg in "$SCOPE_DIR"/*/cordis.patch.yml; do
    [ -f "$pkg" ] || continue
    if grep -Eq "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${PLUGIN_ID}[[:space:]]*$" "$pkg" ||
       grep -Fq "${SCOPE}/${PLUGIN_NAME}" "$pkg"; then
      BUILTIN=1; break
    fi
  done
fi

# 3. 拷插件本体
HARNESS_PLUGIN="${HARNESS_ROOT}/node_modules/${SCOPE}/${PLUGIN_NAME}"
rm -rf "$HARNESS_PLUGIN"
mkdir -p "$HARNESS_PLUGIN"
cp -R "${PLUGIN_SRC}/." "$HARNESS_PLUGIN/"
ok "插件已复制到 harness: ${HARNESS_PLUGIN}"

# 4. 建链接（profiles 模块扫描需要）
PROFILE_PLUGIN="${DSH_HOME_DIR}/profiles/node_modules/${SCOPE}/${PLUGIN_NAME}"
mkdir -p "$(dirname "$PROFILE_PLUGIN")"
rm -rf "$PROFILE_PLUGIN"
if ln -s "$HARNESS_PLUGIN" "$PROFILE_PLUGIN" 2>/dev/null; then
  ok "符号链接已创建"
else
  cp -R "$HARNESS_PLUGIN" "$PROFILE_PLUGIN"
  warn "创建符号链接失败（权限？），已改为复制副本"
fi

# 5. CLI 可执行位
chmod +x "${HARNESS_PLUGIN}/bin/${PLUGIN_NAME}.js" 2>/dev/null || true

# 6. 注册 cordis.patch.yml（标记块 + 备份）
PATCH="${DSH_HOME_DIR}/profiles/web/cordis.patch.yml"
read -r -d '' ENTRY <<EOF || true
${MARKER_START}
- insert:
    - id: ${PLUGIN_ID}
      name: '${SCOPE}/${PLUGIN_NAME}'
${MARKER_END}
EOF

unique_backup() {
  local base="${1}.bak-$(date +%Y%m%d%H%M%S)"
  local candidate="$base"
  local n=1
  while [ -e "$candidate" ]; do candidate="${base}-${n}"; n=$((n + 1)); done
  printf '%s\n' "$candidate"
}

strip_block() {
  awk -v s="$MARKER_START" -v e="$MARKER_END" '
    { line = $0; sub(/\r$/, "", line) }
    line == s { skip = 1; next }
    line == e { skip = 0; next }
    !skip { print }
  ' "$1"
}

if [ "$BUILTIN" = "1" ]; then
  warn "插件 ${PLUGIN_NAME} 已随 DSH 内置，跳过 cordis 注册，仅更新文件"
elif [ "$SKIP_CORDIS" = "1" ]; then
  if [ -f "$PATCH" ] && grep -Fq "$MARKER_START" "$PATCH"; then
    backup="$(unique_backup "$PATCH")"
    cp "$PATCH" "$backup"
    strip_block "$PATCH" > "${PATCH}.tmp"
    mv "${PATCH}.tmp" "$PATCH"
    ok "已从 cordis.patch.yml 移除本插件注册（备份: ${backup}）"
  fi
  warn "按 --skip-cordis 要求跳过 cordis 注册"
elif [ ! -f "$PATCH" ]; then
  mkdir -p "$(dirname "$PATCH")"
  printf '%s\n' "$ENTRY" > "$PATCH"
  ok "已新建 cordis.patch.yml 并注册（首个插件）"
elif grep -Fq "$MARKER_START" "$PATCH" &&
     ! strip_block "$PATCH" | grep -Eq "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${PLUGIN_ID}[[:space:]]*$|${SCOPE}/${PLUGIN_NAME}"; then
  ok "cordis.patch.yml 已注册且无变化（跳过备份与写入）"
else
  backup="$(unique_backup "$PATCH")"
  cp "$PATCH" "$backup"
  strip_block "$PATCH" > "${PATCH}.clean"
  if grep -Eq "^[[:space:]]*-[[:space:]]*id:[[:space:]]*${PLUGIN_ID}[[:space:]]*$" "${PATCH}.clean" ||
     grep -Fq "${SCOPE}/${PLUGIN_NAME}" "${PATCH}.clean"; then
    mv "${PATCH}.clean" "$PATCH"
    warn "插件已在 cordis.patch.yml 注册（id/name 已存在），未重复写入"
  else
    { cat "${PATCH}.clean"; printf '\n%s\n' "$ENTRY"; } > "${PATCH}.tmp"
    mv "${PATCH}.tmp" "$PATCH"
    rm -f "${PATCH}.clean"
    ok "cordis.patch.yml 已注册（备份: ${backup}）"
  fi
fi

say ""
say "🎉 插件 ${PLUGIN_NAME} 安装完成！"
say "   完全退出 Seadun 应用后重新打开。"
say "   在目标项目里试跑："
say "   node \"${HARNESS_PLUGIN}/bin/${PLUGIN_NAME}.js\" check"
