import React, { CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './background_stage.css';

type Layer = {
  order: number;
  name: string;
  crop_file?: string;
  origin: [number, number];
  size: [number, number];
  alpha_pixels: number;
};

type Manifest = {
  canvas_size: [number, number];
  layers: Layer[];
  generated_layers?: Layer[];
};

type MouthShapes = {
  origin: [number, number];
  size: [number, number];
  shapes: string[];
  files?: Record<string, string>;
};

type MotionKind = 'body' | 'head' | 'frontHair' | 'backHair' | 'mouth' | 'eye' | 'object' | 'still';
type FloatingText = {
  id: number;
  text: string;
};

const MANIFEST_URL = './images/new_images/rebuilt/layer_manifest.json';
const ASSET_ROOT = './images/new_images/rebuilt/';
const MOUTH_ROOT = `${ASSET_ROOT}mouth_shapes/`;
const DEFAULT_AUDIO_URL = './audio/test-topic-1.mp3';
const HEAD_PIVOT = [640, 350] as const;
const BODY_PIVOT = [640, 650] as const;
const BLINK_INITIAL_DELAY = 1.8;
const BLINK_INTERVAL = 4.0;
const BLINK_DURATION = 0.24;
const BLINK_DOUBLE_DELAY = 0.18;
const MOUTH_ATTACK = 0.48;
const MOUTH_RELEASE = 0.16;
const BLINK_ANGLE = '-12deg';
const BLINK_ANGLE_INVERSE = '12deg';

function blinkPulseScale(age: number) {
  if (age < 0 || age > BLINK_DURATION) return 1;
  const close = Math.sin((age / BLINK_DURATION) * Math.PI);
  return 1 - close * 0.92;
}

function blinkScaleAt(t: number) {
  if (t < BLINK_INITIAL_DELAY) return 1;
  const local = t - BLINK_INITIAL_DELAY;
  const cycle = Math.floor(local / BLINK_INTERVAL);
  const cycleAge = local - cycle * BLINK_INTERVAL;
  const first = blinkPulseScale(cycleAge);
  const hasDoubleBlink = cycle % 5 === 2;
  const second = hasDoubleBlink ? blinkPulseScale(cycleAge - BLINK_DOUBLE_DELAY) : 1;
  return Math.min(first, second);
}

function motionKind(name: string): MotionKind {
  if (name.includes('mouth')) return 'mouth';
  if (name.includes('eyelash') || name.includes('eyewhite') || name.includes('irides')) return 'eye';
  if (name.includes('front hair')) return 'frontHair';
  if (name.includes('back hair')) return 'backHair';
  if (name.includes('face') || name.includes('nose') || name.includes('ears') || name.includes('eyebrow') || name.includes('neck-fallback')) return 'head';
  if (name.includes('object') || name.includes('hands') || name.includes('sleeves')) return 'object';
  if (name.includes('topwear') || name.includes('neck') || name.includes('bottomwear') || name.includes('legwear') || name.includes('footwear') || name.includes('thigh')) return 'body';
  return 'still';
}

function isBlinkLayer(name: string) {
  return name.includes('eyelash') || name.includes('eyewhite') || name.includes('irides');
}

function blinkAngle(name: string) {
  return isBlinkLayer(name) ? BLINK_ANGLE : '0deg';
}

function inverseBlinkAngle(name: string) {
  return isBlinkLayer(name) ? BLINK_ANGLE_INVERSE : '0deg';
}

function layerPath(layer: Layer) {
  return `${ASSET_ROOT}${layer.crop_file}`;
}

function mouthPath(name: string, shapes: MouthShapes | null) {
  const file = shapes?.files?.[name] ?? `${name}.png`;
  return `${MOUTH_ROOT}${file}`;
}

function LayerSprite({ layer, blinkScale = 1 }: { layer: Layer; blinkScale?: number }) {
  const [x, y] = layer.origin;
  const [w, h] = layer.size;
  const kind = motionKind(layer.name);
  const pivot = kind === 'head' || kind === 'frontHair' || kind === 'backHair' || kind === 'eye' || kind === 'mouth'
    ? HEAD_PIVOT
    : BODY_PIVOT;
  const style = {
    '--x': `${x}px`,
    '--y': `${y}px`,
    '--w': `${w}px`,
    '--h': `${h}px`,
    '--pivot-x': `${pivot[0] - x}px`,
    '--pivot-y': `${pivot[1] - y}px`,
    zIndex: Math.round(layer.order * 10),
  } as CSSProperties;

  return (
    <div className={`avatar-layer-slot motion-${kind}`} style={style} data-layer={layer.name}>
      <img
        className={`avatar-layer-image detail-${kind}`}
        src={layerPath(layer)}
        alt=""
        draggable={false}
        style={isBlinkLayer(layer.name) ? {
          '--blink-scale': blinkScale,
          '--blink-shift': `${(1 - blinkScale) * 1.5}px`,
          '--blink-angle': blinkAngle(layer.name),
          '--blink-angle-inverse': inverseBlinkAngle(layer.name),
        } as CSSProperties : undefined}
      />
    </div>
  );
}

function MouthSequence({
  layer,
  shapes,
  mouthLevel,
}: {
  layer: Layer;
  shapes: MouthShapes | null;
  mouthLevel: number;
}) {
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
  const style = {
    '--x': `${x}px`,
    '--y': `${y}px`,
    '--w': `${w}px`,
    '--h': `${h}px`,
    '--pivot-x': `${HEAD_PIVOT[0] - x}px`,
    '--pivot-y': `${HEAD_PIVOT[1] - y}px`,
    '--mouth-scale': mouthScaleY,
    zIndex: Math.round((layer.order + 0.1) * 10),
  } as CSSProperties;

  return (
    <div className="avatar-layer-slot motion-mouth mouth-sequence audio-driven" style={style} data-layer="mouth-sequence">
      {names.map((name, index) => (
        <img
          key={name}
          className={`avatar-layer-image mouth-frame ${index === activeIndex ? 'mouth-frame-active' : ''}`}
          src={mouthPath(name, shapes)}
          alt=""
          draggable={false}
          style={{ opacity: index === activeIndex ? 1 : 0 }}
        />
      ))}
    </div>
  );
}

function useManifest() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(MANIFEST_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data: Manifest) => {
        if (active) setManifest(data);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);

  return { manifest, error };
}

