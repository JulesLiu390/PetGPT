import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatFocusRequestGate,
  normalizeChatWindowActivation,
  shouldApplyComposerFocus,
} from '../chatFocusModel.js';

test('normalizes a native chat activation payload', () => {
  assert.deepEqual(
    normalizeChatWindowActivation({ visible: true, focusRequestId: 7, reason: 'shortcut' }),
    { visible: true, focusRequestId: 7, reason: 'shortcut' },
  );
  assert.deepEqual(
    normalizeChatWindowActivation({ visible: 'true', focusRequestId: '8' }),
    { visible: true, focusRequestId: 8 },
  );
});

test('rejects malformed focus request ids', () => {
  assert.equal(normalizeChatWindowActivation(null).focusRequestId, null);
  assert.equal(normalizeChatWindowActivation({ focusRequestId: -1 }).focusRequestId, null);
  assert.equal(normalizeChatWindowActivation({ focusRequestId: '1.5' }).focusRequestId, null);
  assert.equal(normalizeChatWindowActivation({ focusRequestId: Number.MAX_SAFE_INTEGER + 1 }).focusRequestId, null);
});

test('focus request gate accepts visible requests once and rejects stale events', () => {
  const gate = createChatFocusRequestGate();

  assert.equal(gate.accept({ visible: false, focusRequestId: 1 }), false);
  assert.equal(gate.accept({ visible: true, focusRequestId: 1 }), true);
  assert.equal(gate.accept({ visible: true, focusRequestId: 1 }), false);
  assert.equal(gate.accept({ visible: true, focusRequestId: 0 }), false);
  assert.equal(gate.accept({ visible: true, focusRequestId: 2 }), true);
  assert.equal(gate.getLastAcceptedRequestId(), 2);
});

test('hidden events do not consume their focus request id', () => {
  const gate = createChatFocusRequestGate();

  assert.equal(gate.accept({ visible: false, focusRequestId: 4 }), false);
  assert.equal(gate.accept({ visible: true, focusRequestId: 4 }), true);
});

test('explicit activation can replace stale button focus', () => {
  assert.equal(shouldApplyComposerFocus({
    documentFocused: true,
    explicitRequest: true,
    activeElementSafe: false,
    requestStartedAt: 10,
    lastPointerDownAt: 5,
  }), true);
});

test('pointer interaction after activation prevents focus stealing', () => {
  assert.equal(shouldApplyComposerFocus({
    documentFocused: true,
    explicitRequest: true,
    activeElementSafe: false,
    requestStartedAt: 10,
    lastPointerDownAt: 11,
  }), false);
});

test('implicit focus still respects the active element and document focus', () => {
  assert.equal(shouldApplyComposerFocus({
    documentFocused: true,
    explicitRequest: false,
    activeElementSafe: false,
  }), false);
  assert.equal(shouldApplyComposerFocus({
    documentFocused: false,
    explicitRequest: true,
    activeElementSafe: true,
  }), false);
});
