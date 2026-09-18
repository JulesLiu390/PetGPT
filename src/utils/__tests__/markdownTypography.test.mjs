import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MARKDOWN_TYPOGRAPHY,
  getMarkdownTypographyCssVariables,
  getMarkdownTypographyStyle,
  normalizeMarkdownTypography,
} from '../markdownTypography.js';

test('Markdown typography uses stable defaults for legacy settings', () => {
  assert.deepEqual(normalizeMarkdownTypography({}), DEFAULT_MARKDOWN_TYPOGRAPHY);
});

test('Markdown typography accepts numeric settings stored as strings', () => {
  assert.deepEqual(normalizeMarkdownTypography({
    markdownFontSize: '18',
    markdownLetterSpacing: '0.6',
    markdownLineHeight: '1.65',
  }), {
    markdownFontSize: 18,
    markdownLetterSpacing: 0.6,
    markdownLineHeight: 1.65,
  });
});

test('Markdown typography rejects invalid values and clamps extremes', () => {
  assert.deepEqual(normalizeMarkdownTypography({
    markdownFontSize: 100,
    markdownLetterSpacing: -10,
    markdownLineHeight: 'not-a-number',
  }), {
    markdownFontSize: 24,
    markdownLetterSpacing: -0.5,
    markdownLineHeight: 1.3,
  });
});

test('Markdown typography exposes safe inline and CSS variable styles', () => {
  const settings = {
    markdownFontSize: 17,
    markdownLetterSpacing: 0.4,
    markdownLineHeight: 1.55,
  };
  assert.deepEqual(getMarkdownTypographyStyle(settings), {
    fontSize: '17px',
    letterSpacing: '0.4px',
    lineHeight: 1.55,
  });
  assert.deepEqual(getMarkdownTypographyCssVariables(settings), {
    '--markdown-font-size': '17px',
    '--markdown-letter-spacing': '0.4px',
    '--markdown-line-height': 1.55,
  });
});

