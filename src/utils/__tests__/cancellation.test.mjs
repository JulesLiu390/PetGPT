import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAbortError,
  isAbortError,
  throwIfAborted,
} from '../cancellation.js';

test('cancellation helpers preserve a typed AbortError contract', () => {
  const error = createAbortError();
  assert.equal(error.name, 'AbortError');
  assert.equal(isAbortError(error), true);
  assert.equal(isAbortError(new Error('LLM stream cancelled by user')), true);
});

test('throwIfAborted only throws for an aborted signal', () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfAborted(controller.signal));
  controller.abort();
  assert.throws(
    () => throwIfAborted(controller.signal),
    error => error?.name === 'AbortError',
  );
});
