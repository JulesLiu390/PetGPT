import * as PIXI from 'pixi.js';
import './styles.css';

const canvas = document.getElementById('live2d-stage');
const audio = document.getElementById('audio');
const audioFile = document.getElementById('audio-file');
const modelUrl = document.getElementById('model-url');
const imageUrl = document.getElementById('image-url');
const mouthDir = document.getElementById('mouth-dir');
const loadModelButton = document.getElementById('load-model');
const loadImageButton = document.getElementById('load-image');
const loadMouthSequenceButton = document.getElementById('load-mouth-sequence');
const fallbackButton = document.getElementById('use-fallback');
const recordButton = document.getElementById('record');
const stopButton = document.getElementById('stop');
const includeAudio = document.getElementById('include-audio');
const greenScreen = document.getElementById('green-screen');
const download = document.getElementById('download');
const statusBox = document.getElementById('status');

const WIDTH = 512;
const HEIGHT = 768;
const FPS = 30;
const GREEN_SCREEN_COLOR = 0x25c928;
const MOUTH_LEVELS = [0, 0.18, 0.48, 1];
const MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
];

let app;
let fallbackAvatar;
let imageAvatar;
let mouthSequenceAvatar;
let live2dModel;
let audioContext;
let analyser;
let mediaDestination;
let recorder;
let chunks = [];
let mouthValue = 0;
let mouthVelocity = 0;
let recordingBackdrop;

function setStatus(message) {
  statusBox.textContent = message;
}

function supportedMimeType() {
  return MIME_TYPES.find((type) => window.MediaRecorder?.isTypeSupported(type)) || '';
}

function initPixi() {
  window.PIXI = PIXI;
  app = new PIXI.Application({
    view: canvas,
    width: WIDTH,
    height: HEIGHT,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: false,
    preserveDrawingBuffer: true
  });
  app.renderer.clear();
  createFallbackAvatar();
  app.ticker.add(() => {
    updateMouthFromAudio();
    if (live2dModel) {
      driveLive2DMouth(live2dModel, mouthValue);
    } else if (mouthSequenceAvatar) {
      updateMouthSequenceAvatar(mouthValue);
    } else if (imageAvatar) {
      updateImageAvatar(mouthValue);
    } else if (fallbackAvatar) {
      drawFallbackAvatar(mouthValue);
    }
  });
}

function createFallbackAvatar() {
  removeMouthSequenceAvatar();
  removeImageAvatar();
  removeLive2DModel();
  fallbackAvatar = new PIXI.Container();
  app.stage.addChild(fallbackAvatar);
  drawFallbackAvatar(0);
  setStatus('已使用占位主播。选择音频后可直接导出透明 WebM。');
}

async function loadImageAvatar(url) {
  if (!url) {
    throw new Error('请先输入图片主播 URL。');
  }
  setStatus(`正在加载图片主播：${url}`);
  removeLive2DModel();
  removeFallbackAvatar();
  removeMouthSequenceAvatar();
  removeImageAvatar();

  const texture = await PIXI.Texture.fromURL(url, { resourceOptions: { crossorigin: 'anonymous' } });
  const container = new PIXI.Container();
  const sprite = new PIXI.Sprite(texture);
  sprite.anchor.set(0.5, 1);
  sprite.position.set(WIDTH / 2, HEIGHT - 18);
  sprite.scale.set(Math.min(WIDTH * 0.95 / sprite.width, HEIGHT * 0.95 / sprite.height));

  const mouth = new PIXI.Graphics();
  mouth.name = 'mouth';
  mouth.beginFill(0x7a2d2a, 0.78);
  mouth.drawRoundedRect(-22, -6, 44, 12, 12);
  mouth.endFill();
  mouth.position.set(WIDTH / 2, HEIGHT * 0.42);
  mouth.visible = false;

  container.addChild(sprite, mouth);
  app.stage.addChild(container);
  imageAvatar = { container, sprite, mouth, baseY: sprite.position.y };
  setStatus(`图片主播已加载：${url}\n提示：换成透明 PNG 后，导出的 WebM 也会是干净透明人物层。`);
}

