#!/bin/bash
# One command to set up this project on a Mac. Safe to run again: anything already there is skipped.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/gangzhao2021/bop-rms/codex/wp-2402-pilot-submission/tooling/environment/setup-mac.sh)"
#
# Installs the code and the pinned toolchain. Keys and TEST data are not in this public repository:
# they come from the encrypted handoff package, which is opened and installed when it is found in
# Downloads or Desktop (docs/runbooks/development-machine-handoff-2026-11-02.md).
#
# BOP_RMS_HOME  use this folder instead of the home folder (rehearsal only)
set -euo pipefail

BRANCH=codex/wp-2402-pilot-submission
REPO=https://github.com/gangzhao2021/bop-rms.git
NODE_VERSION=24.18.0
COREPACK_VERSION=0.35.0
PNPM_VERSION=11.13.0
T="${BOP_RMS_HOME:-$HOME}"
R="$T/yashirq/bop-rms"
TOOLS="$T/.local/share/bop-rms/toolchain"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
wait_a_bit() { perl -e 'select(undef,undef,undef,$ARGV[0])' "$1"; }

[ "$(uname)" = Darwin ] || {
  echo '这个脚本只能在 Mac 上运行。'
  exit 1
}
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *)
    echo "不支持这种处理器：$(uname -m)"
    exit 1
    ;;
esac

say '检查开发工具'
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  echo '请在弹出的窗口点“安装”，这里会一直等它装完。'
  until xcode-select -p >/dev/null 2>&1; do wait_a_bit 5; done
fi

say "取得代码：$R"
if [ -d "$R/.git" ]; then
  git -C "$R" fetch -q origin "$BRANCH" || echo '暂时连不上 GitHub，先用已有代码。'
else
  mkdir -p "$(dirname "$R")"
  git clone -q --branch "$BRANCH" "$REPO" "$R"
fi

NODE_NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$TOOLS/$NODE_NAME/bin/node" ]; then
  say "安装 Node $NODE_VERSION"
  mkdir -p "$TOOLS"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz" -o "$TOOLS/$NODE_NAME.tar.gz"
  EXPECTED="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$NODE_NAME.tar.gz" '$2 == f { print $1 }')"
  ACTUAL="$(shasum -a 256 "$TOOLS/$NODE_NAME.tar.gz" | awk '{ print $1 }')"
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || {
    echo 'Node 下载校验失败，已停止。'
    rm -f "$TOOLS/$NODE_NAME.tar.gz"
    exit 1
  }
  tar -xzf "$TOOLS/$NODE_NAME.tar.gz" -C "$TOOLS"
fi
export PATH="$TOOLS/$NODE_NAME/bin:$TOOLS/corepack/node_modules/.bin:$PATH"
export COREPACK_HOME="$TOOLS/corepack-cache"
if [ "$(corepack --version 2>/dev/null || true)" != "$COREPACK_VERSION" ]; then
  say "安装 Corepack $COREPACK_VERSION"
  npm install --silent --prefix "$TOOLS/corepack" "corepack@$COREPACK_VERSION"
fi
corepack install --global "pnpm@$PNPM_VERSION" >/dev/null

# The same file the handoff package carries, so every repository tool finds this toolchain.
if [ ! -f "$R/.local/activate.sh" ]; then
  mkdir -p "$R/.local"
  cat >"$R/.local/activate.sh" <<EOF
export BOP_RMS_DEV_ROOT="$R"
export BOP_RMS_TOOLCHAIN="$TOOLS"
export COREPACK_HOME="\$BOP_RMS_TOOLCHAIN/corepack-cache"
export PATH="\$BOP_RMS_TOOLCHAIN/$NODE_NAME/bin:\$BOP_RMS_TOOLCHAIN/corepack/node_modules/.bin:\$BOP_RMS_DEV_ROOT/.local/bin:/Applications/Docker.app/Contents/Resources/bin:\$PATH"
EOF
fi

say '安装依赖'
(cd "$R" && pnpm install --frozen-lockfile 2>&1 | tail -1)

VOLUME_NAME='BOP-RMS 交接包'
MOUNT="/Volumes/$VOLUME_NAME"
if [ ! -d "$MOUNT" ]; then
  for DMG in "$T/Downloads/bop-rms-交接包.dmg" "$T/Desktop/bop-rms-交接包.dmg"; do
    [ -f "$DMG" ] || continue
    say "打开交接包，请输入打包时设的密码：$DMG"
    MOUNT="$(hdiutil attach -nobrowse "$DMG" | tail -1 | cut -f3)"
    break
  done
fi
if [ -f "$MOUNT/在新电脑双击安装.command" ]; then
  say '安装测试环境'
  if [ -n "${BOP_RMS_HOME:-}" ]; then export TARGET_HOME="$BOP_RMS_HOME"; fi
  /bin/bash "$MOUNT/在新电脑双击安装.command"
else
  printf '\n代码和工具已装好：%s\n' "$R"
  printf '还没有测试环境：没找到交接包。把 bop-rms-交接包.dmg 放进“下载”文件夹，再运行一次这行命令。\n'
fi
