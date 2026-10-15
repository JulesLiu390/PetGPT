import React, { useEffect, useMemo, useRef, useState } from 'react';
import manifestData from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/layer_manifest.json';
import mouthShapesData from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/index.json';
import mouthClosedUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/closed.png?url';
import mouthSmallUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/small.png?url';
import mouthMediumUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/medium.png?url';
import mouthLargeUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/large.png?url';
import './PseudoLive2DCharacter.css';
import { blinkScaleAt, mouthFrameAt, repairGeneratedEdgeColors } from './avatarRendering.js';

const componentAssets = import.meta.glob(
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/components/*.png',
  { eager: true, query: '?url', import: 'default' }
);
const generatedAssets = import.meta.glob(
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/generated/*_cropped.png',
  { eager: true, query: '?url', import: 'default' }
);
const mouthAssets = {
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/closed.png': mouthClosedUrl,
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/small.png': mouthSmallUrl,
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/medium.png': mouthMediumUrl,
  '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/large.png': mouthLargeUrl,
};
const assetModules = { ...componentAssets, ...generatedAssets, ...mouthAssets };

const ASSET_PREFIX = '../../../pseudo_live2d_renderer/images/new_images/rebuilt/';
const FIT_SCALE = 0.96;
const VERTICAL_NUDGE = 0.015;

function assetUrl(relativePath) {
  const key = `${ASSET_PREFIX}${relativePath}`;
  return assetModules[key] || '';
}

function isBlinkLayer(name) {
  return name.includes('eyelash') || name.includes('eyewhite') || name.includes('irides');
}

function sanitizeMood(mood) {
  return String(mood || 'normal').replace(/[^a-zA-Z0-9-]/g, '');
}

// Decode and repair the three legacy fallback patches once per WebView.
const repairedSprites = new Map();
function repairedSpriteUrl(src) {
  if (!repairedSprites.has(src)) {
    const promise = (async () => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas 2D is unavailable');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      repairGeneratedEdgeColors(pixels.data, canvas.width, canvas.height);
      context.putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png');
    })().catch((error) => {
      repairedSprites.delete(src);
      throw error;
    });
    repairedSprites.set(src, promise);
  }
  return repairedSprites.get(src);
}

function useSpriteUrl(src, repair) {
  const [prepared, setPrepared] = useState(null);
  useEffect(() => {
    if (!repair || !src) return undefined;
    let cancelled = false;
    repairedSpriteUrl(src).then((url) => {
      if (!cancelled) setPrepared({ src, url });
    }).catch((error) => {
      console.warn('[Avatar] Could not repair fallback edges:', error);
      if (!cancelled) setPrepared({ src, url: src });
    });
    return () => { cancelled = true; };
  }, [src, repair]);
  return repair ? (prepared?.src === src ? prepared.url : '') : src;
}

/** Animate only the eye transform and discrete mouth frame, outside React. */
function useDetailAnimation(ref, mood, animated) {
  const startedAt = useRef(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const mouthFrames = [...element.querySelectorAll('.pl2d-mouth-frame')];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let rafId = null;
    let lastBlink = null;
    let lastMouth = null;

    const paint = (seconds, moving) => {
      const blink = moving ? blinkScaleAt(seconds) : 1;
      if (blink !== lastBlink) {
        element.style.setProperty('--blink-scale', String(blink));
        element.style.setProperty('--blink-shift', `${(1 - blink) * 1.5}px`);
        lastBlink = blink;
      }
      const frame = mouthFrameAt(mood, moving ? seconds : 0, mouthFrames.length);
      if (frame !== lastMouth) {
        mouthFrames.forEach((image, index) => {
          image.style.visibility = index === frame ? 'visible' : 'hidden';
        });
        lastMouth = frame;
      }
    };
    const tick = (now) => {
      startedAt.current ??= now;
      paint((now - startedAt.current) / 1000, true);
      rafId = requestAnimationFrame(tick);
    };
    const resume = () => {
      cancelAnimationFrame(rafId);
      rafId = null;
      const moving = animated && !reducedMotion.matches;
      element.classList.toggle('pl2d-paused', !moving || document.hidden);
      paint(0, false);
      if (moving && !document.hidden) rafId = requestAnimationFrame(tick);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    reducedMotion.addEventListener('change', resume);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', resume);
      reducedMotion.removeEventListener('change', resume);
    };
  }, [ref, mood, animated]);
}

function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize((previous) => previous.width === rect.width && previous.height === rect.height
        ? previous : { width: rect.width, height: rect.height });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

function visibleLayer(layer) {
  return layer.crop_file && layer.alpha_pixels > 4 && layer.name !== 'objects' && layer.name !== 'mouth';
}

