import React, { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './layered.css';

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

const MANIFEST_URL = './images/new_images/rebuilt/layer_manifest.json';
const ASSET_ROOT = './images/new_images/rebuilt/';
const MOUTH_ROOT = `${ASSET_ROOT}mouth_shapes/`;
const TEST_AUDIO_URL = './audio/test-topic-1.mp3';
const HEAD_PIVOT = [640, 350] as const;
const BODY_PIVOT = [640, 650] as const;
const EXPORT_WIDTH = 512;
const EXPORT_HEIGHT = 768;
const EXPORT_FPS = 30;
const EXPORT_SCALE = 0.6;
const EXPORT_OFFSET_X = (EXPORT_WIDTH - 1280 * EXPORT_SCALE) / 2;
const EXPORT_OFFSET_Y = 0;
const GREEN_SCREEN = '#25c928';
const BLINK_INITIAL_DELAY = 1.8;
const BLINK_INTERVAL = 4.0;
const BLINK_DURATION = 0.24;
const BLINK_DOUBLE_DELAY = 0.18;
const BLINK_ANGLE = '-12deg';
const BLINK_ANGLE_INVERSE = '12deg';

function _blinkPulseScale(age: number) {
  if (age < 0 || age > BLINK_DURATION) return 1;
  const close = Math.sin((age / BLINK_DURATION) * Math.PI);
  return 1 - close * 0.92;
}

function blinkScaleAt(t: number) {
  if (t < BLINK_INITIAL_DELAY) return 1;
  const local = t - BLINK_INITIAL_DELAY;
  const cycle = Math.floor(local / BLINK_INTERVAL);
  const cycleAge = local - cycle * BLINK_INTERVAL;
  const first = _blinkPulseScale(cycleAge);
  const hasDoubleBlink = cycle % 5 === 2;
  const second = hasDoubleBlink ? _blinkPulseScale(cycleAge - BLINK_DOUBLE_DELAY) : 1;
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
  const pivot = kind === 'head' || kind === 'frontHair' || kind === 'backHair' || kind === 'eye' || kind === 'mouth' ? HEAD_PIVOT : BODY_PIVOT;
  const style = {
    '--x': `${x}px`,
    '--y': `${y}px`,
    '--w': `${w}px`,
    '--h': `${h}px`,
    '--pivot-x': `${pivot[0] - x}px`,
    '--pivot-y': `${pivot[1] - y}px`,
    zIndex: Math.round(layer.order * 10)
  } as CSSProperties;

  return (
    <div
      className={`avatar-layer-slot motion-${kind}`}
      style={style}
      data-layer={layer.name}
    >
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

function MouthSequence({ layer, shapes, mouthIndex }: { layer: Layer; shapes: MouthShapes | null; mouthIndex: number }) {
  const [x, y] = shapes?.origin ?? layer.origin;
  const [w, h] = shapes?.size ?? layer.size;
  const names = shapes?.shapes?.length ? shapes.shapes : ['closed', 'small', 'medium', 'large'];
  const style = {
    '--x': `${x}px`,
    '--y': `${y}px`,
    '--w': `${w}px`,
    '--h': `${h}px`,
    '--pivot-x': `${HEAD_PIVOT[0] - x}px`,
    '--pivot-y': `${HEAD_PIVOT[1] - y}px`,
    zIndex: Math.round((layer.order + 0.1) * 10)
  } as CSSProperties;

  return (
    <div
      className="avatar-layer-slot motion-mouth mouth-sequence audio-driven"
      style={style}
      data-layer="mouth-sequence"
    >
      {names.map((name, index) => (
        <img
          key={name}
          className={`avatar-layer-image mouth-frame mouth-frame-${index}`}
          src={mouthPath(name, shapes)}
          alt=""
          draggable={false}
          style={{ opacity: index === mouthIndex ? 1 : 0 }}
        />
      ))}
    </div>
  );
}

function loadCanvasImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`image load failed: ${src}`));
    image.src = src;
  });
}

