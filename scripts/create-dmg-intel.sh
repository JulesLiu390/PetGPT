#!/bin/bash

# PetGPT DMG Creation Script (Intel x86_64)
# This script creates a DMG installer from the built .app file for Intel Macs

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Creating PetGPT DMG (Intel x86_64)...${NC}"

# Configuration
APP_NAME="PetGPT"
VERSION="0.4.0"
APP_PATH="src-tauri/target/x86_64-apple-darwin/release/bundle/macos/${APP_NAME}.app"
DMG_NAME="${APP_NAME}_${VERSION}_x64.dmg"
OUTPUT_PATH="src-tauri/target/x86_64-apple-darwin/release/bundle/dmg"
STAGING_DIR="src-tauri/target/x86_64-apple-darwin/release/bundle/dmg-staging"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Check if .app exists
if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}❌ Error: ${APP_PATH} not found!${NC}"
    echo -e "${YELLOW}Please run 'npm run tauri:build -- --target x86_64-apple-darwin' first.${NC}"
    echo -e "${YELLOW}Or use: cargo tauri build --target x86_64-apple-darwin${NC}"
    exit 1
fi

# Check if create-dmg is installed
if ! command -v create-dmg &> /dev/null; then
    echo -e "${YELLOW}⚠️  create-dmg not found. Installing via Homebrew...${NC}"
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}❌ Error: Homebrew not installed!${NC}"
        echo -e "${YELLOW}Please install Homebrew first: https://brew.sh${NC}"
        exit 1
    fi
    brew install create-dmg
fi

# Create output directory
mkdir -p "$OUTPUT_PATH"

# Remove old DMG if exists
if [ -f "$OUTPUT_PATH/$DMG_NAME" ]; then
    echo -e "${YELLOW}🗑️  Removing old DMG...${NC}"
    rm "$OUTPUT_PATH/$DMG_NAME"
fi

# Create staging directory with all DMG contents
echo -e "${GREEN}📁 Preparing staging directory...${NC}"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Copy .app to staging
cp -R "$APP_PATH" "$STAGING_DIR/"

# Copy README
README_NAME="⚠️ Before You Run the App - READ THIS!!!!!!!!!!.rtf"
cp "$SCRIPT_DIR/dmg-readme.rtf" "$STAGING_DIR/$README_NAME"

echo -e "${GREEN}📦 Building DMG (Intel x86_64)...${NC}"

# Create DMG with beautification
# Window layout:
#   Top center: README (prominent)
#   Bottom: App (left), Applications link (right)
create-dmg \
  --volname "$APP_NAME" \
  --volicon "src-tauri/icons/icon.icns" \
  --window-pos 200 120 \
  --window-size 660 450 \
  --icon-size 80 \
  --text-size 14 \
  --icon "$README_NAME" 330 100 \
  --icon "${APP_NAME}.app" 180 300 \
  --hide-extension "${APP_NAME}.app" \
  --app-drop-link 480 300 \
  --no-internet-enable \
  "$OUTPUT_PATH/$DMG_NAME" \
  "$STAGING_DIR"

# Clean up staging directory
echo -e "${YELLOW}🧹 Cleaning up staging directory...${NC}"
rm -rf "$STAGING_DIR"

echo -e "${GREEN}✅ DMG (Intel x86_64) created successfully!${NC}"
echo -e "${GREEN}📍 Location: $OUTPUT_PATH/$DMG_NAME${NC}"

# Get file size
DMG_SIZE=$(du -h "$OUTPUT_PATH/$DMG_NAME" | cut -f1)
echo -e "${GREEN}📊 Size: $DMG_SIZE${NC}"

# Clean up temporary DMG files
echo -e "${YELLOW}🧹 Cleaning up temporary files...${NC}"
rm -f "$OUTPUT_PATH"/rw.*.dmg 2>/dev/null || true

# Open folder
echo -e "${GREEN}📂 Opening output folder...${NC}"
open "$OUTPUT_PATH"
