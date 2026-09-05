import { createContext, useContext } from 'react';
import { DEFAULT_LANGUAGE } from './translator.js';

export const I18nContext = createContext({
  language: DEFAULT_LANGUAGE,
  t: (value) => value,
  setLanguage: async () => {},
});

export const useI18n = () => useContext(I18nContext);
