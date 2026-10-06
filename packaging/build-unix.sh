#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-}"
ARCH="${2:-}"
NODE_VERSION="${NODE_VERSION:-$(node --version)}"
NODE_VERSION="${NODE_VERSION#v}"

if [[ "$PLATFORM" != "linux" && "$PLATFORM" != "darwin" ]]; then
  echo "Usage: $0 <linux|darwin> <x64|arm64>" >&2
  exit 2
fi
if [[ "$ARCH" != "x64" && "$ARCH" != "arm64" ]]; then
  echo "Usage: $0 <linux|darwin> <x64|arm64>" >&2
  exit 2
fi
if [[ ! "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "NODE_VERSION must be a semantic version such as 24.16.0." >&2
  exit 2
fi

HOST_PLATFORM="$(node -p 'process.platform')"
HOST_ARCH="$(node -p 'process.arch')"
if [[ "$PLATFORM" != "$HOST_PLATFORM" || "$ARCH" != "$HOST_ARCH" ]]; then
  echo "Native packaging requires $PLATFORM/$ARCH Node.js; current host is $HOST_PLATFORM/$HOST_ARCH." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARTIFACTS="$ROOT/artifacts"
STAGING="$ARTIFACTS/copilot-changelog-$PLATFORM-$ARCH"
TEMP="$ARTIFACTS/.tmp-$PLATFORM-$ARCH"

rm -rf "$STAGING" "$TEMP"
mkdir -p "$STAGING" "$TEMP"

cd "$ROOT"
npm run build
APPLICATION="$STAGING/app/node_modules/copilot-changelog-cli"
mkdir -p "$APPLICATION"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/README.md" "$APPLICATION/"
cp -R "$ROOT/dist" "$ROOT/assets" "$APPLICATION/"
npm ci --omit=dev --no-audit --no-fund --prefix "$APPLICATION"

NODE_ARCHIVE="$TEMP/node.tar.gz"
curl --fail --location --silent --show-error \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$PLATFORM-$ARCH.tar.gz" \
  --output "$NODE_ARCHIVE"
mkdir -p "$TEMP/node"
tar -xzf "$NODE_ARCHIVE" -C "$TEMP/node"
NODE_ROOT="$(find "$TEMP/node" -mindepth 1 -maxdepth 1 -type d -print -quit)"

mkdir -p "$STAGING/runtime"
cp "$NODE_ROOT/bin/node" "$STAGING/runtime/node"
cp "$NODE_ROOT/LICENSE" "$STAGING/runtime/NODE-LICENSE.txt"
cp "$ROOT/packaging/launcher/copilot-changelog" "$STAGING/copilot-changelog"
cp "$ROOT/README.md" "$STAGING/README.md"
chmod +x "$STAGING/runtime/node" "$STAGING/copilot-changelog"

(
  cd "$STAGING/app/node_modules/copilot-changelog-cli"
  "$STAGING/runtime/node" --input-type=module -e "await import('@github/copilot-$PLATFORM-$ARCH/sdk'); await import('@github/copilot-sdk')"
)
ACTUAL_VERSION="$(COPILOT_CHANGELOG_SKIP_UPDATE_CHECK=1 "$STAGING/copilot-changelog" --version)"
if [[ "$ACTUAL_VERSION" != "$VERSION" ]]; then
  echo "Packaged CLI version $ACTUAL_VERSION does not match manifest version $VERSION." >&2
  exit 1
fi

ARCHIVE="$ARTIFACTS/copilot-changelog-$VERSION-$PLATFORM-$ARCH.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" -C "$STAGING" .
rm -rf "$TEMP"

echo "Portable application: $STAGING"
echo "Portable archive: $ARCHIVE"
