export const EMPTY_QR_STATE = Object.freeze({ phase: 'idle', qrcode: null, error: '' });

export function needsInlineLoginQr({ managed, connectorStatus, loginProbe }) {
  return Boolean(managed && connectorStatus?.napcatRunning
    && loginProbe?.sessionReady && !loginProbe.isLogin);
}

/** One QR refresh per logged-out episode, not per status poll. A late response
 * must never revive an old account's code after a switch, login, or unmount. */
export function createPreflightQrController(connector, publish, {
  onLogin = () => {},
  delay = () => new Promise(resolve => setTimeout(resolve, 1000)),
  attempts = 8,
} = {}) {
  let generation = 0;
  let active = false;
  let pending = null;

  const load = () => {
    if (!active) return Promise.resolve();
    if (pending) return pending;
    const current = ++generation;
    const isCurrent = () => active && current === generation;
    publish({ phase: 'loading', qrcode: null, error: '' });
    pending = (async () => {
      // Defer invocation until pending is assigned, including synchronous
      // bridge failures; they must remain retryable like rejected promises.
      await Promise.resolve();
      if (!isCurrent()) return;
      try {
        // Refresh once so an expired cached image is never offered as a new
        // login. Further reads wait for generation without invalidating it.
        let state = await connector.refreshQr();
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (!isCurrent()) return;
          if (state?.isLogin) {
            publish({ phase: 'complete', qrcode: null, error: '' });
            onLogin(state);
            return;
          }
          if (state?.qrcode?.startsWith('data:image/')) {
            publish({ phase: 'ready', qrcode: state.qrcode, error: '' });
            return;
          }
          if (attempt + 1 < attempts) {
            await delay();
            if (!isCurrent()) return;
            state = await connector.getLoginState();
          }
        }
        throw new Error('The QR code is not ready. Refresh it to try again.');
      } catch (error) {
        if (isCurrent()) publish({ phase: 'error', qrcode: null,
          error: error?.message || String(error) });
      } finally {
        if (isCurrent()) pending = null;
      }
    })();
    return pending;
  };

  return {
    start() {
      if (active) return pending || Promise.resolve();
      active = true;
      return load();
    },
    refresh: load,
    reset() {
      active = false;
      generation += 1;
      pending = null;
      publish(EMPTY_QR_STATE);
    },
  };
}
