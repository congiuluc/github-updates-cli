#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-x64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"

bash "$ROOT/packaging/build-unix.sh" linux "$ARCH"

case "$ARCH" in
  x64) DEB_ARCH="amd64" ;;
  arm64) DEB_ARCH="arm64" ;;
  *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 2 ;;
esac

PACKAGE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/copilot-changelog-deb-$ARCH.XXXXXX")"
INSTALL_ROOT="$PACKAGE_ROOT/opt/copilot-changelog"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT
mkdir -p "$INSTALL_ROOT" "$PACKAGE_ROOT/DEBIAN" "$PACKAGE_ROOT/usr/bin"
cp -R "$ROOT/artifacts/copilot-changelog-linux-$ARCH/." "$INSTALL_ROOT/"
ln -s /opt/copilot-changelog/copilot-changelog "$PACKAGE_ROOT/usr/bin/copilot-changelog"

cat > "$PACKAGE_ROOT/DEBIAN/control" <<EOF
Package: copilot-changelog-cli
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Copilot Changelog CLI contributors
Description: Generate GitHub Copilot changelog presentations and offline websites
EOF
chmod 0755 "$PACKAGE_ROOT/DEBIAN"
chmod 0644 "$PACKAGE_ROOT/DEBIAN/control"

DEB="$ROOT/artifacts/copilot-changelog_${VERSION}_${DEB_ARCH}.deb"
rm -f "$DEB"
dpkg-deb --build --root-owner-group "$PACKAGE_ROOT" "$DEB"
rm -rf "$PACKAGE_ROOT"
trap - EXIT
echo "Debian package: $DEB"