function motionFor(kind: MotionKind, t: number) {
  if (kind === 'body') {
    const v = Math.sin((t / 3.6) * Math.PI * 2);
    return { dx: 0, dy: -1.5 - 1.5 * v, rot: 0, sx: 1, sy: 1 + 0.003 + 0.003 * v };
  }
  if (kind === 'object') {
    const v = Math.sin((t / 3.6) * Math.PI * 2);
    return { dx: 0, dy: -1.5 - 1.5 * v, rot: (-0.18 - 0.17 * v) * Math.PI / 180, sx: 1, sy: 1 };
  }
  if (kind === 'head' || kind === 'eye' || kind === 'mouth') {
    return {
      dx: Math.sin((t / 4.2) * Math.PI * 2) * 2,
      dy: -0.5 + Math.sin((t / 4.2) * Math.PI * 2 + Math.PI / 2) * 1.5,
      rot: Math.sin((t / 4.2) * Math.PI * 2) * 0.58 * Math.PI / 180,
      sx: 1,
      sy: 1,
    };
  }
  if (kind === 'frontHair') {
    return {
      dx: Math.sin((t / 4.2) * Math.PI * 2) * 1,
      dy: -0.5 + Math.sin((t / 4.2) * Math.PI * 2 + Math.PI / 2) * 0.5,
      rot: Math.sin((t / 4.2) * Math.PI * 2) * 0.25 * Math.PI / 180,
      sx: 1,
      sy: 1,
    };
  }
  if (kind === 'backHair') {
    return {
      dx: Math.sin((t / 4.8) * Math.PI * 2) * 1,
      dy: 0.5 + Math.sin((t / 4.8) * Math.PI * 2 + Math.PI / 2) * 0.5,
      rot: Math.sin((t / 4.8) * Math.PI * 2) * 0.32 * Math.PI / 180,
      sx: 1,
      sy: 1,
    };
  }
  return { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 };
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  layer: Layer,
  kind: MotionKind,
  t: number,
) {
  const [x, y] = layer.origin;
  const [w, h] = layer.size;
  const pivot = kind === 'head' || kind === 'frontHair' || kind === 'backHair' || kind === 'eye' || kind === 'mouth'
    ? HEAD_PIVOT
    : BODY_PIVOT;
  const m = motionFor(kind, t);
  ctx.save();
  ctx.translate(
    EXPORT_OFFSET_X + (pivot[0] + m.dx) * EXPORT_SCALE,
    EXPORT_OFFSET_Y + (pivot[1] + m.dy) * EXPORT_SCALE,
  );
  ctx.rotate(m.rot);
  ctx.scale(m.sx, m.sy);
  const drawX = (x - pivot[0]) * EXPORT_SCALE;
  const drawY = (y - pivot[1]) * EXPORT_SCALE;
  const drawW = w * EXPORT_SCALE;
  const drawH = h * EXPORT_SCALE;
  const blinkScale = kind === 'eye' ? blinkScaleAt(t) : 1;
  if (blinkScale < 0.999) {
    ctx.translate(drawX + drawW / 2, drawY + drawH / 2);
    ctx.scale(1, blinkScale);
    ctx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH);
  } else {
    ctx.drawImage(image, drawX, drawY, drawW, drawH);
  }
  ctx.restore();
}

