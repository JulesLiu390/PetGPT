import { useState, useEffect } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import ManagementPage from '../pages/ManagementPage';
import SocialPage from '../pages/SocialPage';
import ScreenshotOverlay from '../pages/ScreenshotOverlay';
import { useStateValue } from '../context/StateProvider';
import { actionType } from '../context/reducer';
import * as tauri from '../utils/tauri';
import { normalizeApiProviders } from '../utils/apiProviders';


function App() {
  const [{}, dispatch] = useStateValue();

  useEffect(() => {
    const fetchGlobalData = async () => {
      try {
        const providers = await tauri.getApiProviders();
        if (providers) {
          dispatch({
            type: actionType.SET_API_PROVIDERS,
            apiProviders: normalizeApiProviders(providers)
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
          <Route path="/social" element={<SocialPage />} />
          <Route path="/screenshot-prompt" element={<ScreenshotOverlay />} />
        </Routes>
  )
}

export default App
