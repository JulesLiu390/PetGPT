# Live2D WebM Renderer

Browser tool for generating a transparent Live2D-style presenter overlay from an audio file.

## Run

From `ai_daily_news/card_renderer`:

```bash
npm run dev -- --port 57490
```

Open:

```text
http://127.0.0.1:57490/live2d_renderer/
```

Layered React/TypeScript prototype:

```text
http://127.0.0.1:57490/live2d_renderer/layered.html
```

This page reads:

```text
live2d_renderer/images/new_images/rebuilt/layer_manifest.json
```

and animates the rebuilt layer PNGs with lightweight CSS transforms.

Regenerate the local mouth sprites:

```bash
uv run python ai_daily_news/card_renderer/live2d_renderer/generate_mouth_shapes.py
```

## Inputs

- Audio file: drives mouth movement and recording duration.
- Live2D `model3.json` URL: optional. If omitted, the page uses a fallback presenter so the WebM export flow can be tested.
- Image presenter URL: optional pseudo-Live2D mode. Use a transparent PNG standing character to create a lightweight presenter layer.
- Mouth sequence directory: optional frame-switching mode. Provide four transparent PNG files named `closed.png`, `small.png`, `medium.png`, and `large.png`.

Current mouth sequence:

```text
/live2d_renderer/images/green_cleaned
```

This mode switches frames according to the TTS audio volume and is the recommended lightweight talking-presenter path.

The current sailor-girl prototype points to:

```text
/live2d/sailor-girl/preview.jpg
```

BOOTH requires login to download the full free zip. After downloading it manually, place a black-hair sailor-uniform transparent PNG under:

```text
public/live2d/sailor-girl/
```

Then use it as the Image presenter URL, for example:

```text
/live2d/sailor-girl/black_sailor_normal.png
```

For Cubism 4 models, place the Cubism runtime at:

```text
public/live2d/Core/live2dcubismcore.min.js
```

Then place character assets under:

```text
public/live2d/<character>/
```

Example model URL:

```text
/live2d/<character>/<model>.model3.json
```

## Output

The browser exports a transparent VP9 WebM. It can be overlaid onto the current topic video:

```bash
ffmpeg -i topic-1.mp4 -i topic-1_live2d.webm \
  -filter_complex "[0:v][1:v]overlay=40:H-h-70:format=auto" \
  -c:a copy topic-1_with_live2d.mp4
```
