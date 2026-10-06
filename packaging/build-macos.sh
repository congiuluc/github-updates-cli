#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-arm64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"

bash "$ROOT/packaging/build-unix.sh" darwin "$ARCH"

PACKAGE_ROOT="$ROOT/artifacts/.pkg-$ARCH"
INSTALL_ROOT="$PACKAGE_ROOT/usr/local/lib/copilot-changelog"
rm -rf "$PACKAGE_ROOT"
mkdir -p "$INSTALL_ROOT" "$PACKAGE_ROOT/usr/local/bin"
cp -R "$ROOT/artifacts/copilot-changelog-darwin-$ARCH/." "$INSTALL_ROOT/"
cat > "$PACKAGE_ROOT/usr/local/bin/copilot-changelog" <<'EOF'
#!/bin/sh
exec /usr/local/lib/copilot-changelog/copilot-changelog "$@"
EOF
chmod +x "$PACKAGE_ROOT/usr/local/bin/copilot-changelog"

PKG="$ROOT/artifacts/copilot-changelog-$VERSION-macos-$ARCH.pkg"
rm -f "$PKG"
pkgbuild \
  --root "$PACKAGE_ROOT" \
  --identifier io.github.congiuluc.copilot-changelog-cli \
  --version "$VERSION" \
  --install-location / \
  "$PKG"
rm -rf "$PACKAGE_ROOT"
echo "macOS package: $PKG"
