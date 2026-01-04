/**
 * Settings React Hook
 * 
 * 提供设置的实时同步功能
 * 当设置在任何窗口中更新时，所有使用此 hook 的组件都会自动更新
 */

import { useState, useEffect, useCallback } from 'react';
import bridge from './bridge';

/**
 * 用于管理设置状态的 React Hook
 * 
 * @returns {Object} 设置状态和方法
 */
export const useSettings = () => {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // 加载所有设置
  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const data = await bridge.getSettings();
      console.log('[useSettings] Loaded settings:', Object.keys(data));
      setSettings(data);
      setError(null);
    } catch (err) {
      console.error('[useSettings] Failed to load settings:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 更新单个设置
  const updateSetting = useCallback(async (key, value) => {
    try {
      await bridge.updateSettings({ [key]: value });
      // 本地立即更新（事件监听器也会更新，但这样更快）
      setSettings(prev => ({ ...prev, [key]: value }));
    } catch (err) {
      console.error('[useSettings] Failed to update setting:', err);
      throw err;
    }
  }, []);

  // 批量更新设置
  const updateSettings = useCallback(async (updates) => {
    try {
      await bridge.updateSettings(updates);
      // 本地立即更新
      setSettings(prev => ({ ...prev, ...updates }));
    } catch (err) {
      console.error('[useSettings] Failed to update settings:', err);
      throw err;
    }
  }, []);

  // 获取单个设置值
  const getSetting = useCallback((key, defaultValue = null) => {
    return settings[key] ?? defaultValue;
  }, [settings]);

  // 初始加载
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // 监听设置更新事件
  useEffect(() => {
    const cleanup = bridge.onSettingsUpdated((payload) => {
      console.log('[useSettings] Settings updated:', payload);
      if (payload?.key && payload?.value !== undefined) {
        // 单个设置更新
        try {
          const parsedValue = JSON.parse(payload.value);
          setSettings(prev => ({ ...prev, [payload.key]: parsedValue }));
        } catch {
          setSettings(prev => ({ ...prev, [payload.key]: payload.value }));
        }
      } else {
        // 重新加载所有设置
        loadSettings();
      }
    });

    return cleanup;
  }, [loadSettings]);

  return {
    settings,
    loading,
    error,
    getSetting,
    updateSetting,
    updateSettings,
    refresh: loadSettings,
  };
};

export default useSettings;
