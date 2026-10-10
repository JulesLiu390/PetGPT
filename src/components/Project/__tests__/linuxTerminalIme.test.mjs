import test from 'node:test';
import assert from 'node:assert/strict';
import { installLinuxTerminalImeGuard } from '../linuxTerminalIme.js';

function fixture() {
  // The ancestor sees capture events before xterm's textarea listener.
  const handlers = new Map();
  const parent = {
    addEventListener(type, handler, capture) {
      assert.equal(capture, true);
      handlers.set(type, handler);
    },
    removeEventListener(type, handler, capture) {
      assert.equal(capture, true);
      assert.equal(handlers.get(type), handler);
      handlers.delete(type);
    },
  };
  const textarea = { parentElement: parent };
  const guard = installLinuxTerminalImeGuard({ textarea }, 'linux');
  const dispatch = (type, props = {}) => {
    let stopped = false;
    handlers.get(type)?.({
      target: textarea,
      stopImmediatePropagation() { stopped = true; },
      preventDefault() { assert.fail('The native textarea edit must remain enabled'); },
      ...props,
    });
    return stopped;
  };
  return { dispatch, guard, handlers };
}

test('Linux orphan compositionend leaves each commit to the 229 fallback, including identical commits', () => {
  const { dispatch } = fixture();
  for (const data of ['你好', '你好', '哈哈', '😀']) {
    assert.equal(dispatch('keydown', { keyCode: 229 }), false);
    assert.equal(dispatch('compositionend', { data }), true);
  }
});

test('normal composition and cancellation reach xterm unchanged', () => {
  const { dispatch } = fixture();
  for (const data of ['你好', '你好', '']) {
    dispatch('keydown', { keyCode: 229 });
    dispatch('compositionstart');
    dispatch('keydown', { keyCode: 229 });
    assert.equal(dispatch('compositionend', { data }), false);
  }
});

test('an end without a 229 fallback is not swallowed', () => {
  const { dispatch } = fixture();
  assert.equal(dispatch('compositionend', { data: '你好' }), false);
  dispatch('keydown', { keyCode: 229 });
  dispatch('compositionend', { data: '你好' });
  assert.equal(dispatch('compositionend', { data: '你好' }), false);
});

test('ordinary keys and blur clear a stale fallback', () => {
  const { dispatch } = fixture();
  for (const keyCode of [13, 27, 65, 8]) {
    dispatch('keydown', { keyCode: 229 });
    assert.equal(dispatch('keydown', { keyCode }), false);
    assert.equal(dispatch('compositionend', { data: '你好' }), false);
  }
  dispatch('keydown', { keyCode: 229 });
  dispatch('blur');
  assert.equal(dispatch('compositionend', { data: '你好' }), false);
});

test('events from sibling elements cannot change this terminal composition', () => {
  const { dispatch } = fixture();
  dispatch('keydown', { keyCode: 229, target: {} });
  assert.equal(dispatch('compositionend', { data: '你好' }), false);
  dispatch('keydown', { keyCode: 229 });
  dispatch('compositionstart', { target: {} });
  assert.equal(dispatch('compositionend', { data: '你好' }), true);
});

test('disposal removes every listener before the terminal is destroyed', () => {
  const { dispatch, guard, handlers } = fixture();
  dispatch('keydown', { keyCode: 229 });
  guard.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(dispatch('compositionend', { data: '你好' }), false);
});

test('macOS and Windows never inspect or attach to the terminal', () => {
  const term = { get textarea() { assert.fail('Non-Linux terminal must stay untouched'); } };
  for (const platform of ['macos', 'windows', undefined]) {
    installLinuxTerminalImeGuard(term, platform).dispose();
  }
});
