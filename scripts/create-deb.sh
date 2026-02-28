#!/bin/bash

# PetGPT .deb Package Creation Script
# This script builds the Tauri app for Linux and creates a .deb installer.
#
# Prerequisites (Ubuntu/Debian):
#   sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
#
# Usage:
#   ./scripts/create-deb.sh
#
# Build the app first with:
#   npm run build && cd src-tauri && cargo build --release

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Creating PetGPT .deb package...${NC}"

# Configuration
APP_NAME="petgpt"
APP_DISPLAY_NAME="PetGPT"
VERSION="0.4.3"
ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")
DESCRIPTION="PetGPT - AI Desktop Pet Assistant"
MAINTAINER="PetGPT Team"
HOMEPAGE="https://github.com/nicekid1/PetGPT"
CATEGORY="Utility"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
BUILD_DIR="$PROJECT_DIR/src-tauri/target/release"
BUNDLE_DIR="$BUILD_DIR/bundle/deb"
DEB_STAGING="$BUILD_DIR/deb-staging"
DEB_NAME="${APP_NAME}_${VERSION}_${ARCH}.deb"

# ============ Dependency Check ============

check_linux() {
    if [[ "$(uname)" != "Linux" ]]; then
        echo -e "${RED}❌ Error: This script must be run on Linux.${NC}"
        echo -e "${YELLOW}For macOS, use create-dmg.sh instead.${NC}"
        exit 1
    fi
}

check_dependencies() {
    echo -e "${BLUE}🔍 Checking build dependencies...${NC}"
    local missing=()

    # Check for essential build tools
    for cmd in dpkg-deb cargo node npm; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done

    # Check for Tauri Linux build dependencies (libraries)
    local libs=(
        "libwebkit2gtk-4.1-dev"
        "librsvg2-dev"
    )
    for lib in "${libs[@]}"; do
        if ! dpkg -s "$lib" &>/dev/null 2>&1; then
            missing+=("$lib")
        fi
    done

    # Check for appindicator (either ayatana or legacy)
    if ! dpkg -s "libayatana-appindicator3-dev" &>/dev/null 2>&1 && \
       ! dpkg -s "libappindicator3-dev" &>/dev/null 2>&1; then
        missing+=("libayatana-appindicator3-dev")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        echo -e "${RED}❌ Missing dependencies: ${missing[*]}${NC}"
        echo -e "${YELLOW}Install them with:${NC}"
        echo -e "${YELLOW}  sudo apt install ${missing[*]}${NC}"
        exit 1
    fi

    echo -e "${GREEN}✅ All dependencies found.${NC}"
}

# ============ Create .deb ============

