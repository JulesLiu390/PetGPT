import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const reactPlugins = {
  react,
  'react-hooks': reactHooks,
  'react-refresh': reactRefresh,
}

const reactRules = {
  ...reactHooks.configs.recommended.rules,
  // Count JSX usage (incl. member expressions like <motion.div>) as usage,
  // so no-unused-vars doesn't false-positive on lowercase JSX imports.
  'react/jsx-uses-vars': 'error',
  'react-refresh/only-export-components': [
    'warn',
    { allowConstantExport: true },
  ],
}

// Only the app's own TS; the reference checkouts and the Live2D experiment have their own setup.
const TS_FILES = ['src/**/*.{ts,tsx}']

export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: reactPlugins,
    rules: {
      ...js.configs.recommended.rules,
      ...reactRules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  // New code is TypeScript: the same React rules, with typescript-eslint's recommended set.
  ...tseslint.configs.recommended.map(config => ({ ...config, files: TS_FILES })),
  {
    files: TS_FILES,
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: reactPlugins,
    rules: {
      ...reactRules,
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
]
