import { useState, useEffect } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import ManagementPage from '../pages/ManagementPage';
import ScreenshotOverlay from '../pages/ScreenshotOverlay';
import { useStateValue } from '../context/StateProvider';
import { actionType } from '../context/reducer';
import * as tauri from '../utils/tauri';


function App() {
  const [{}, dispatch] = useStateValue();

  useEffect(() => {
    const fetchGlobalData = async () => {
      try {
        const providers = await tauri.getApiProviders();
        if (providers) {
          // 解析 cachedModels 和 hiddenModels JSON 字符串为数组
          const normalizedProviders = providers.map(p => ({
            ...p,
            cachedModels: typeof p.cachedModels === 'string' 
              ? JSON.parse(p.cachedModels) 
              : (p.cachedModels || []),
            hiddenModels: typeof p.hiddenModels === 'string'
              ? JSON.parse(p.hiddenModels)
              : (p.hiddenModels || [])
          }));
          dispatch({
            type: actionType.SET_API_PROVIDERS,
            apiProviders: normalizedProviders
          });
        }
      } catch (error) {
        console.error("Failed to fetch API providers:", error);
      }
    };
    
    fetchGlobalData();
  }, []);

  return (
        <Routes>
          <Route path="/" element={
            <ChatboxBody />
          } />
          <Route path="/character" element={<CharacterPage />} />
          <Route path="/manage" element={<ManagementPage />} />
          <Route path="/screenshot-prompt" element={<ScreenshotOverlay />} />
        </Routes>
  )
}

export default App