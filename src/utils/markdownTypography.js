export const MARKDOWN_TYPOGRAPHY_LIMITS = Object.freeze({
  fontSize: Object.freeze({ min: 12, max: 24, step: 1 }),
  letterSpacing: Object.freeze({ min: -0.5, max: 3, step: 0.1 }),
  lineHeight: Object.freeze({ min: 1.1, max: 2.2, step: 0.05 }),
});

export const DEFAULT_MARKDOWN_TYPOGRAPHY = Object.freeze({
  markdownFontSize: 14,
  markdownLetterSpacing: 0,
  markdownLineHeight: 1.3,
});

const clampNumber = (value, fallback, { min, max }) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

export const normalizeMarkdownTypography = (settings = {}) => ({
  markdownFontSize: clampNumber(
    settings.markdownFontSize,
    DEFAULT_MARKDOWN_TYPOGRAPHY.markdownFontSize,
    MARKDOWN_TYPOGRAPHY_LIMITS.fontSize,
  ),
  markdownLetterSpacing: clampNumber(
    settings.markdownLetterSpacing,
    DEFAULT_MARKDOWN_TYPOGRAPHY.markdownLetterSpacing,
    MARKDOWN_TYPOGRAPHY_LIMITS.letterSpacing,
  ),
  markdownLineHeight: clampNumber(
    settings.markdownLineHeight,
    DEFAULT_MARKDOWN_TYPOGRAPHY.markdownLineHeight,
    MARKDOWN_TYPOGRAPHY_LIMITS.lineHeight,
  ),
});

export const getMarkdownTypographyStyle = (settings = {}) => {
  const typography = normalizeMarkdownTypography(settings);
  return {
    fontSize: `${typography.markdownFontSize}px`,
    letterSpacing: `${typography.markdownLetterSpacing}px`,
    lineHeight: typography.markdownLineHeight,
  };
};

export const getMarkdownTypographyCssVariables = (settings = {}) => {
  const typography = normalizeMarkdownTypography(settings);
  return {
    '--markdown-font-size': `${typography.markdownFontSize}px`,
    '--markdown-letter-spacing': `${typography.markdownLetterSpacing}px`,
    '--markdown-line-height': typography.markdownLineHeight,
  };
};

