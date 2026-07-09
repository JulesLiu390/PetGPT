"""Extract mouth-shape sprites from the existing green_cleaned presenter frames.

This does not call any image model. It cuts the original mouth style out of:
  images/green_cleaned/{closed,small,medium,large}.png

The extracted sprites are aligned to the rebuilt avatar mouth position and saved
under images/new_images/rebuilt/mouth_shapes/.

Usage:
  uv run python ai_daily_news/card_renderer/live2d_renderer/generate_mouth_shapes.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


MODULE_DIR = Path(__file__).resolve().parent
GREEN_DIR = MODULE_DIR / "images" / "green_cleaned"
REBUILT_DIR = MODULE_DIR / "images" / "new_images" / "rebuilt"
MANIFEST_PATH = REBUILT_DIR / "layer_manifest.json"
OUT_DIR = REBUILT_DIR / "mouth_shapes"

SHAPES = ["closed", "small", "medium", "large"]
SOURCE_BOX = (281, 246, 304, 264)
TARGET_SIZE = (20, 14)


def mouth_layer() -> dict:
    data = json.loads(MANIFEST_PATH.read_text())
    for layer in data["layers"]:
        if layer["name"] == "mouth":
            return layer
    raise RuntimeError("mouth layer not found")


def extract_shape(name: str) -> Image.Image:
    frame_path = GREEN_DIR / f"{name}.png"
    if not frame_path.exists():
        raise FileNotFoundError(frame_path)

    canvas = Image.new("RGBA", TARGET_SIZE, (0, 0, 0, 0))
    sprite = Image.open(frame_path).convert("RGBA").crop(SOURCE_BOX)
    max_w = TARGET_SIZE[0] * 0.96
    max_h = TARGET_SIZE[1] * 0.96
    scale = min(max_w / sprite.width, max_h / sprite.height)
    new_size = (
        max(1, round(sprite.width * scale)),
        max(1, round(sprite.height * scale)),
    )
    sprite = sprite.resize(new_size, Image.Resampling.LANCZOS)

    mask = Image.new("L", new_size, 0)
    draw = ImageDraw.Draw(mask)
    radius = max(3, round(min(new_size) * 0.28))
    draw.rounded_rectangle((1, 1, new_size[0] - 2, new_size[1] - 2), radius=radius, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.1))
    sprite.putalpha(mask)

    x = (TARGET_SIZE[0] - new_size[0]) // 2
    y = round((TARGET_SIZE[1] - new_size[1]) * 0.50)
    canvas.alpha_composite(sprite, (x, y))
    return canvas


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in SHAPES:
        extract_shape(name).save(OUT_DIR / f"{name}.png")

    layer = mouth_layer()
    mx, my = layer["origin"]
    mw, mh = layer["size"]
    center = (mx + mw / 2, my + mh / 2)
    origin = (
        round(center[0] - TARGET_SIZE[0] / 2),
        round(center[1] - TARGET_SIZE[1] / 2),
    )
    index = {
        "source": str(GREEN_DIR),
        "source_model": "green_cleaned original frames",
        "source_box": list(SOURCE_BOX),
        "origin": origin,
        "size": list(TARGET_SIZE),
        "anchor_source_mouth_origin": layer["origin"],
        "anchor_source_mouth_size": layer["size"],
        "shapes": SHAPES,
        "files": {name: f"{name}.png" for name in SHAPES},
    }
    (OUT_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
    print(f"mouth shapes: {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