function useMouthShapes() {
  const [shapes, setShapes] = useState<MouthShapes | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${MOUTH_ROOT}index.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data: MouthShapes) => {
        if (active) setShapes(data);
      })
      .catch(() => {
        if (active) setShapes(null);
      });
    return () => {
      active = false;
    };
  }, []);

  return shapes;
}

function useAnimationSeconds() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let rafId: number | null = null;
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
  }, []);

  return seconds;
}

declare global {
  interface Window {
    __personClipDone?: boolean;
    __startPersonClip?: () => Promise<void>;
  }
}

function useAudioMouth() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0.08);
  const smoothLevelRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void audioContextRef.current?.close();
    };
  }, []);

  function setupAudioGraph() {
    const audio = audioRef.current;
    if (!audio) return null;
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setError('当前浏览器不支持 Web Audio。');
      return null;
    }
    const context = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = context;
    if (!analyserRef.current) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.62;
      analyserRef.current = analyser;
    }
    if (!sourceRef.current) {
      sourceRef.current = context.createMediaElementSource(audio);
      sourceRef.current.connect(analyserRef.current);
      analyserRef.current.connect(context.destination);
    }
    return context;
  }

  function tick() {
    const analyser = analyserRef.current;
    const audio = audioRef.current;
    if (!analyser || !audio || audio.paused || audio.ended) {
      setLevel(0);
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    peakRef.current = Math.max(0.035, peakRef.current * 0.985, rms);
    const normalized = Math.min(1, rms / peakRef.current);
    const response = normalized > smoothLevelRef.current ? MOUTH_ATTACK : MOUTH_RELEASE;
    smoothLevelRef.current = smoothLevelRef.current * (1 - response) + normalized * response;
    const smoothed = smoothLevelRef.current;
    setLevel(smoothed);
    rafRef.current = requestAnimationFrame(tick);
  }

  async function play() {
    const audio = audioRef.current;
    if (!audio) return;
    setError(null);
    const context = setupAudioGraph();
    if (!context) return;
    if (context.state === 'suspended') await context.resume();
    audio.currentTime = 0;
    await audio.play();
    setIsPlaying(true);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      setLevel(0);
      smoothLevelRef.current = 0;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      return;
    }
    await play();
  }

  function handleEnded() {
    setIsPlaying(false);
    setLevel(0);
    smoothLevelRef.current = 0;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }

  return { audioRef, isPlaying, level, error, play, togglePlayback, handleEnded };
}