function useLayeredExporter(
  layers: Layer[],
  mouthLayer: Layer | null,
  mouthShapes: MouthShapes | null,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const peakRef = useRef(0.08);
  const startedAtRef = useRef(0);
  const [status, setStatus] = useState('等待音频文件。');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const drawFrame = useMemo(() => {
    return async (level: number, t: number, assets?: {
      layerImages: Map<string, HTMLImageElement>;
      mouthImages: HTMLImageElement[];
    }) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || !assets) return;
      ctx.clearRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
      ctx.fillStyle = GREEN_SCREEN;
      ctx.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);

      for (const layer of layers) {
        if (!layer.crop_file || layer.alpha_pixels <= 4 || layer.name === 'objects' || layer.name === 'mouth') continue;
        const image = assets.layerImages.get(layer.crop_file);
        if (!image) continue;
        drawLayer(ctx, image, layer, motionKind(layer.name), t);
      }

      if (mouthLayer && assets.mouthImages.length) {
        const names = mouthShapes?.shapes?.length ? mouthShapes.shapes : ['closed', 'small', 'medium', 'large'];
        const index = level < 0.1 ? 0 : level < 0.34 ? 1 : level < 0.64 ? 2 : Math.min(3, names.length - 1);
        const image = assets.mouthImages[index] ?? assets.mouthImages[0];
        const [x, y] = mouthShapes?.origin ?? mouthLayer.origin;
        const [w, h] = mouthShapes?.size ?? mouthLayer.size;
        const virtualLayer: Layer = {
          ...mouthLayer,
          origin: [x, y],
          size: [w, h],
        };
        drawLayer(ctx, image, virtualLayer, 'mouth', t);
      }
    };
  }, [layers, mouthLayer, mouthShapes]);

  useEffect(() => {
    let cancelled = false;
    const paintRest = async () => {
      if (!layers.length) return;
      const layerImages = new Map<string, HTMLImageElement>();
      for (const layer of layers) {
        if (!layer.crop_file || layer.alpha_pixels <= 4 || layer.name === 'objects' || layer.name === 'mouth') continue;
        layerImages.set(layer.crop_file, await loadCanvasImage(layerPath(layer)));
      }
      const names = mouthShapes?.shapes?.length ? mouthShapes.shapes : ['closed', 'small', 'medium', 'large'];
      const mouthImages = await Promise.all(names.map((name) => loadCanvasImage(mouthPath(name, mouthShapes))));
      if (!cancelled) {
        await drawFrame(0, 0, { layerImages, mouthImages });
      }
    };
    void paintRest();
    return () => {
      cancelled = true;
    };
  }, [drawFrame, layers, mouthShapes]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void audioContextRef.current?.close();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  function supportedMimeType() {
    return [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((type) => window.MediaRecorder?.isTypeSupported(type)) || '';
  }

  function setupAudioGraph() {
    const audio = audioRef.current;
    if (!audio) throw new Error('missing export audio element');
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('当前浏览器不支持 Web Audio');
    const context = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = context;
    if (!analyserRef.current) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.58;
      analyserRef.current = analyser;
    }
    if (!sourceRef.current) {
      sourceRef.current = context.createMediaElementSource(audio);
      sourceRef.current.connect(analyserRef.current);
      analyserRef.current.connect(context.destination);
    }
    return context;
  }

  async function loadAssets() {
    const layerImages = new Map<string, HTMLImageElement>();
    await Promise.all(layers.map(async (layer) => {
      if (!layer.crop_file || layer.alpha_pixels <= 4 || layer.name === 'objects' || layer.name === 'mouth') return;
      layerImages.set(layer.crop_file, await loadCanvasImage(layerPath(layer)));
    }));
    const names = mouthShapes?.shapes?.length ? mouthShapes.shapes : ['closed', 'small', 'medium', 'large'];
    const mouthImages = await Promise.all(names.map((name) => loadCanvasImage(mouthPath(name, mouthShapes))));
    return { layerImages, mouthImages };
  }

  function audioLevel() {
    const analyser = analyserRef.current;
    const audio = audioRef.current;
    if (!analyser || !audio || audio.paused || audio.ended) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / data.length);
    peakRef.current = Math.max(0.035, peakRef.current * 0.985, rms);
    return Math.min(1, rms / peakRef.current);
  }

  async function record() {
    const file = fileInputRef.current?.files?.[0];
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!file || !audio || !canvas) {
      setStatus('请先选择音频文件。');
      return;
    }
    if (!mouthLayer) {
      setStatus('mouth layer 尚未加载。');
      return;
    }

    setStatus('加载分层素材中...');
    setRecording(true);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    const assets = await loadAssets();
    const context = setupAudioGraph();
    if (context.state === 'suspended') await context.resume();

    audio.src = URL.createObjectURL(file);
    audio.currentTime = 0;
    await new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => reject(new Error('音频读取失败'));
      audio.load();
    });

    chunksRef.current = [];
    const stream = canvas.captureStream(EXPORT_FPS);
    const mimeType = supportedMimeType();
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 3_500_000,
    });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setRecording(false);
      setStatus(`WebM 已生成：${(blob.size / 1024 / 1024).toFixed(2)} MB`);
      void drawFrame(0, 0, assets);
    };

    const renderLoop = () => {
      const t = (performance.now() - startedAtRef.current) / 1000;
      void drawFrame(audioLevel(), t, assets);
      rafRef.current = requestAnimationFrame(renderLoop);
    };

    setStatus('录制 layered avatar WebM...');
    startedAtRef.current = performance.now();
    recorder.start(250);
    rafRef.current = requestAnimationFrame(renderLoop);
    await audio.play();
    await new Promise<void>((resolve) => audio.addEventListener('ended', () => resolve(), { once: true }));
    window.setTimeout(() => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (recorder.state === 'recording') recorder.stop();
    }, 250);
  }

  function stop() {
    audioRef.current?.pause();
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  return {
    canvasRef,
    audioRef,
    fileInputRef,
    status,
    downloadUrl,
    recording,
    record,
    stop,
  };
}

