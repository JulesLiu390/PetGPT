#!/bin/bash

# PetGPT - 统一图标生成脚本
# 从 design/icons/ 目录读取原始文件，生成所有需要的图标

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

clear
echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  PetGPT 图标生成器                    ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
echo ""

# Paths
SOURCE_DIR="design/icons"
OUTPUT_DIR="src-tauri/icons"
APP_ICON_SOURCE="$SOURCE_DIR/app-icon.png"
TRAY_ICON_SOURCE="$SOURCE_DIR/tray-icon.png"

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}❌ Error: Source directory not found: $SOURCE_DIR${NC}"
    echo -e "${YELLOW}Please create it first: mkdir -p $SOURCE_DIR${NC}"
    exit 1
fi

# Check if source files exist
MISSING_FILES=0

echo -e "${BLUE}📋 检查源文件...${NC}"
echo ""

if [ ! -f "$APP_ICON_SOURCE" ]; then
    echo -e "${RED}❌ 缺少: $APP_ICON_SOURCE${NC}"
    echo -e "${YELLOW}   用途: 应用程序图标（至少 1024x1024）${NC}"
    MISSING_FILES=1
else
    # Get dimensions
    APP_INFO=$(sips -g pixelWidth -g pixelHeight "$APP_ICON_SOURCE" 2>/dev/null)
    APP_WIDTH=$(echo "$APP_INFO" | grep "pixelWidth" | awk '{print $2}')
    APP_HEIGHT=$(echo "$APP_INFO" | grep "pixelHeight" | awk '{print $2}')
    echo -e "${GREEN}✓ app-icon.png${NC} (${APP_WIDTH}x${APP_HEIGHT})"
    
    if [ "$APP_WIDTH" -lt 1024 ] || [ "$APP_HEIGHT" -lt 1024 ]; then
        echo -e "${YELLOW}  ⚠️  建议使用至少 1024x1024 的图片${NC}"
    fi
fi

if [ ! -f "$TRAY_ICON_SOURCE" ]; then
    echo -e "${RED}❌ 缺少: $TRAY_ICON_SOURCE${NC}"
    echo -e "${YELLOW}   用途: 托盘图标（至少 128x128，简化设计）${NC}"
    MISSING_FILES=1
else
    # Get dimensions
    TRAY_INFO=$(sips -g pixelWidth -g pixelHeight "$TRAY_ICON_SOURCE" 2>/dev/null)
    TRAY_WIDTH=$(echo "$TRAY_INFO" | grep "pixelWidth" | awk '{print $2}')
    TRAY_HEIGHT=$(echo "$TRAY_INFO" | grep "pixelHeight" | awk '{print $2}')
    echo -e "${GREEN}✓ tray-icon.png${NC} (${TRAY_WIDTH}x${TRAY_HEIGHT})"
    
    if [ "$TRAY_WIDTH" -lt 128 ] || [ "$TRAY_HEIGHT" -lt 128 ]; then
        echo -e "${YELLOW}  ⚠️  建议使用至少 128x128 的图片${NC}"
    fi
fi

echo ""

