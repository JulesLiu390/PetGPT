import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('inline login card renders QR, loading, and retry states without navigating to settings', async () => {
  const vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const { default: InlineQqLogin } = await vite.ssrLoadModule('/src/components/Social/InlineQqLogin.jsx');
    const render = state => renderToStaticMarkup(React.createElement(InlineQqLogin, {
      state, account: { uin: '123456' }, onRefresh() {},
    }));
    const ready = render({ phase: 'ready', qrcode: 'data:image/png;base64,fixture', error: '' });
    assert.match(ready, /<img[^>]+src="data:image\/png;base64,fixture"/);
    assert.match(ready, /123456/);
    assert.match(ready, /Refresh QR/);
    assert.doesNotMatch(ready, / disabled=""/);
    const loading = render({ phase: 'loading', qrcode: null, error: '' });
    assert.match(loading, /role="status"/);
    assert.match(loading, / disabled=""/);
    const error = render({ phase: 'error', qrcode: null, error: 'fixture connection error' });
    assert.match(error, /role="alert"/);
    assert.match(error, /fixture connection error/);
    assert.doesNotMatch(error, /<img/);
    assert.equal(render({ phase: 'complete' }), '');
    assert.equal(render({ phase: 'idle' }), '');
  } finally {
    await vite.close();
  }
});
