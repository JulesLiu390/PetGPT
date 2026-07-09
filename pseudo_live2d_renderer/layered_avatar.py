"""Prototype utilities for See-through layered avatar outputs.

This module is intentionally separate from the current mouth-sequence renderer.
It reads the `new_images/composed_parts/*.png` files produced by See-through,
reconstructs the character by alpha-compositing the layers in filename order,
and writes a small manifest with bounding boxes and depth-map statistics.

Usage:
  uv run python ai_daily_news/card_renderer/live2d_renderer/layered_avatar.py
  uv run python ai_daily_news/card_renderer/live2d_renderer/layered_avatar.py \
    --src ai_daily_news/card_renderer/live2d_renderer/images/new_images \
    --out ai_daily_news/card_renderer/live2d_renderer/images/new_images/rebuilt
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageStat


MODULE_DIR = Path(__file__).resolve().parent
DEFAULT_SRC = MODULE_DIR / "images" / "new_images"
DEFAULT_OUT = DEFAULT_SRC / "rebuilt"


@dataclass
class LayerInfo:
    order: float
    name: str
    file: str
    crop_file: str | None
    depth_file: str | None
    bbox: tuple[int, int, int, int] | None
    origin: tuple[int, int] | None
    size: tuple[int, int] | None
    alpha_pixels: int
    depth_mean: float | None
    depth_min: int | None
    depth_max: int | None


def parse_layer_name(path: Path) -> tuple[int, str]:
    match = re.match(r"^(\d+)_(.+)\.png$", path.name)
    if not match:
        raise ValueError(f"composed part filename must be NN_name.png: {path.name}")
    return int(match.group(1)), match.group(2)


def depth_stem(layer_name: str) -> str:
    """Map composed layer names like `eyelash-r` to `eyelash_depth.png`."""
    return re.sub(r"-(?:l|r)$", "", layer_name)


def layer_order(order: int, name: str) -> float:
    # The semantic topwear layer contains the sailor collar and the upper chest.
    # Keep the real neck in front of topwear, but still behind the face/chin.
    if name == "neck":
        return 7.5
    return float(order)


def order_prefix(order: float) -> str:
    if order.is_integer():
        return f"{int(order):02d}"
    return f"{int(order):02d}_{int(round((order % 1) * 10))}"


def alpha_pixel_count(image: Image.Image) -> int:
    alpha = image.getchannel("A")
    hist = alpha.histogram()
    return sum(hist[1:])


def depth_stats(depth_path: Path, alpha_mask: Image.Image) -> tuple[float, int, int] | tuple[None, None, None]:
    if not depth_path.exists():
        return None, None, None
    depth = Image.open(depth_path).convert("L")
    if depth.size != alpha_mask.size:
        depth = depth.resize(alpha_mask.size, Image.Resampling.BILINEAR)
    binary_alpha = alpha_mask.point(lambda value: 255 if value > 0 else 0)
    stat = ImageStat.Stat(depth, mask=binary_alpha)
    if not stat.count or stat.count[0] == 0:
        return None, None, None
    extrema = stat.extrema[0]
    return float(stat.mean[0]), int(extrema[0]), int(extrema[1])


def load_layers(src_dir: Path) -> list[LayerInfo]:
    parts_dir = src_dir / "composed_parts"
    if not parts_dir.exists():
        raise FileNotFoundError(f"missing composed_parts directory: {parts_dir}")

    layers: list[LayerInfo] = []
    for path in sorted(parts_dir.glob("*.png")):
        order, name = parse_layer_name(path)
        image = Image.open(path).convert("RGBA")
        alpha = image.getchannel("A")
        depth_path = src_dir / f"{depth_stem(name)}_depth.png"
        mean, min_value, max_value = depth_stats(depth_path, alpha)
        order_value = layer_order(order, name)
        layers.append(
            LayerInfo(
                order=order_value,
                name=name,
                file=str(path.relative_to(src_dir)),
                crop_file=None,
                depth_file=str(depth_path.relative_to(src_dir)) if depth_path.exists() else None,
                bbox=image.getbbox(),
                origin=None,
                size=None,
                alpha_pixels=alpha_pixel_count(image),
                depth_mean=mean,
                depth_min=min_value,
                depth_max=max_value,
            )
        )
    return sorted(layers, key=lambda layer: layer.order)


def composite_layers(src_dir: Path, layers: list[LayerInfo], extras: list[LayerInfo] | None = None, out_dir: Path | None = None) -> Image.Image:
    first_path = src_dir / layers[0].file
    first = Image.open(first_path).convert("RGBA")
    canvas = Image.new("RGBA", first.size, (0, 0, 0, 0))
    all_layers = sorted([*layers, *(extras or [])], key=lambda layer: layer.order)
    for layer in all_layers:
        if layer.file.startswith("composed_parts/"):
            image_path = src_dir / layer.file
        else:
            if out_dir is None:
                raise ValueError("out_dir is required for generated layers")
            image_path = out_dir / layer.file
        image = Image.open(image_path).convert("RGBA")
        canvas.alpha_composite(image)
    return canvas


def crop_to_content(image: Image.Image, margin: int = 32) -> Image.Image:
    bbox = image.getbbox()
    if not bbox:
        return image.copy()
    left, top, right, bottom = bbox
    left = max(0, left - margin)
    top = max(0, top - margin)
    right = min(image.width, right + margin)
    bottom = min(image.height, bottom + margin)
    return image.crop((left, top, right, bottom))


def export_cropped_layers(src_dir: Path, out_dir: Path, layers: list[LayerInfo]) -> None:
    components_dir = out_dir / "components"
    components_dir.mkdir(parents=True, exist_ok=True)
    for layer in layers:
        image = Image.open(src_dir / layer.file).convert("RGBA")
        bbox = image.getbbox()
        if not bbox:
            layer.crop_file = None
            layer.origin = None
            layer.size = None
            continue
        left, top, right, bottom = bbox
        safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", layer.name).strip("_")
        crop_path = components_dir / f"{order_prefix(layer.order)}_{safe_name}.png"
        image.crop(bbox).save(crop_path)
        layer.crop_file = str(crop_path.relative_to(out_dir))
        layer.origin = (left, top)
        layer.size = (right - left, bottom - top)


def keep_largest_alpha_components(image: Image.Image, keep: int = 2, min_pixels: int = 80) -> Image.Image:
    alpha = image.getchannel("A")
    width, height = alpha.size
    alpha_pixels = alpha.load()
    visited = bytearray(width * height)
    components: list[list[tuple[int, int]]] = []

    for y in range(height):
        for x in range(width):
            idx = y * width + x
            if visited[idx] or alpha_pixels[x, y] == 0:
                continue
            stack = [(x, y)]
            visited[idx] = 1
            component: list[tuple[int, int]] = []
            while stack:
                cx, cy = stack.pop()
                component.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    nidx = ny * width + nx
                    if visited[nidx] or alpha_pixels[nx, ny] == 0:
                        continue
                    visited[nidx] = 1
                    stack.append((nx, ny))
            if len(component) >= min_pixels:
                components.append(component)

    kept = sorted(components, key=len, reverse=True)[:keep]
    cleaned_alpha = Image.new("L", (width, height), 0)
    cleaned_pixels = cleaned_alpha.load()
    for component in kept:
        for x, y in component:
            cleaned_pixels[x, y] = alpha_pixels[x, y]

    cleaned = image.copy()
    cleaned.putalpha(cleaned_alpha)
    return cleaned


def is_green_background(r: int, g: int, b: int) -> bool:
    return g > 110 and g > r * 1.35 and g > b * 1.35


def is_skin_pixel(r: int, g: int, b: int) -> bool:
    return (
        r > 145
        and g > 115
        and b > 105
        and r > g * 1.04
        and r > b * 1.05
        and abs(r - g) < 95
    )


def is_sleeve_pixel(r: int, g: int, b: int) -> bool:
    greenish_edge = g > r * 1.35 and g > b * 1.08
    dark_cloth = r < 95 and g < 95 and b < 105 and not greenish_edge
    sailor_stripe = r > 175 and g > 175 and b > 170
    return dark_cloth or sailor_stripe


def make_masked_image(source: Image.Image, mask: Image.Image) -> Image.Image:
    image = source.copy()
    image.putalpha(mask)
    return image


def write_generated_layer(
    image: Image.Image,
    out_dir: Path,
    filename: str,
    order: float,
    name: str,
    min_pixels: int = 1,
) -> LayerInfo | None:
    if alpha_pixel_count(image) < min_pixels or not image.getbbox():
        return None
    generated_dir = out_dir / "generated"
    generated_dir.mkdir(parents=True, exist_ok=True)
    full_path = generated_dir / filename
    image.save(full_path)
    bbox = image.getbbox()
    assert bbox is not None
    crop_path = generated_dir / filename.replace(".png", "_cropped.png")
    image.crop(bbox).save(crop_path)
    return LayerInfo(
        order=order,
        name=name,
        file=str(full_path.relative_to(out_dir)),
        crop_file=str(crop_path.relative_to(out_dir)),
        depth_file=None,
        bbox=bbox,
        origin=(bbox[0], bbox[1]),
        size=(bbox[2] - bbox[0], bbox[3] - bbox[1]),
        alpha_pixels=alpha_pixel_count(image),
        depth_mean=None,
        depth_min=None,
        depth_max=None,
    )


def export_object_depth_layers(src_dir: Path, out_dir: Path) -> list[LayerInfo]:
    object_path = src_dir / "composed_parts" / "15_objects.png"
    depth_path = src_dir / "objects_depth.png"
    if not object_path.exists() or not depth_path.exists():
        return []

    source = Image.open(object_path).convert("RGBA")
    alpha = source.getchannel("A")
    depth = Image.open(depth_path).convert("L")
    back_mask = Image.new("L", source.size, 0)
    front_mask = Image.new("L", source.size, 0)
    alpha_pixels = alpha.load()
    depth_pixels = depth.load()
    back_pixels = back_mask.load()
    front_pixels = front_mask.load()

    # On this See-through output, darker object depth corresponds to the toy
    # parts that should remain visually in front of the sleeves.
    for y in range(source.height):
        for x in range(source.width):
            a = alpha_pixels[x, y]
            if a == 0:
                continue
            if depth_pixels[x, y] <= 100:
                front_pixels[x, y] = a
            else:
                back_pixels[x, y] = a

    back = make_masked_image(source, back_mask)
    front = make_masked_image(source, front_mask)
    layers = [
        write_generated_layer(back, out_dir, "14_2_object_back.png", 14.2, "object-back", min_pixels=50),
        write_generated_layer(front, out_dir, "15_0_object_front.png", 15.0, "object-front", min_pixels=50),
    ]
    return [layer for layer in layers if layer is not None]


def export_neck_fallback_layer(src_dir: Path, out_dir: Path) -> LayerInfo | None:
    src_path = src_dir / "src_img.png"
    if not src_path.exists():
        return None
    src = Image.open(src_path).convert("RGBA")
    mask = Image.new("L", src.size, 0)
    draw = ImageDraw.Draw(mask)
    # A small bridge from chin to collar; it replaces the hard semantic cut
    # produced by the extracted neck part while keeping collar/hair untouched.
    draw.polygon([(612, 292), (690, 288), (694, 355), (628, 363), (605, 328)], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))

    fallback = Image.new("RGBA", src.size, (0, 0, 0, 0))
    src_pixels = src.load()
    mask_pixels = mask.load()
    out_pixels = fallback.load()
    for y in range(src.height):
        for x in range(src.width):
            m = mask_pixels[x, y]
            if m == 0:
                continue
            r, g, b, a = src_pixels[x, y]
            if a == 0 or is_green_background(r, g, b):
                continue
            # Keep only skin-like pixels so the collar and hair remain from the
            # proper layers.
            if not is_skin_pixel(r, g, b):
                continue
            out_pixels[x, y] = (r, g, b, min(a, m))

    return write_generated_layer(fallback, out_dir, "08_5_neck_fallback.png", 8.5, "neck-fallback", min_pixels=50)


def export_thigh_fallback_layer(src_dir: Path, out_dir: Path) -> LayerInfo | None:
    src_path = src_dir / "src_img.png"
    if not src_path.exists():
        return None
    src = Image.open(src_path).convert("RGBA")
    fallback = Image.new("RGBA", src.size, (0, 0, 0, 0))
    src_pixels = src.load()
    out_pixels = fallback.load()

    # The semantic leg layer flattens the thigh edge under the skirt. Recover
    # only the visible skin strip from the original image; the skirt and socks
    # remain controlled by their own layers.
    for y in range(724, 842):
        for x in range(520, 782):
            r, g, b, a = src_pixels[x, y]
            if a == 0 or is_green_background(r, g, b):
                continue
            if not is_skin_pixel(r, g, b):
                continue
            out_pixels[x, y] = (r, g, b, a)

    fallback = keep_largest_alpha_components(fallback, keep=2, min_pixels=200)
    if not fallback.getbbox():
        return None
    alpha = fallback.getchannel("A").filter(ImageFilter.GaussianBlur(0.35))
    fallback.putalpha(alpha)
    return write_generated_layer(fallback, out_dir, "05_5_thigh_fallback.png", 5.5, "thigh-fallback", min_pixels=100)


def export_sleeves_fallback_layer(src_dir: Path, out_dir: Path) -> LayerInfo | None:
    src_path = src_dir / "handwear.png"
    depth_path = src_dir / "handwear_depth.png"
    if not src_path.exists() or not depth_path.exists():
        return None

    src = Image.open(src_path).convert("RGBA")
    depth = Image.open(depth_path).convert("L")

    fallback = Image.new("RGBA", src.size, (0, 0, 0, 0))
    src_pixels = src.load()
    depth_pixels = depth.load()
    out_pixels = fallback.load()
    for y in range(src.height):
        for x in range(src.width):
            if depth_pixels[x, y] > 245:
                continue
            r, g, b, a = src_pixels[x, y]
            if a == 0 or is_skin_pixel(r, g, b):
                continue
            if not is_sleeve_pixel(r, g, b):
                continue
            out_pixels[x, y] = (r, g, b, a)

    if not fallback.getbbox():
        return None
    alpha = fallback.getchannel("A").filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.35))
    fallback.putalpha(alpha)

    return write_generated_layer(fallback, out_dir, "14_4_sleeves_fallback.png", 14.4, "sleeves-fallback")


def export_hands_fallback_layer(src_dir: Path, out_dir: Path) -> LayerInfo | None:
    """Recover visible hands that See-through often misses on this asset.

    The source image still contains the hands. We extract only skin-colored
    pixels from the torso/arms area and place that patch between the clothing
    layers and the held object. This is intentionally conservative: it is a
    visual completion layer, not a semantic hand segmentation model.
    """

    src_path = src_dir / "handwear.png"
    depth_path = src_dir / "handwear_depth.png"
    if not src_path.exists() or not depth_path.exists():
        return None

    src = Image.open(src_path).convert("RGBA")
    depth = Image.open(depth_path).convert("L")

    fallback = Image.new("RGBA", src.size, (0, 0, 0, 0))
    src_pixels = src.load()
    out_pixels = fallback.load()
    depth_pixels = depth.load()

    for y in range(src.height):
        for x in range(src.width):
            if depth_pixels[x, y] > 245:
                continue
            r, g, b, a = src_pixels[x, y]
            if a == 0 or not is_skin_pixel(r, g, b):
                continue
            out_pixels[x, y] = (r, g, b, a)

    alpha = fallback.getchannel("A")
    if not fallback.getbbox():
        return None

    # Slightly soften and reconnect antialiased edges without growing into the object.
    fallback = keep_largest_alpha_components(fallback, keep=2, min_pixels=120)
    alpha = fallback.getchannel("A")
    alpha = alpha.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(0.45))
    fallback.putalpha(alpha)

    return write_generated_layer(fallback, out_dir, "15_5_hands_fallback.png", 15.5, "hands-fallback")


def rebuild(src_dir: Path, out_dir: Path) -> dict:
    layers = load_layers(src_dir)
    if not layers:
        raise RuntimeError(f"no composed layers found under {src_dir / 'composed_parts'}")
    out_dir.mkdir(parents=True, exist_ok=True)

    export_cropped_layers(src_dir, out_dir, layers)
    extras = [
        layer
        for layer in [
            export_thigh_fallback_layer(src_dir, out_dir),
            export_sleeves_fallback_layer(src_dir, out_dir),
            export_hands_fallback_layer(src_dir, out_dir),
        ]
        if layer is not None
    ]
    base_layers = [layer for layer in layers if layer.name != "objects"]
    extras = [
        *export_object_depth_layers(src_dir, out_dir),
        *extras,
    ]
    composite = composite_layers(src_dir, base_layers, extras=extras, out_dir=out_dir)
    full_path = out_dir / "reconstruction_from_layers.png"
    cropped_path = out_dir / "reconstruction_from_layers_cropped.png"
    manifest_path = out_dir / "layer_manifest.json"

    composite.save(full_path)
    crop_to_content(composite).save(cropped_path)

    manifest = {
        "source": str(src_dir),
        "canvas_size": [composite.width, composite.height],
        "output_full": str(full_path),
        "output_cropped": str(cropped_path),
        "layers": [asdict(layer) for layer in layers],
        "generated_layers": [asdict(layer) for layer in extras],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rebuild See-through composed layers and write a manifest.")
    parser.add_argument("--src", default=str(DEFAULT_SRC), help="See-through new_images directory")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = rebuild(Path(args.src), Path(args.out))
    print(f"layers: {len(manifest['layers'])}")
    print(f"full: {manifest['output_full']}")
    print(f"cropped: {manifest['output_cropped']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
