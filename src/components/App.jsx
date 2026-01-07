import { useState, useEffect } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import ManagementPage from '../pages/ManagementPage';
import { useStateValue } from '../context/StateProvider';
import { actionType } from '../context/reducer';
import * as bridge from '../utils/bridge';


function App() {
  const [{}, dispatch] = useStateValue();

  useEffect(() => {
    const fetchGlobalData = async () => {
      try {
        const providers = await bridge.getApiProviders();
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
            <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)] overflow-hidden'>
            <ChatboxBody className='z-10' />
            </div>
          } />
          <Route path="/character" element={<CharacterPage />} />
          <Route path="/manage" element={<ManagementPage />} />
        </Routes>
  )
}

export default App