if [ $MISSING_FILES -eq 1 ]; then
    echo -e "${RED}请先将图标文件放到 $SOURCE_DIR/ 目录${NC}"
    echo ""
    echo -e "${YELLOW}需要的文件:${NC}"
    echo "  • app-icon.png  (1024x1024+, 应用图标)"
    echo "  • tray-icon.png (128x128+, 托盘图标，简化设计)"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}开始生成图标...${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""

# ============================================
# 1. Generate App Icons
# ============================================
echo -e "${CYAN}[1/2] 生成应用图标...${NC}"
echo ""

# Standard PNG sizes
echo -e "${BLUE}  → 生成标准 PNG 尺寸...${NC}"
sips -z 32 32 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/32x32.png" > /dev/null 2>&1
echo -e "     ✓ 32x32.png"

sips -z 128 128 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/128x128.png" > /dev/null 2>&1
echo -e "     ✓ 128x128.png"

sips -z 256 256 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/128x128@2x.png" > /dev/null 2>&1
echo -e "     ✓ 128x128@2x.png"

sips -z 512 512 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/icon.png" > /dev/null 2>&1
echo -e "     ✓ icon.png"

# Windows Store icons
echo ""
echo -e "${BLUE}  → 生成 Windows Store 图标...${NC}"
sips -z 30 30 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square30x30Logo.png" > /dev/null 2>&1
sips -z 44 44 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square44x44Logo.png" > /dev/null 2>&1
sips -z 71 71 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square71x71Logo.png" > /dev/null 2>&1
sips -z 89 89 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square89x89Logo.png" > /dev/null 2>&1
sips -z 107 107 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square107x107Logo.png" > /dev/null 2>&1
sips -z 142 142 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square142x142Logo.png" > /dev/null 2>&1
sips -z 150 150 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square150x150Logo.png" > /dev/null 2>&1
sips -z 284 284 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square284x284Logo.png" > /dev/null 2>&1
sips -z 310 310 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/Square310x310Logo.png" > /dev/null 2>&1
sips -z 50 50 "$APP_ICON_SOURCE" --out "$OUTPUT_DIR/StoreLogo.png" > /dev/null 2>&1
echo -e "     ✓ Square* 和 StoreLogo (Windows Store)"

# macOS .icns
echo ""
echo -e "${BLUE}  → 生成 macOS .icns 文件...${NC}"

ICONSET_DIR="$OUTPUT_DIR/icon.iconset"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

sips -z 16 16     "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16.png" > /dev/null 2>&1
sips -z 32 32     "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_16x16@2x.png" > /dev/null 2>&1
sips -z 32 32     "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32.png" > /dev/null 2>&1
sips -z 64 64     "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_32x32@2x.png" > /dev/null 2>&1
sips -z 128 128   "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128.png" > /dev/null 2>&1
sips -z 256 256   "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_128x128@2x.png" > /dev/null 2>&1
sips -z 256 256   "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256.png" > /dev/null 2>&1
sips -z 512 512   "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_256x256@2x.png" > /dev/null 2>&1
sips -z 512 512   "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512.png" > /dev/null 2>&1
sips -z 1024 1024 "$APP_ICON_SOURCE" --out "$ICONSET_DIR/icon_512x512@2x.png" > /dev/null 2>&1

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_DIR/icon.icns" 2>/dev/null
rm -rf "$ICONSET_DIR"
echo -e "     ✓ icon.icns (包含所有尺寸)"

# Windows .ico (optional)
if command -v convert &> /dev/null; then
    echo ""
    echo -e "${BLUE}  → 生成 Windows .ico 文件...${NC}"
    convert "$APP_ICON_SOURCE" -define icon:auto-resize=256,128,64,48,32,16 "$OUTPUT_DIR/icon.ico" 2>/dev/null
    echo -e "     ✓ icon.ico"
fi

# ============================================
# 2. Generate Tray Icons
# ============================================
echo ""
echo -e "${CYAN}[2/2] 生成托盘图标...${NC}"
echo ""

echo -e "${BLUE}  → 生成托盘图标尺寸...${NC}"
sips -z 44 44 "$TRAY_ICON_SOURCE" --out "$OUTPUT_DIR/tray-icon.png" > /dev/null 2>&1
echo -e "     ✓ tray-icon.png (44x44)"

sips -z 88 88 "$TRAY_ICON_SOURCE" --out "$OUTPUT_DIR/tray-icon@2x.png" > /dev/null 2>&1
echo -e "     ✓ tray-icon@2x.png (88x88)"

# ============================================
# Summary
# ============================================
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ 所有图标生成完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""

echo -e "${CYAN}📁 输出位置:${NC} $OUTPUT_DIR"
echo ""
echo -e "${CYAN}生成的文件:${NC}"
echo "  应用图标:"
echo "    • icon.icns (macOS)"
echo "    • icon.ico (Windows)"
echo "    • 32x32.png, 128x128.png, 128x128@2x.png, icon.png"
echo "    • Square* (Windows Store)"
echo ""
echo "  托盘图标:"
echo "    • tray-icon.png (44x44)"
echo "    • tray-icon@2x.png (88x88)"
echo ""

echo -e "${YELLOW}📝 下一步:${NC}"
echo "  1. 检查生成的图标: open $OUTPUT_DIR"
echo "  2. 重新构建应用: npm run tauri:build"
echo ""
