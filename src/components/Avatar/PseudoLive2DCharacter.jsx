import React, { useEffect, useMemo, useRef, useState } from 'react';
import manifestData from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/layer_manifest.json';
import mouthShapesData from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/index.json';
import mouthClosedUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/closed.png?url';
import mouthSmallUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/small.png?url';
import mouthMediumUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/medium.png?url';
import mouthLargeUrl from '../../../pseudo_live2d_renderer/images/new_images/rebuilt/mouth_shapes/large.png?url';
import './PseudoLive2DCharacter.css';

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
const HEAD_PIVOT = [640, 350];
const BODY_PIVOT = [640, 650];
const BLINK_INITIAL_DELAY = 1.8;
const BLINK_INTERVAL = 4.0;
const BLINK_DURATION = 0.24;
const BLINK_DOUBLE_DELAY = 0.18;
const FIT_SCALE = 0.96;
const VERTICAL_NUDGE = 0.015;

function assetUrl(relativePath) {
  const key = `${ASSET_PREFIX}${relativePath}`;
  return assetModules[key] || '';
}

function blinkPulseScale(age) {
  if (age < 0 || age > BLINK_DURATION) return 1;
  const close = Math.sin((age / BLINK_DURATION) * Math.PI);
  return 1 - close * 0.92;
}

function blinkScaleAt(t) {
  if (t < BLINK_INITIAL_DELAY) return 1;
  const local = t - BLINK_INITIAL_DELAY;
  const cycle = Math.floor(local / BLINK_INTERVAL);
  const cycleAge = local - cycle * BLINK_INTERVAL;
  const first = blinkPulseScale(cycleAge);
  const hasDoubleBlink = cycle % 5 === 2;
  const second = hasDoubleBlink ? blinkPulseScale(cycleAge - BLINK_DOUBLE_DELAY) : 1;
  return Math.min(first, second);
}

function motionKind(name) {
  if (name.includes('mouth')) return 'mouth';
  if (name.includes('eyelash') || name.includes('eyewhite') || name.includes('irides')) return 'eye';
  if (name.includes('front hair')) return 'frontHair';
  if (name.includes('back hair')) return 'backHair';
  if (name.includes('face') || name.includes('nose') || name.includes('ears') || name.includes('eyebrow') || name.includes('neck-fallback')) return 'head';
  if (name.includes('object') || name.includes('hands') || name.includes('sleeves')) return 'object';
  if (name.includes('topwear') || name.includes('neck') || name.includes('bottomwear') || name.includes('legwear') || name.includes('footwear') || name.includes('thigh')) return 'body';
  return 'still';
}

function isBlinkLayer(name) {
  return name.includes('eyelash') || name.includes('eyewhite') || name.includes('irides');
}

function sanitizeMood(mood) {
  return String(mood || 'normal').replace(/[^a-zA-Z0-9-]/g, '');
}

function useAnimationSeconds(enabled = true) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setSeconds(0);
      return undefined;
    }

    let rafId = null;
    let cancelled = false;
    const startedAt = performance.now();
    const tick = () => {
      if (!cancelled) {
        setSeconds((performance.now() - startedAt) / 1000);
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [enabled]);

  return seconds;
}

function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
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

function mouthLevelForMood(mood, seconds) {
  if (mood === 'thinking') {
    return 0.22 + Math.abs(Math.sin(seconds * 8.2)) * 0.62;
  }
  if (mood === 'shocked') return 1;
  if (mood === 'smile') return 0.42;
  if (mood === 'sad') return 0.08;
  if (mood?.startsWith('idle-')) {
    return Math.max(0, Math.sin(seconds * 1.2) * 0.05);
  }
  return 0;
}

