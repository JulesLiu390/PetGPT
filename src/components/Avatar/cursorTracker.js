import { getCursorInWindow } from '../../utils/tauri';

// One cursor source per window, shared by every animated character in it. The backend reports the
// desktop-wide cursor, so the eyes follow it outside the small pet window. If that is unavailable
// (plain browser, unsupported platform), pointer events inside the window are used instead.
const POLL_MS = 80;
let subscribers = 0;
let timer = null;
let point = null;
let desktopCursor = true;

const onPointerMove = (event) => { point = { x: event.clientX, y: event.clientY }; };
const onPointerLeave = () => { if (!desktopCursor) point = null; };

async function poll() {
  if (document.hidden) return;
  try {
    const [x, y] = await getCursorInWindow();
    if (timer) point = { x, y };
  } catch {
    desktopCursor = false;
    clearInterval(timer);
    timer = null;
  }
}

/** Returns a getter for the latest cursor point in client coordinates (or null), and a release function. */
export function watchCursor() {
  if (subscribers++ === 0) {
    window.addEventListener('pointermove', onPointerMove);
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    if (desktopCursor) {
      timer = setInterval(poll, POLL_MS);
      poll();
    }
  }
  let released = false;
  return {
    current: () => point,
    release() {
      if (released) return;
      released = true;
      if (--subscribers > 0) return;
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('pointerleave', onPointerLeave);
      clearInterval(timer);
      timer = null;
      point = null;
    },
  };
}
