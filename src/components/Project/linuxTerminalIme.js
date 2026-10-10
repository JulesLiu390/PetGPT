/**
 * WebKitGTK + Fcitx with preedit disabled can emit this sequence:
 * keydown(229) -> input(insertFromComposition) -> compositionend,
 * without a compositionstart. xterm 6 already sends the textarea delta via
 * its keydown(229) fallback. Its orphan compositionend handler then sends old
 * textarea content again, using a composition start offset that was never set.
 *
 * Let the fallback own that commit. Observe on the textarea's parent in the
 * capture phase, before xterm's listeners. Normal compositions, plain keys and
 * repeated text are untouched; no content-based or time-based deduplication.
 */
export function installLinuxTerminalImeGuard(term, platform) {
  const noop = { dispose() {} };
  if (platform !== 'linux') return noop;
  const textarea = term.textarea;
  const parent = textarea?.parentElement;
  if (!parent) return noop;

  let composing = false;
  let fallbackCommit = false;
  const onKeyDown = (event) => {
    if (event.target !== textarea) return;
    fallbackCommit = !composing && event.keyCode === 229;
  };
  const onCompositionStart = (event) => {
    if (event.target !== textarea) return;
    composing = true;
    fallbackCommit = false;
  };
  const onCompositionEnd = (event) => {
    if (event.target !== textarea) return;
    if (!composing && fallbackCommit) {
      // Do not prevent the browser's edit or submit text ourselves: xterm's
      // queued textarea-delta handler is responsible for the single commit.
      event.stopImmediatePropagation();
    }
    composing = false;
    fallbackCommit = false;
  };
  const onBlur = (event) => {
    if (event.target !== textarea) return;
    composing = false;
    fallbackCommit = false;
  };
  const listeners = [
    ['keydown', onKeyDown],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
    ['blur', onBlur],
  ];
  for (const [type, handler] of listeners) parent.addEventListener(type, handler, true);
  return {
    dispose() {
      for (const [type, handler] of listeners) parent.removeEventListener(type, handler, true);
    },
  };
}