function layerBounds(layers) {
  if (!layers.length) {
    return { minX: 0, minY: 0, width: 1280, height: 1280 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const layer of layers) {
    const [x, y] = layer.origin;
    const [w, h] = layer.size;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** Scale and offset that fit the layers' bounds into a `width` × `height` box. */
function fitPlacement(bounds, width, height) {
  const scale = Math.min(width / bounds.width, height / bounds.height) * FIT_SCALE;
  return {
    scale,
    x: (width - bounds.width * scale) / 2 - bounds.minX * scale,
    y: (height - bounds.height * scale) / 2 - bounds.minY * scale + height * VERTICAL_NUDGE,
  };
}

function LayerSprite({ layer }) {
  const [x, y] = layer.origin;
  const [w, h] = layer.size;
  const src = useSpriteUrl(assetUrl(layer.crop_file),
    ['thigh-fallback', 'sleeves-fallback', 'hands-fallback'].includes(layer.name));

  if (!src) return null;

  return (
    <div
      className="pl2d-layer"
      style={{
        '--x': `${x}px`,
        '--y': `${y}px`,
        '--w': `${w}px`,
        '--h': `${h}px`,
        zIndex: Math.round(layer.order * 10),
      }}
      data-layer={layer.name}
    >
      <img
        className={`pl2d-layer-image ${isBlinkLayer(layer.name) ? 'pl2d-detail-eye' : ''}`}
        src={src}
        alt=""
        draggable={false}
      />
    </div>
  );
}

function MouthSequence({ layer, shapes }) {
  const [x, y] = shapes?.origin ?? layer.origin;
  const [w, h] = shapes?.size ?? layer.size;
  const names = shapes?.shapes?.length ? shapes.shapes : ['closed', 'small', 'medium', 'large'];

  return (
    <div
      className="pl2d-layer pl2d-mouth-sequence"
      style={{
        '--x': `${x}px`,
        '--y': `${y}px`,
        '--w': `${w}px`,
        '--h': `${h}px`,
        zIndex: Math.round((layer.order + 0.1) * 10),
      }}
      data-layer="mouth-sequence"
    >
      {names.map((name, index) => {
        const file = shapes?.files?.[name] ?? `${name}.png`;
        const src = assetUrl(`mouth_shapes/${file}`);
        if (!src) return null;
        return (
          <img
            key={name}
            className="pl2d-layer-image pl2d-mouth-frame"
            src={src}
            alt=""
            draggable={false}
            style={{ visibility: index === 0 ? 'visible' : 'hidden' }}
          />
        );
      })}
    </div>
  );
}

export default function PseudoLive2DCharacter({ mood = 'normal', animated = true, onHitShape }) {
  const [containerRef, size] = useElementSize();
  const safeMood = sanitizeMood(mood);
  useDetailAnimation(containerRef, safeMood, animated);

  const layers = useMemo(() => {
    return [...(manifestData.layers ?? []), ...(manifestData.generated_layers ?? [])]
      .filter(visibleLayer)
      .sort((a, b) => a.order - b.order);
  }, []);

  const mouthLayer = useMemo(() => {
    return manifestData.layers.find((layer) => layer.name === 'mouth') ?? null;
  }, []);

  const placement = useMemo(() => {
    const canvasSize = manifestData.canvas_size?.[0] ?? 1280;
    if (!size.width || !size.height) {
      return { canvasSize, scale: 0.5, offsetX: 0, offsetY: 0 };
    }

    const { scale, x, y } = fitPlacement(layerBounds(layers), size.width, size.height);
    return { canvasSize, scale, offsetX: x, offsetY: y };
  }, [layers, size.height, size.width]);

  // The mouth sits inside the face, so the layers alone give the outline.
  useEffect(() => {
    if (!onHitShape) return undefined;
    const bounds = layerBounds(layers);
    onHitShape({
      images: layers
        .map(layer => ({ src: assetUrl(layer.crop_file), x: layer.origin[0], y: layer.origin[1], width: layer.size[0], height: layer.size[1] }))
        .filter(image => image.src),
      place: box => fitPlacement(bounds, box.width, box.height),
    });
    return () => onHitShape(null);
  }, [onHitShape, layers]);

  return (
    <div
      ref={containerRef}
      className={`pl2d-character pl2d-mood-${safeMood} ${animated ? '' : 'pl2d-static'}`}
      aria-hidden="true"
    >
      <div
        className="pl2d-stage"
        style={{
          '--pl2d-canvas-size': `${placement.canvasSize}px`,
          '--pl2d-scale': placement.scale,
          '--pl2d-offset-x': `${placement.offsetX}px`,
          '--pl2d-offset-y': `${placement.offsetY}px`,
        }}
      >
        <div className="pl2d-pose">
          {layers.map((layer) => (
            <LayerSprite
              key={`${layer.order}-${layer.name}`}
              layer={layer}
            />
          ))}
          {mouthLayer && (
            <MouthSequence
              layer={mouthLayer}
              shapes={mouthShapesData}
            />
          )}
        </div>
      </div>
    </div>
  );
}
