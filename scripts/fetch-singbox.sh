#!/usr/bin/env bash
#
# Downloads the sing-box binaries the test suite validates against.
#
# The tests assert against the real binary rather than a hand-written schema:
# `sing-box check` catches field and type errors, and booting it catches things
# `check` cannot (a DNS server detouring to an empty `direct` outbound, for one).
#
# Usage: scripts/fetch-singbox.sh [version ...]

set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p .tools

VERSIONS=("${@:-}")
if [ -z "${VERSIONS[0]}" ]; then
  # The current stable line, plus the previous one for the compatibility target.
  VERSIONS=(1.14.1 1.13.21)
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

for version in "${VERSIONS[@]}"; do
  target=".tools/sing-box-${version}"
  if [ -x "$target" ]; then
    echo "already present: $target"
    continue
  fi

  name="sing-box-${version}-${os}-${arch}"
  url="https://github.com/SagerNet/sing-box/releases/download/v${version}/${name}.tar.gz"
  echo "fetching ${name}"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$url" -o "$tmp/sing-box.tar.gz"
  tar -xzf "$tmp/sing-box.tar.gz" -C "$tmp"
  mv "$tmp/${name}/sing-box" "$target"
  chmod +x "$target"
  rm -rf "$tmp"
  trap - EXIT

  "$target" version | head -1
done