function useAudioMouth() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const peakRef = useRef(0.08);
  const [isPlaying, setIsPlaying] = useState(false);
  const [level, setLevel] = useState(0);
  const [mouthIndex, setMouthIndex] = useState(0);
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
    if (!analyser) return;

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
    const nextIndex = normalized < 0.1 ? 0 : normalized < 0.34 ? 1 : normalized < 0.64 ? 2 : 3;
    setLevel(normalized);
    setMouthIndex(nextIndex);
    rafRef.current = requestAnimationFrame(tick);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      setMouthIndex(0);
      return;
    }

    setError(null);
    const context = setupAudioGraph();
    if (!context) return;

    if (context.state === 'suspended') await context.resume();
    if (audio.ended) audio.currentTime = 0;
    await audio.play();
    setIsPlaying(true);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  function handleEnded() {
    setIsPlaying(false);
    setLevel(0);
    setMouthIndex(0);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }

  return { audioRef, isPlaying, level, mouthIndex, error, togglePlayback, handleEnded };
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

function LayeredAvatar() {
  const { manifest, error } = useManifest();
  const mouthShapes = useMouthShapes();
  const audioMouth = useAudioMouth();
  const animationSeconds = useAnimationSeconds();
  const blinkScale = blinkScaleAt(animationSeconds);
  const layers = useMemo(() => {
    return [...(manifest?.layers ?? []), ...(manifest?.generated_layers ?? [])]
      .filter((layer) => layer.crop_file && layer.alpha_pixels > 4 && layer.name !== 'objects' && layer.name !== 'mouth')
      .sort((a, b) => a.order - b.order);
  }, [manifest]);
  const mouthLayer = useMemo(() => {
    return manifest?.layers.find((layer) => layer.name === 'mouth') ?? null;
  }, [manifest]);
  const exporter = useLayeredExporter(layers, mouthLayer, mouthShapes);

  useEffect(() => {
    if (manifest) document.body.dataset.ready = 'true';
  }, [manifest]);

  if (error) return <div className="status">manifest 读取失败：{error}</div>;
  if (!manifest) return <div className="status">读取分层文件中...</div>;

  return (
    <main className="page">
      <section className="preview-panel">
        <div className="stage-shell">
          <div className="avatar-scale">
            <div className="avatar-stage" style={{ '--canvas-size': `${manifest.canvas_size[0]}px` } as CSSProperties}>
              {layers.map((layer) => (
                <LayerSprite key={`${layer.order}-${layer.name}`} layer={layer} blinkScale={blinkScale} />
              ))}
              {mouthLayer && <MouthSequence layer={mouthLayer} shapes={mouthShapes} mouthIndex={audioMouth.mouthIndex} />}
            </div>
          </div>
        </div>
      </section>

      <aside className="control-panel">
        <h1>Layered Avatar Animator</h1>
        <p>
          React/TS 按 `layer_manifest.json` 重建人物，并用每层独立 transform 做伪 Live2D 动作。
        </p>
        <dl>
          <div>
            <dt>图层数</dt>
            <dd>{layers.length}</dd>
          </div>
          <div>
            <dt>动作</dt>
            <dd>呼吸、头部轻摆、头发延迟、本地嘴型序列、眨眼</dd>
          </div>
          <div>
            <dt>素材</dt>
            <dd>new_images/rebuilt/components + generated</dd>
          </div>
        </dl>
        <div className="audio-test">
          <button type="button" onClick={audioMouth.togglePlayback}>
            {audioMouth.isPlaying ? '暂停测试音频' : '播放测试音频'}
          </button>
          <div className="level-meter" aria-label="音频音量">
            <span style={{ width: `${Math.round(audioMouth.level * 100)}%` }} />
          </div>
          {audioMouth.error && <p className="error-text">{audioMouth.error}</p>}
          <audio
            ref={audioMouth.audioRef}
            src={TEST_AUDIO_URL}
            preload="auto"
            onEnded={audioMouth.handleEnded}
          />
        </div>
        <div className="export-panel">
          <h2>导出人物 WebM</h2>
          <canvas
            ref={exporter.canvasRef}
            id="layered-export-canvas"
            width={EXPORT_WIDTH}
            height={EXPORT_HEIGHT}
          />
          <input id="layered-audio-file" ref={exporter.fileInputRef} type="file" accept="audio/*" />
          <div className="export-actions">
            <button id="record-layered" type="button" onClick={() => void exporter.record()} disabled={exporter.recording}>
              {exporter.recording ? '录制中...' : '导出 WebM'}
            </button>
            <button type="button" onClick={exporter.stop} disabled={!exporter.recording}>
              停止
            </button>
          </div>
          {exporter.downloadUrl && (
            <a id="layered-download" className="download-link" href={exporter.downloadUrl} download="layered-avatar.webm">
              下载 layered-avatar.webm
            </a>
          )}
          <p className="export-status">{exporter.status}</p>
          <audio ref={exporter.audioRef} preload="auto" />
        </div>
      </aside>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<LayeredAvatar />);