function avatarBounds(layers: Layer[]) {
  if (!layers.length) return { minY: 0, height: 1280 };
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const layer of layers) {
    minY = Math.min(minY, layer.origin[1]);
    maxY = Math.max(maxY, layer.origin[1] + layer.size[1]);
  }
  return { minY, height: Math.max(1, maxY - minY) };
}

function useAvatarPlacement(layers: Layer[]) {
  const bounds = useMemo(() => avatarBounds(layers), [layers]);
  const [placement, setPlacement] = useState(() => {
    if (typeof window === 'undefined') return { scale: 1, topOffset: 0 };
    const scale = (window.innerHeight * 0.925) / (bounds.height * 0.4);
    return { scale, topOffset: -bounds.minY * scale };
  });

  useEffect(() => {
    const update = () => {
      const scale = (window.innerHeight * 0.925) / (bounds.height * 0.4);
      setPlacement({ scale, topOffset: -bounds.minY * scale });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [bounds.height, bounds.minY]);

  return placement;
}

function FloatingTextItem({ item }: { item: FloatingText }) {
  const [fontSize, setFontSize] = useState(120);

  useLayoutEffect(() => {
    const fitText = async () => {
      await document.fonts?.ready;
      const maxSize = 120;
      const minSize = 36;
      const targetWidth = window.innerWidth * 0.65;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      context.font = `900 ${maxSize}px CoverTitleNotoBlack, Noto Sans CJK SC, PingFang SC, sans-serif`;
      const measuredWidth = context.measureText(item.text).width * 1.08 || 1;
      const nextSize = Math.max(minSize, Math.min(maxSize, (maxSize * targetWidth) / measuredWidth));
      setFontSize(nextSize);
    };

    fitText();
    window.addEventListener('resize', fitText);
    return () => window.removeEventListener('resize', fitText);
  }, [item.text]);

  return (
    <div className="floating-text-position">
      <div
        className="floating-text"
        style={{ '--floating-font-size': `${fontSize}px` } as CSSProperties}
      >
        {item.text}
      </div>
    </div>
  );
}

function FloatingTextLayer({ items }: { items: FloatingText[] }) {
  return (
    <div className="floating-text-layer" aria-hidden="true">
      {items.map((item) => (
        <FloatingTextItem item={item} key={item.id} />
      ))}
    </div>
  );
}

function BackgroundStage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const renderMode = params.get('render') === '1';
  const audioUrl = params.get('audio') || DEFAULT_AUDIO_URL;
  const overlayText = params.get('text') || '';
  const { manifest, error } = useManifest();
  const mouthShapes = useMouthShapes();
  const audioMouth = useAudioMouth();
  const textIdRef = useRef(0);
  const [floatingText, setFloatingText] = useState<FloatingText[]>([]);
  const [textDraft, setTextDraft] = useState('Agent 训练的瓶颈变了');
  const animationSeconds = useAnimationSeconds();
  const blinkScale = blinkScaleAt(animationSeconds);
  const layers = useMemo(() => {
    return [...(manifest?.layers ?? []), ...(manifest?.generated_layers ?? [])]
      .filter((layer) => layer.crop_file && layer.alpha_pixels > 4 && layer.name !== 'objects' && layer.name !== 'mouth')
      .sort((a, b) => a.order - b.order);
  }, [manifest]);
  const avatarPlacement = useAvatarPlacement(layers);
  const mouthLayer = useMemo(() => manifest?.layers.find((layer) => layer.name === 'mouth') ?? null, [manifest]);

  useEffect(() => {
    if (manifest) document.body.dataset.ready = 'true';
  }, [manifest]);

  useEffect(() => {
    document.body.dataset.renderMode = renderMode ? 'true' : 'false';
  }, [renderMode]);

  function sendFloatingText() {
    const text = textDraft.trim() || 'Agent 训练的瓶颈变了';
    const id = ++textIdRef.current;
    setFloatingText((items) => [...items, { id, text }]);
    window.setTimeout(() => {
      setFloatingText((items) => items.filter((item) => item.id !== id));
    }, 3600);
  }

  useEffect(() => {
    if (!renderMode || !manifest) return;
    window.__personClipDone = false;
    const audio = audioMouth.audioRef.current;
    if (!audio) return;
    let textTimer: number | null = null;

    const start = async () => {
      if (textTimer !== null) window.clearTimeout(textTimer);
      window.__personClipDone = false;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      if (overlayText.trim() && duration > 0) {
        textTimer = window.setTimeout(() => {
          const id = ++textIdRef.current;
          setFloatingText((items) => [...items, { id, text: overlayText.trim() }]);
          window.setTimeout(() => {
            setFloatingText((items) => items.filter((item) => item.id !== id));
          }, 3600);
        }, Math.max(0, (duration / 2) * 1000 - 500));
      }
      await audioMouth.play().catch(() => {
        window.__personClipDone = true;
      });
    };

    window.__startPersonClip = start;

    return () => {
      if (textTimer !== null) window.clearTimeout(textTimer);
      delete window.__startPersonClip;
    };
  }, [manifest, overlayText, renderMode]);

  if (error) return <div className="status">manifest 读取失败：{error}</div>;
  if (!manifest) return <div className="status">读取分层文件中...</div>;

  return (
    <main className="stage-page">
      <div className="stage-bg" />
      <div className="stage-vignette" />
      <FloatingTextLayer items={floatingText} />
      <section className="presenter-anchor" aria-label="presenter">
        <div
          className="presenter-scale"
          style={{
            '--avatar-scale': avatarPlacement.scale,
            '--avatar-top-offset': `${avatarPlacement.topOffset}px`,
          } as CSSProperties}
        >
          <div className="avatar-stage" style={{ '--canvas-size': `${manifest.canvas_size[0]}px` } as CSSProperties}>
            {layers.map((layer) => (
              <LayerSprite key={`${layer.order}-${layer.name}`} layer={layer} blinkScale={blinkScale} />
            ))}
            {mouthLayer && (
              <MouthSequence
                layer={mouthLayer}
                shapes={mouthShapes}
                mouthLevel={audioMouth.level}
              />
            )}
          </div>
        </div>
      </section>
      {!renderMode && <aside className="hud">
        <h1>Background + Pseudo Live2D Test</h1>
        <p>使用根目录 image/background.png 做背景，分层人物保留呼吸、眨眼、轻摆和音量驱动嘴型。</p>
        <div className="controls">
          <button className="play-button" type="button" onClick={audioMouth.togglePlayback}>
            {audioMouth.isPlaying ? '暂停音频' : '播放音频'}
          </button>
          <div className="level-meter" aria-label="音频音量">
            <span style={{ width: `${Math.round(audioMouth.level * 100)}%` }} />
          </div>
        </div>
        <div className="text-controls">
          <input
            value={textDraft}
            onChange={(event) => setTextDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') sendFloatingText();
            }}
            aria-label="镜头文字"
          />
          <button type="button" onClick={sendFloatingText}>发送文字</button>
        </div>
        {audioMouth.error && <p className="error-text">{audioMouth.error}</p>}
      </aside>}
      <audio
        ref={audioMouth.audioRef}
        src={audioUrl}
        preload="auto"
        onEnded={() => {
          audioMouth.handleEnded();
          window.__personClipDone = true;
        }}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<BackgroundStage />);
