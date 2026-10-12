import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getSkinAppearance, onSkinsUpdated } from '../../utils/tauri';
import PseudoLive2DCharacter from './PseudoLive2DCharacter';
import { blinkScaleAt } from './avatarRendering';
import { watchCursor } from './cursorTracker';
import { currentSwingPose, subscribeSwing } from './dragSwing';
import { createHeadMotion } from './headMotion';
import {
  breathAt, gazeOffset, layerTransform, layeredRig, orderedSkinLayers, skinViewBox, thoughtDots,
} from './skinModel';
import './CharacterAppearance.css';

// Iris easing rate per second: quick enough to read as a glance, smooth enough to hide polling.
const GAZE_RATE = 12;
// Idle glances wait until the cursor has rested this long, so they never pull away from a moving one.
const IDLE_AFTER = 2.5;
// Thinking slows breathing to this share of its usual pace.
const THINKING_BREATH = 0.7;

/** Breathing, blink, gaze, head tilts, hair sway and the drag swing's secondary motion on one clock, written straight to the SVG. */
function useLayeredMotion(svgRef, rig, animated, thinking) {
  // Read every frame rather than restarting the effect, so a mood change never resets the clock.
  const thinkingRef = useRef(thinking);
  useEffect(() => { thinkingRef.current = thinking; }, [thinking]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !animated || !rig.parts.size) return undefined;
    const parts = [...svg.querySelectorAll('[data-part]')].map(element => ({ element, name: element.dataset.part, last: '' }));
    const iris = svg.querySelector('[data-gaze]');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cursor = iris ? watchCursor() : null;
    const headMotion = createHeadMotion();
    let rafId = null;
    let startedAt = null;
    let lastFrame = null;
    let lastPoint = null;
    let rested = null;
    let breathClock = 0;
    let breathPace = 1;
    let aim = [0, 0];
    let gaze = [0, 0];

    const aimAt = (point) => {
      if (!point) return [0, 0];
      const matrix = svg.getScreenCTM();
      if (!matrix) return [0, 0];
      const [x, y] = rig.eyes.pivot;
      const eye = new DOMPoint(x, y).matrixTransform(matrix);
      return gazeOffset(point.x - eye.x, point.y - eye.y, rig.eyes.gazeRange);
    };
    const tick = (now) => {
      startedAt ??= now;
      const seconds = (now - startedAt) / 1000;
      const elapsed = lastFrame === null ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      const point = cursor?.current() ?? null;
      if (point && (!rested || Math.hypot(point.x - rested.x, point.y - rested.y) > 2)) rested = { ...point, since: seconds };
      const pose = currentSwingPose();
      const isThinking = thinkingRef.current;
      const head = headMotion.update(seconds, {
        thinking: isThinking,
        idle: !pose && seconds - (rested?.since ?? -Infinity) > IDLE_AFTER,
      });
      // Integrating the pace keeps the breath curve continuous while thinking slows it.
      breathPace += ((isThinking ? THINKING_BREATH : 1) - breathPace) * (1 - Math.exp(-2 * elapsed));
      breathClock += elapsed * breathPace;
      const frame = {
        seconds,
        blink: rig.eyes ? blinkScaleAt(seconds) : 1,
        pose,
        breath: rig.breath ? breathAt(breathClock) : 0,
        tilt: head.tilt,
      };
      for (const part of parts) {
        const transform = layerTransform(rig, part.name, frame);
        if (transform !== part.last) {
          part.element.setAttribute('transform', transform);
          part.last = transform;
        }
      }
      if (iris) {
        if (point !== lastPoint) {
          aim = aimAt(point);
          lastPoint = point;
        }
        const target = head.gaze ? head.gaze.map((value, axis) => value * rig.eyes.gazeRange[axis]) : aim;
        const step = 1 - Math.exp(-GAZE_RATE * elapsed);
        gaze = gaze.map((value, axis) => value + (target[axis] - value) * step);
        iris.setAttribute('transform', `translate(${gaze[0].toFixed(2)} ${gaze[1].toFixed(2)})`);
      }
      rafId = requestAnimationFrame(tick);
    };
    const rest = () => {
      for (const part of parts) {
        part.element.removeAttribute('transform');
        part.last = '';
      }
      iris?.removeAttribute('transform');
      gaze = [0, 0];
    };
    const resume = () => {
      cancelAnimationFrame(rafId);
      rafId = null;
      lastFrame = null;
      if (reducedMotion.matches) rest();
      else if (!document.hidden) rafId = requestAnimationFrame(tick);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    reducedMotion.addEventListener('change', resume);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', resume);
      reducedMotion.removeEventListener('change', resume);
      cursor?.release();
      rest();
    };
  }, [svgRef, rig, animated]);
}

