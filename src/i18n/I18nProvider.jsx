import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { DomLocalizer } from './domLocalizer.js';
import { I18nContext } from './context.js';
import {
  normalizeLanguage,
  setActiveLanguage,
  translateUiText,
} from './translator.js';
import { useSettings } from '../utils/useSettings.js';

export function I18nProvider({ children }) {
  const { settings, updateSetting } = useSettings();
  const language = normalizeLanguage(settings.language);
  const localizerRef = useRef(null);
  const languageRef = useRef(language);

  languageRef.current = language;
  setActiveLanguage(language);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    if (!localizerRef.current) {
      localizerRef.current = new DomLocalizer(document.body, language);
    } else {
      localizerRef.current.setLanguage(language);
    }
  }, [language]);

  useEffect(() => () => localizerRef.current?.disconnect(), []);

  useEffect(() => {
    const nativeAlert = window.alert.bind(window);
    const nativeConfirm = window.confirm.bind(window);
    window.alert = (message) => nativeAlert(translateUiText(String(message), languageRef.current));
    window.confirm = (message) => nativeConfirm(translateUiText(String(message), languageRef.current));
    return () => {
      window.alert = nativeAlert;
      window.confirm = nativeConfirm;
    };
  }, []);

  const t = useCallback((value) => translateUiText(value, language), [language]);
  const setLanguage = useCallback(
    (next) => updateSetting('language', normalizeLanguage(next)),
    [updateSetting],
  );
  const value = useMemo(() => ({ language, t, setLanguage }), [language, t, setLanguage]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