async function loadMouthSequenceAvatar(dir) {
  const cleanDir = dir.replace(/\/$/, '');
  if (!cleanDir) {
    throw new Error('请先输入嘴型序列目录。');
  }
  setStatus(`正在加载嘴型序列：${cleanDir}`);
  removeLive2DModel();
  removeFallbackAvatar();
  removeImageAvatar();
  removeMouthSequenceAvatar();

  const names = ['closed', 'small', 'medium', 'large'];
  const textures = await Promise.all(
    names.map((name) => PIXI.Texture.fromURL(`${cleanDir}/${name}.png`, { resourceOptions: { crossorigin: 'anonymous' } }))
  );
  const container = new PIXI.Container();
  const sprites = textures.map((texture) => {
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 1);
    sprite.position.set(WIDTH / 2, HEIGHT - 12);
    sprite.scale.set(Math.min(WIDTH * 0.98 / sprite.width, HEIGHT * 0.98 / sprite.height));
    sprite.visible = false;
    container.addChild(sprite);
    return sprite;
  });
  sprites[0].visible = true;
  app.stage.addChild(container);
  mouthSequenceAvatar = {
    container,
    sprites,
    names,
    baseY: sprites[0].position.y,
    baseScaleX: sprites[0].scale.x,
    baseScaleY: sprites[0].scale.y
  };
  updateMouthSequenceAvatar(0);
  setStatus(`嘴型序列已加载：${cleanDir}\n将根据音频音量在 closed / small / medium / large 之间平滑混合。`);
}

function updateMouthSequenceAvatar(value) {
  const avatar = mouthSequenceAvatar;
  if (!avatar) return;

  let lowerIndex = 0;
  while (lowerIndex < MOUTH_LEVELS.length - 1 && value > MOUTH_LEVELS[lowerIndex + 1]) {
    lowerIndex += 1;
  }
  const upperIndex = Math.min(lowerIndex + 1, MOUTH_LEVELS.length - 1);
  const range = Math.max(0.001, MOUTH_LEVELS[upperIndex] - MOUTH_LEVELS[lowerIndex]);
  const blend = Math.min(1, Math.max(0, (value - MOUTH_LEVELS[lowerIndex]) / range));
  const bob = Math.sin(performance.now() / 980) * 3;

  avatar.sprites.forEach((sprite, index) => {
    let alpha = 0;
    if (index === lowerIndex) alpha = 1;
    if (index === upperIndex && upperIndex !== lowerIndex) alpha = Math.max(alpha, blend);
    sprite.visible = alpha > 0.01;
    sprite.alpha = alpha;
    sprite.scale.set(avatar.baseScaleX, avatar.baseScaleY);
    sprite.position.y = avatar.baseY + bob;
  });

  if (value <= MOUTH_LEVELS[0] + 0.001) {
    avatar.sprites[0].visible = true;
    avatar.sprites[0].alpha = 1;
  }
}

function removeMouthSequenceAvatar() {
  if (!mouthSequenceAvatar) return;
  app.stage.removeChild(mouthSequenceAvatar.container);
  mouthSequenceAvatar.container.destroy({ children: true });
  mouthSequenceAvatar = null;
}

function updateImageAvatar(value) {
  const avatar = imageAvatar;
  if (!avatar) return;
  const breath = Math.sin(performance.now() / 650) * 0.01;
  avatar.sprite.scale.y = Math.abs(avatar.sprite.scale.x) * (1 + breath);
  avatar.sprite.position.y = avatar.baseY + Math.sin(performance.now() / 900) * 5;
  avatar.mouth.visible = value > 0.04;
  avatar.mouth.scale.y = 0.6 + value * 2.4;
  avatar.mouth.alpha = 0.45 + value * 0.45;
}

function removeImageAvatar() {
  if (!imageAvatar) return;
  app.stage.removeChild(imageAvatar.container);
  imageAvatar.container.destroy({ children: true });
  imageAvatar = null;
}

