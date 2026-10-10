#!/usr/bin/env bash
# Build native installable packages. Run on the destination distro family:
# Arch -> pacman package; Ubuntu/Debian -> Tauri's Debian bundle.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
FORMAT=auto
CHECK_ONLY=false
INSTALL_DEPS=false
SKIP_NPM_CI=false
STAGING_DIR=

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: bash scripts/build-linux.sh [options]

  --format auto|arch|deb  Package format (default: detect the host distro)
  --check                Check prerequisites without building or installing
  --install-deps         Install native build dependencies using sudo
  --skip-npm-ci          Reuse installed frontend dependencies
  -h, --help             Show this help

Requires Node.js 22+ and a recent stable Rust toolchain (cargo + rustc).
Build as a normal user. --install-deps only elevates the package-manager step.
Packages are copied to release/linux/; this script does not install PetGPT.

Build .deb on Ubuntu/Debian, not Arch: the resulting binary depends on the
build system's glibc. Use Ubuntu 22.04 to support Ubuntu 22.04 and newer.
CARGO_BUILD_JOBS defaults to 4; override it to change build parallelism.
EOF
}

while (($#)); do
  case "$1" in
    --format) (($# >= 2)) || die '--format requires a value'; FORMAT=$2; shift 2 ;;
    --check) CHECK_ONLY=true; shift ;;
    --install-deps) INSTALL_DEPS=true; shift ;;
    --skip-npm-ci) SKIP_NPM_CI=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $(uname -s) == Linux ]] || die 'This script requires Linux.'
[[ -r /etc/os-release ]] || die 'Cannot identify this Linux distribution.'
# shellcheck source=/dev/null
source /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *' arch '*) HOST_FORMAT=arch ;;
  *' ubuntu '*|*' debian '*) HOST_FORMAT=deb ;;
  *) die "Unsupported distro: ${ID:-unknown}. Use Arch or Ubuntu/Debian." ;;
esac
[[ $FORMAT != auto ]] || FORMAT=$HOST_FORMAT
[[ $FORMAT == arch || $FORMAT == deb ]] || die '--format must be auto, arch, or deb.'
[[ $FORMAT == "$HOST_FORMAT" ]] || die 'Build on the matching distro family; changing the package suffix cannot make a binary ABI-compatible.'
if $CHECK_ONLY && $INSTALL_DEPS; then die '--check cannot be combined with --install-deps.'; fi

if [[ $FORMAT == arch ]]; then
  NATIVE_PACKAGES=(base-devel pkgconf webkit2gtk-4.1 libayatana-appindicator librsvg openssl)
  INSTALL_COMMAND=(sudo pacman -S --needed "${NATIVE_PACKAGES[@]}")
else
  NATIVE_PACKAGES=(build-essential pkg-config libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf file dpkg-dev)
  INSTALL_COMMAND=(sudo apt-get install "${NATIVE_PACKAGES[@]}")
fi

if $INSTALL_DEPS; then
  ((EUID != 0)) || die 'Run this script as a normal user, not root.'
  command -v sudo >/dev/null || die 'sudo is required for --install-deps.'
  if [[ $FORMAT == deb ]]; then sudo apt-get update; fi
  "${INSTALL_COMMAND[@]}"
fi

missing=()
for command in node npm cargo rustc pkg-config cc; do
  command -v "$command" >/dev/null || missing+=("$command")
done
if [[ $FORMAT == arch ]]; then
  for command in makepkg fakeroot; do command -v "$command" >/dev/null || missing+=("$command"); done
else
  for command in dpkg-deb patchelf; do command -v "$command" >/dev/null || missing+=("$command"); done
fi
if command -v pkg-config >/dev/null; then
  for library in gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 openssl; do
    pkg-config --exists "$library" || missing+=("$library")
  done
fi
if ((${#missing[@]})); then
  printf 'Missing prerequisites: %s\n' "${missing[*]}" >&2
  printf 'Native dependencies: ' >&2; printf '%q ' "${INSTALL_COMMAND[@]}" >&2; printf '\n' >&2
  die 'Install Node.js 22+ and current stable Rust separately if missing, then run again.'
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || die 'Node.js 22 or newer is required.'
TARGET=$(rustc -vV | sed -n 's/^host: //p')
case "$TARGET" in
  x86_64-unknown-linux-gnu) PACKAGE_ARCH=x86_64 ;;
  aarch64-unknown-linux-gnu) PACKAGE_ARCH=aarch64 ;;
  *) die "Unsupported Rust host: $TARGET. Native x86_64/aarch64 GNU Linux builds are supported." ;;