function LayerSprite({ layer, blinkScale }) {
  const [x, y] = layer.origin;
  const [w, h] = layer.size;
  const kind = motionKind(layer.name);
  const pivot = kind === 'head' || kind === 'frontHair' || kind === 'backHair' || kind === 'eye' || kind === 'mouth'
    ? HEAD_PIVOT
    : BODY_PIVOT;
  const src = assetUrl(layer.crop_file);

  if (!src) return null;

  return (
    <div
      className={`pl2d-layer pl2d-motion-${kind}`}
      style={{
        '--x': `${x}px`,
        '--y': `${y}px`,
        '--w': `${w}px`,
        '--h': `${h}px`,
        '--pivot-x': `${pivot[0] - x}px`,
        '--pivot-y': `${pivot[1] - y}px`,
        zIndex: Math.round(layer.order * 10),
      }}
      data-layer={layer.name}
    >
      <img
        className={`pl2d-layer-image ${isBlinkLayer(layer.name) ? 'pl2d-detail-eye' : ''}`}
        src={src}
        alt=""
        draggable={false}
        style={isBlinkLayer(layer.name) ? {
          '--blink-scale': blinkScale,
          '--blink-shift': `${(1 - blinkScale) * 1.5}px`,
          '--blink-angle': '-12deg',
          '--blink-angle-inverse': '12deg',
        } : undefined}
      />
    </div>
  );
}

function MouthSequence({ layer, shapes, mouthLevel }) {
  const [x, y] = shapes?.origin ?? layer.origin;
  const [w, h] = shapes?.size ?? layer.size;
  const names = shapes?.shapes?.length ? shapes.shapes : ['closed', 'small', 'medium', 'large'];
  const mouthAmount = mouthLevel < 0.08 ? 0 : Math.min(1, Math.max(0, (mouthLevel - 0.08) / 0.82));
  const activeIndex = mouthAmount === 0
    ? 0
    : Math.min(names.length - 1, Math.max(1, Math.round(mouthAmount * (names.length - 1))));
  const bandStart = activeIndex <= 0 ? 0 : (activeIndex - 0.5) / Math.max(1, names.length - 1);
  const bandEnd = activeIndex <= 0 ? 0.08 : (activeIndex + 0.5) / Math.max(1, names.length - 1);
  const bandProgress = activeIndex <= 0
    ? 0
    : Math.min(1, Math.max(0, (mouthAmount - bandStart) / Math.max(0.01, bandEnd - bandStart)));
  const mouthScaleY = activeIndex <= 0 ? 1 : 0.88 + bandProgress * 0.22;

  return (
    <div
      className="pl2d-layer pl2d-motion-mouth pl2d-mouth-sequence"
      style={{
        '--x': `${x}px`,
        '--y': `${y}px`,
        '--w': `${w}px`,
        '--h': `${h}px`,
        '--pivot-x': `${HEAD_PIVOT[0] - x}px`,
        '--pivot-y': `${HEAD_PIVOT[1] - y}px`,
        '--mouth-scale': mouthScaleY,
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
            className={`pl2d-layer-image pl2d-mouth-frame ${index === activeIndex ? 'pl2d-mouth-frame-active' : ''}`}
            src={src}
            alt=""
            draggable={false}
            style={{ opacity: index === activeIndex ? 1 : 0 }}
          />
        );
      })}
    </div>
  );
}

export default function PseudoLive2DCharacter({ mood = 'normal', animated = true }) {
  const [containerRef, size] = useElementSize();
  const seconds = useAnimationSeconds(animated);
  const safeMood = sanitizeMood(mood);
  const blinkScale = animated ? blinkScaleAt(seconds) : 1;

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
    const bounds = layerBounds(layers);
    if (!size.width || !size.height) {
      return { canvasSize, scale: 0.5, offsetX: 0, offsetY: 0 };
    }

    const scale = Math.min(size.width / bounds.width, size.height / bounds.height) * FIT_SCALE;
    const offsetX = (size.width - bounds.width * scale) / 2 - bounds.minX * scale;
    const offsetY = (size.height - bounds.height * scale) / 2 - bounds.minY * scale + size.height * VERTICAL_NUDGE;

    return { canvasSize, scale, offsetX, offsetY };
  }, [layers, size.height, size.width]);

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
        {layers.map((layer) => (
          <LayerSprite
            key={`${layer.order}-${layer.name}`}
            layer={layer}
            blinkScale={blinkScale}
          />
        ))}
        {mouthLayer && (
          <MouthSequence
            layer={mouthLayer}
            shapes={mouthShapesData}
            mouthLevel={mouthLevelForMood(safeMood, seconds)}
          />
        )}
      </div>
    </div>
  );
}