function drawFallbackAvatar(mouthOpenRatio) {
  if (!fallbackAvatar) return;
  fallbackAvatar.removeChildren();

  const body = new PIXI.Graphics();
  body.beginFill(0xc87850, 0.95);
  body.drawRoundedRect(144, 370, 224, 310, 98);
  body.endFill();

  const neck = new PIXI.Graphics();
  neck.beginFill(0xf0c2aa, 1);
  neck.drawRoundedRect(230, 336, 52, 78, 22);
  neck.endFill();

  const face = new PIXI.Graphics();
  face.beginFill(0xf5d2bd, 1);
  face.drawEllipse(256, 246, 118, 134);
  face.endFill();

  const hair = new PIXI.Graphics();
  hair.beginFill(0x2d2523, 1);
  hair.drawEllipse(256, 190, 128, 90);
  hair.drawRoundedRect(146, 180, 220, 120, 48);
  hair.endFill();

  const eyeL = new PIXI.Graphics();
  eyeL.beginFill(0x2a2726, 1);
  eyeL.drawEllipse(214, 252, 12, 18);
  eyeL.endFill();

  const eyeR = new PIXI.Graphics();
  eyeR.beginFill(0x2a2726, 1);
  eyeR.drawEllipse(298, 252, 12, 18);
  eyeR.endFill();

  const mouthOpen = Math.max(5, 8 + mouthOpenRatio * 36);
  const mouthGraphic = new PIXI.Graphics();
  mouthGraphic.beginFill(0x73322d, 1);
  mouthGraphic.drawRoundedRect(228, 306, 56, mouthOpen, 18);
  mouthGraphic.endFill();

  const blushL = new PIXI.Graphics();
  blushL.beginFill(0xd98679, 0.35);
  blushL.drawEllipse(184, 298, 26, 12);
  blushL.endFill();

  const blushR = new PIXI.Graphics();
  blushR.beginFill(0xd98679, 0.35);
  blushR.drawEllipse(328, 298, 26, 12);
  blushR.endFill();

  const shine = new PIXI.Graphics();
  shine.lineStyle(10, 0xffffff, 0.85);
  shine.moveTo(168, 510);
  shine.lineTo(344, 510);

  fallbackAvatar.addChild(body, neck, face, hair, eyeL, eyeR, mouthGraphic, blushL, blushR, shine);
}

function removeLive2DModel() {
  if (!live2dModel) return;
  app.stage.removeChild(live2dModel);
  live2dModel.destroy();
  live2dModel = null;
}

function removeFallbackAvatar() {
  if (!fallbackAvatar) return;
  app.stage.removeChild(fallbackAvatar);
  fallbackAvatar.destroy({ children: true });
  fallbackAvatar = null;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((script) => script.src.endsWith(url))) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function loadLive2DModel(url) {
  if (!url) {
    throw new Error('请先输入 model3.json URL。');
  }

  setStatus('正在加载 Cubism runtime 和 Live2D 模型...');
  await loadScript('/live2d/Core/live2dcubismcore.min.js').catch(() => {
    throw new Error('缺少 /live2d/Core/live2dcubismcore.min.js。请把 Cubism 4 Core runtime 放到 public/live2d/Core/ 下。');
  });

  const { Live2DModel } = await import('pixi-live2d-display/cubism4');
  const model = await Live2DModel.from(url);
  removeMouthSequenceAvatar();
  removeImageAvatar();
  removeFallbackAvatar();
  removeLive2DModel();
  live2dModel = model;
  model.anchor.set(0.5, 0.5);
  model.scale.set(Math.min(WIDTH / model.width, HEIGHT / model.height) * 0.92);
  model.position.set(WIDTH / 2, HEIGHT / 2 + 32);
  app.stage.addChild(model);
  setStatus(`模型已加载：${url}`);
}

function driveLive2DMouth(model, value) {
  const coreModel = model?.internalModel?.coreModel;
  if (!coreModel?.setParameterValueById) return;
  coreModel.setParameterValueById('ParamMouthOpenY', Math.min(1, Math.max(0, value)));
}

function setupAudioGraph() {
  if (audioContext) return;
  audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(audio);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  const outputGain = audioContext.createGain();
  mediaDestination = audioContext.createMediaStreamDestination();

  source.connect(analyser);
  analyser.connect(outputGain);
  outputGain.connect(audioContext.destination);
  analyser.connect(mediaDestination);
}