esac
printf 'Prerequisites OK: %s, %s, format=%s\n' "${PRETTY_NAME:-$ID}" "$TARGET" "$FORMAT"
$CHECK_ONLY && exit 0
((EUID != 0)) || die 'Build as a normal user; makepkg does not support root builds.'

cd -- "$PROJECT_DIR"
if ! $SKIP_NPM_CI; then npm ci --no-audit --no-fund; fi
[[ -x node_modules/.bin/tauri ]] || die 'Frontend dependencies are missing. Run npm ci or omit --skip-npm-ci.'
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
TARGET_DIR=$(cargo metadata --no-deps --format-version 1 --manifest-path src-tauri/Cargo.toml |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).target_directory))')
BUILD_DIR="$TARGET_DIR/$TARGET/release"
OUTPUT_DIR="$PROJECT_DIR/release/linux"
PRODUCT_NAME=$(node -p 'JSON.parse(require("fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).productName')
[[ $PRODUCT_NAME =~ ^[A-Za-z0-9._-]+$ ]] || die 'The Linux package resource directory requires a simple productName.'
mkdir -p -- "$OUTPUT_DIR"

if [[ $FORMAT == deb ]]; then
  npm run tauri -- build --ci --target "$TARGET" --bundles deb -- --locked
  shopt -s nullglob
  packages=("$BUILD_DIR/bundle/deb/"*.deb)
  ((${#packages[@]})) || die 'Tauri did not produce a Debian package.'
  # Only copy this build's version/architecture, not older bundles.
  VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).version')
  DEB_ARCH=$(dpkg --print-architecture)
  PACKAGE="$BUILD_DIR/bundle/deb/${PRODUCT_NAME}_${VERSION}_${DEB_ARCH}.deb"
  [[ -f $PACKAGE ]] || die "Expected package not found: $PACKAGE"
  cp -- "$PACKAGE" "$OUTPUT_DIR/"
  printf '\nInstall with:\n  sudo apt install %q\n' "$OUTPUT_DIR/$(basename -- "$PACKAGE")"
  exit 0
fi

npm run tauri -- build --ci --target "$TARGET" --no-bundle -- --locked
VERSION=$(node -p 'JSON.parse(require("fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).version')
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Arch packaging currently requires an x.y.z release version.'
[[ -x $BUILD_DIR/petgpt ]] || die "Built executable missing: $BUILD_DIR/petgpt"
STAGING_DIR=$(mktemp -d "$TARGET_DIR/petgpt-arch.XXXXXXXX")
trap '[[ -z $STAGING_DIR ]] || rm -rf -- "$STAGING_DIR"' EXIT
PAYLOAD="$STAGING_DIR/payload"
install -Dm755 "$BUILD_DIR/petgpt" "$PAYLOAD/usr/bin/petgpt"
install -Dm644 LICENSE "$PAYLOAD/usr/share/licenses/petgpt/LICENSE"
install -Dm644 scripts/linux/petgpt.desktop "$PAYLOAD/usr/share/applications/petgpt.desktop"
for size in 32 128 256; do
  icon="src-tauri/icons/${size}x${size}.png"
  [[ $size != 256 ]] || icon=src-tauri/icons/128x128@2x.png
  install -Dm644 "$icon" "$PAYLOAD/usr/share/icons/hicolor/${size}x${size}/apps/petgpt.png"
done
mkdir -p "$PAYLOAD/usr/lib/$PRODUCT_NAME/assets" "$PAYLOAD/usr/lib/$PRODUCT_NAME/scripts"
cp -- src-tauri/assets/*.png "$PAYLOAD/usr/lib/$PRODUCT_NAME/assets/"
install -m644 scripts/export_intent_training.mjs "$PAYLOAD/usr/lib/$PRODUCT_NAME/scripts/"
# Tauri resolves resource_dir() to /usr/lib/<productName> (case-sensitive).
cp scripts/linux/PKGBUILD.in "$STAGING_DIR/PKGBUILD"
sed -i "s/@VERSION@/$VERSION/g; s/@ARCH@/$PACKAGE_ARCH/g" "$STAGING_DIR/PKGBUILD"
(
  cd -- "$STAGING_DIR"
  PKGDEST="$OUTPUT_DIR" makepkg --force --noconfirm
)
printf '\nInstall with:\n  sudo pacman -U %q\n' "$OUTPUT_DIR/petgpt-${VERSION}-1-${PACKAGE_ARCH}.pkg.tar.zst"