create_deb() {
    local BINARY_PATH="$BUILD_DIR/${APP_NAME}"

    # Check Tauri's own .deb output first
    if ls "$BUNDLE_DIR"/*.deb 1>/dev/null 2>&1; then
        echo -e "${GREEN}📦 Tauri already generated a .deb bundle:${NC}"
        ls -lh "$BUNDLE_DIR"/*.deb
        echo -e "${YELLOW}If you want to use Tauri's bundler instead, run:${NC}"
        echo -e "${YELLOW}  npx tauri build --bundles deb${NC}"
        echo ""
    fi

    # Check if binary exists
    if [ ! -f "$BINARY_PATH" ]; then
        echo -e "${RED}❌ Error: Binary not found at ${BINARY_PATH}${NC}"
        echo -e "${YELLOW}Please build first with:${NC}"
        echo -e "${YELLOW}  npm run build && cd src-tauri && cargo build --release${NC}"
        exit 1
    fi

    echo -e "${GREEN}📦 Creating .deb package manually...${NC}"

    # Clean staging
    rm -rf "$DEB_STAGING"

    # Create directory structure
    mkdir -p "$DEB_STAGING/DEBIAN"
    mkdir -p "$DEB_STAGING/usr/bin"
    mkdir -p "$DEB_STAGING/usr/share/applications"
    mkdir -p "$DEB_STAGING/usr/share/icons/hicolor/32x32/apps"
    mkdir -p "$DEB_STAGING/usr/share/icons/hicolor/128x128/apps"
    mkdir -p "$DEB_STAGING/usr/share/icons/hicolor/256x256/apps"
    mkdir -p "$DEB_STAGING/usr/share/${APP_NAME}/assets"

    # Copy binary
    cp "$BINARY_PATH" "$DEB_STAGING/usr/bin/${APP_NAME}"
    chmod 755 "$DEB_STAGING/usr/bin/${APP_NAME}"
    
    # Strip debug symbols to reduce size
    strip "$DEB_STAGING/usr/bin/${APP_NAME}" 2>/dev/null || true

    # Copy assets if they exist
    if [ -d "$PROJECT_DIR/src-tauri/assets" ]; then
        cp -r "$PROJECT_DIR/src-tauri/assets/"* "$DEB_STAGING/usr/share/${APP_NAME}/assets/" 2>/dev/null || true
    fi

    # Copy icons
    if [ -f "$PROJECT_DIR/src-tauri/icons/32x32.png" ]; then
        cp "$PROJECT_DIR/src-tauri/icons/32x32.png" "$DEB_STAGING/usr/share/icons/hicolor/32x32/apps/${APP_NAME}.png"
    fi
    if [ -f "$PROJECT_DIR/src-tauri/icons/128x128.png" ]; then
        cp "$PROJECT_DIR/src-tauri/icons/128x128.png" "$DEB_STAGING/usr/share/icons/hicolor/128x128/apps/${APP_NAME}.png"
    fi
    if [ -f "$PROJECT_DIR/src-tauri/icons/128x128@2x.png" ]; then
        cp "$PROJECT_DIR/src-tauri/icons/128x128@2x.png" "$DEB_STAGING/usr/share/icons/hicolor/256x256/apps/${APP_NAME}.png"
    fi

    # Create .desktop file
    cat > "$DEB_STAGING/usr/share/applications/${APP_NAME}.desktop" << EOF
[Desktop Entry]
Name=${APP_DISPLAY_NAME}
Comment=${DESCRIPTION}
Exec=${APP_NAME}
Icon=${APP_NAME}
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=${APP_NAME}
MimeType=
EOF

    # Calculate installed size (in KB)
    INSTALLED_SIZE=$(du -sk "$DEB_STAGING" | cut -f1)

    # Create DEBIAN/control
    cat > "$DEB_STAGING/DEBIAN/control" << EOF
Package: ${APP_NAME}
Version: ${VERSION}
Section: ${CATEGORY}
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Maintainer: ${MAINTAINER}
Homepage: ${HOMEPAGE}
Description: ${DESCRIPTION}
 PetGPT is an AI-powered desktop pet assistant with multi-model LLM support,
 MCP tool integration, and a cute character that lives on your desktop.
 Features include multi-tab chat, screenshot analysis, mood detection,
 and workspace-based personality/memory system.
Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1 | libappindicator3-1
EOF

    # Create post-install script (update icon cache & desktop database)
    cat > "$DEB_STAGING/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
fi
EOF
    chmod 755 "$DEB_STAGING/DEBIAN/postinst"

    # Create post-remove script
    cat > "$DEB_STAGING/DEBIAN/postrm" << 'EOF'
#!/bin/bash
set -e
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true
fi
EOF
    chmod 755 "$DEB_STAGING/DEBIAN/postrm"

    # Build the .deb
    mkdir -p "$BUNDLE_DIR"
    dpkg-deb --build --root-owner-group "$DEB_STAGING" "$BUNDLE_DIR/$DEB_NAME"

    # Clean up staging
    rm -rf "$DEB_STAGING"

    echo ""
    echo -e "${GREEN}✅ .deb package created successfully!${NC}"
    echo -e "${GREEN}📍 Location: ${BUNDLE_DIR}/${DEB_NAME}${NC}"
    echo ""

    # Show package info
    echo -e "${BLUE}📋 Package info:${NC}"
    dpkg-deb --info "$BUNDLE_DIR/$DEB_NAME"
    echo ""
    echo -e "${BLUE}📂 Package contents:${NC}"
    dpkg-deb --contents "$BUNDLE_DIR/$DEB_NAME" | head -20

    echo ""
    echo -e "${GREEN}🎉 Done! Install with:${NC}"
    echo -e "${YELLOW}  sudo dpkg -i ${BUNDLE_DIR}/${DEB_NAME}${NC}"
    echo -e "${YELLOW}  sudo apt-get install -f  # fix dependencies if needed${NC}"
}

# ============ Main ============

check_linux
check_dependencies
create_deb