function updateMouthFromAudio() {
  if (!analyser || audio.paused || audio.ended) {
    mouthVelocity *= 0.68;
    mouthValue = Math.max(0, mouthValue * 0.72 + mouthVelocity * 0.04);
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
  const target = Math.min(1, Math.max(0, (rms - 0.02) * 8.5));
  const smoothing = target > mouthValue ? 0.38 : 0.16;
  const next = mouthValue + (target - mouthValue) * smoothing;
  mouthVelocity = next - mouthValue;
  mouthValue = next;
}

async function loadAudioFromFile(file) {
  if (!file) return;
  audio.src = URL.createObjectURL(file);
  await audio.load();
  recordButton.disabled = false;
  download.hidden = true;
  setStatus(`音频已载入：${file.name}`);
}

function waitForAudioEnd() {
  return new Promise((resolve) => {
    if (audio.ended) {
      resolve();
      return;
    }
    audio.addEventListener('ended', resolve, { once: true });
  });
}

async function startRecording() {
  if (!audio.src) {
    setStatus('请先选择音频文件。');
    return;
  }

  setupAudioGraph();
  await audioContext.resume();
  audio.currentTime = 0;
  chunks = [];
  download.hidden = true;
  if (greenScreen.checked) {
    recordingBackdrop = new PIXI.Graphics();
    recordingBackdrop.beginFill(GREEN_SCREEN_COLOR, 1);
    recordingBackdrop.drawRect(0, 0, WIDTH, HEIGHT);
    recordingBackdrop.endFill();
    app.stage.addChildAt(recordingBackdrop, 0);
  }
  app.render();

  const stream = canvas.captureStream(FPS);
  if (includeAudio.checked) {
    for (const track of mediaDestination.stream.getAudioTracks()) {
      stream.addTrack(track);
    }
  }

  const mimeType = supportedMimeType();
  recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 3_500_000
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => finishRecording(mimeType);

  recordButton.disabled = true;
  stopButton.disabled = false;
  setStatus(`录制中：${mimeType || 'browser default'}，背景透明。`);
  recorder.start(250);
  await audio.play();
  await waitForAudioEnd();
  setTimeout(() => {
    removeRecordingBackdrop();
    app.render();
    if (recorder?.state === 'recording') recorder.stop();
  }, 250);
}

function removeRecordingBackdrop() {
  if (!recordingBackdrop) return;
  app.stage.removeChild(recordingBackdrop);
  recordingBackdrop.destroy();
  recordingBackdrop = null;
}

function finishRecording(mimeType) {
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  download.href = url;
  download.download = `live2d-overlay-${Date.now()}.webm`;
  download.hidden = false;
  download.textContent = `下载 WebM (${(blob.size / 1024 / 1024).toFixed(2)} MB)`;
  recordButton.disabled = !audio.src;
  stopButton.disabled = true;
  setStatus('WebM 已生成。可以下载后用 ffmpeg overlay 到主视频左下角。');
}

function stopRecording() {
  audio.pause();
  removeRecordingBackdrop();
  if (recorder?.state === 'recording') recorder.stop();
}

function bootstrapFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const model = params.get('model');
  const image = params.get('image');
  const mouth = params.get('mouth');
  const audioUrl = params.get('audio');
  if (model) modelUrl.value = model;
  if (image) imageUrl.value = image;
  if (mouth) mouthDir.value = mouth;
  if (audioUrl) {
    audio.src = audioUrl;
    audio.crossOrigin = 'anonymous';
    recordButton.disabled = false;
    setStatus(`音频 URL 已载入：${audioUrl}`);
  }
}

audioFile.addEventListener('change', () => loadAudioFromFile(audioFile.files?.[0]));
loadModelButton.addEventListener('click', () => {
  loadLive2DModel(modelUrl.value.trim()).catch((error) => setStatus(`模型加载失败：${error.message}`));
});
loadImageButton.addEventListener('click', () => {
  loadImageAvatar(imageUrl.value.trim()).catch((error) => setStatus(`图片加载失败：${error.message}`));
});
loadMouthSequenceButton.addEventListener('click', () => {
  loadMouthSequenceAvatar(mouthDir.value.trim()).catch((error) => setStatus(`嘴型序列加载失败：${error.message}`));
});
fallbackButton.addEventListener('click', createFallbackAvatar);
recordButton.addEventListener('click', () => startRecording().catch((error) => setStatus(`导出失败：${error.message}`)));
stopButton.addEventListener('click', stopRecording);

initPixi();
bootstrapFromQuery();
document.body.dataset.ready = 'true';