function LayeredCharacter({ appearance, mood, preview, animated, onError }) {
  const { manifest, basePath, previewPath, eyeLine } = appearance;
  const svgRef = useRef(null);
  const maskId = `skin-iris-${useId().replace(/[^\w-]/g, '')}`;
  const rig = useMemo(() => layeredRig(manifest, eyeLine), [manifest, eyeLine]);
  const dots = useMemo(() => thoughtDots(manifest), [manifest]);
  const moving = animated && !preview;
  const thinking = moving && mood === 'thinking';
  useLayeredMotion(svgRef, rig, moving, thinking);
  const eyes = moving ? rig.eyes : null;
  // Previews and packages the rig cannot read breathe as one piece.
  const breatheWhole = animated && manifest.animation.breathing && !(moving && rig.breath);
  const href = layer => convertFileSrc(`${basePath}/${layer.file}`);
  const placed = layer => ({ x: layer.origin[0], y: layer.origin[1], width: layer.size[0], height: layer.size[1] });
  return (
    <svg ref={svgRef} className="skin-character" viewBox={skinViewBox(manifest)} preserveAspectRatio="xMidYMax meet" aria-label={manifest.name} role="img">
      {eyes?.irisMask && <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={eyes.irisRegion[0]} y={eyes.irisRegion[1]}
          width={eyes.irisRegion[2]} height={eyes.irisRegion[3]} style={{ maskType: 'alpha' }}>
          {eyes.irisMask.map(layer => <image key={layer.name} href={href(layer)} {...placed(layer)} />)}
        </mask>
      </defs>}
      <g className={breatheWhole ? 'skin-character-breathing' : undefined}>
        {preview ? (
          <image href={convertFileSrc(previewPath)} width={manifest.canvas[0]} height={manifest.canvas[1]} onError={onError} />
        ) : orderedSkinLayers(manifest).map(layer => {
          const part = moving && rig.parts.has(layer.name) ? layer.name : undefined;
          // Head and blink transforms sit on the group so the mask follows the eye; gaze moves only the iris.
          if (layer.name === 'irides' && eyes?.irisMask) {
            return <g key={layer.name} data-part={part} mask={`url(#${maskId})`}>
              <image data-gaze="" href={href(layer)} {...placed(layer)} onError={onError} />
            </g>;
          }
          return <image key={layer.name} href={href(layer)} {...placed(layer)} onError={onError} data-part={part} />;
        })}
      </g>
      {thinking && dots.length > 0 && <g className="skin-thought-dots" aria-hidden="true">
        {dots.map((dot, index) => <circle key={index} {...dot} strokeWidth={dot.r * 0.3} style={{ animationDelay: `${index * 0.2}s` }} />)}
      </g>}
    </svg>
  );
}

/** Whole-body drag swing about the grab point, for every kind of skin including the default. */
function SwingFrame({ children }) {
  const ref = useRef(null);
  useEffect(() => {
    let session = null;
    return subscribeSwing((pose) => {
      const element = ref.current;
      if (!element) return;
      if (!pose) {
        element.style.transform = '';
        session = null;
        return;
      }
      if (pose.session !== session) {
        // Measure the untransformed box once per drag to pin the grab point.
        element.style.transform = '';
        const box = element.getBoundingClientRect();
        element.style.transformOrigin = `${pose.grab.x - box.left}px ${pose.grab.y - box.top}px`;
        session = pose.session;
      }
      element.style.transform = `rotate(${pose.body.toFixed(2)}deg) scale(${(1 - pose.stretch / 2).toFixed(4)}, ${(1 + pose.stretch).toFixed(4)})`;
    });
  }, []);
  return <div ref={ref} className="skin-character-swing">{children}</div>;
}

// Remount on identity changes so stale async responses or broken textures cannot leak to another pet.
export default function CharacterAppearance({ skinId, mood = 'normal', animated = true, preview = false }) {
  return <SwingFrame>
    <SkinAppearance key={skinId || 'default'} skinId={skinId} mood={mood} animated={animated} preview={preview} />
  </SwingFrame>;
}

function SkinAppearance({ skinId, mood, animated, preview }) {
  const [loaded, setLoaded] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(null);
  useEffect(() => onSkinsUpdated(() => {
    setLoaded(null);
    setError(null);
    setRevision(n => n + 1);
  }), []);
  useEffect(() => {
    if (!skinId) return undefined;
    let cancelled = false;
    getSkinAppearance(skinId, mood).then(appearance => {
      if (!cancelled) {
        setError(null);
        // Layered skins load the same package for every mood; keeping the same object keeps their motion clock running.
        setLoaded(previous => JSON.stringify(previous) === JSON.stringify(appearance) ? previous : appearance);
      }
    }).catch(error => {
      console.warn('[Skins] Using default character:', error);
      if (!cancelled) { setLoaded(null); setError(String(error.message || error)); }
    });
    return () => { cancelled = true; };
  }, [skinId, mood, revision]);

  const appearance = loaded;
  if (!skinId) {
    return <PseudoLive2DCharacter mood={mood} animated={animated} />;
  }
  if (error) {
    return <div className="skin-character-status" role="status" title={error}>
      {!preview && <PseudoLive2DCharacter mood={mood} animated={animated} />}
      <span className="skin-character-error">{preview ? 'Skin unavailable' : 'Skin unavailable — showing default'}</span>
    </div>;
  }
  if (!appearance) {
    return <div className="skin-character-status" role="status"><span>Loading skin…</span></div>;
  }
  const onImageError = () => setError('Skin image could not be loaded');
  if (appearance.kind === 'layered') {
    return <div className="skin-character-viewport">
      <LayeredCharacter appearance={appearance} mood={mood} preview={preview} animated={animated} onError={onImageError} />
    </div>;
  }
  return <div className="skin-character-viewport">
    <img className="skin-character skin-character-image" src={convertFileSrc(appearance.path)} alt="Character" draggable={false} onError={onImageError} />
  </div>;
}
