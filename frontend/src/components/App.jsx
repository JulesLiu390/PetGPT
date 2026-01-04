import { useState } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import AddModelPage from '../pages/AddModelPage';
import AddAssistantPage from '../pages/AddAssistantPage';
import EditAssistantPage from '../pages/EditAssistantPage';
import EditModelPage from '../pages/EditModelPage';
import SelectCharacterPage from '../pages/SelectCharacterPage';
import SettingsPage from '../pages/SettingsPage';
import McpPage from '../pages/McpPage';
import AddMcpServerPage from '../pages/AddMcpServerPage';
import EditMcpServerPage from '../pages/EditMcpServerPage';



function App() {
  return (
    // <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)]'>
      
    // </div>
        <Routes>
          <Route path="/" element={
            <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)] overflow-hidden'>
            <ChatboxBody className='z-10' />
            </div>
          } />
          <Route path="/character" element={<CharacterPage />} />
          <Route path="/addCharacter" element={<AddModelPage />} />
          <Route path="/addAssistant" element={<AddAssistantPage />} />
          <Route path="/editAssistant" element={<EditAssistantPage />} />
          <Route path="/editModel" element={<EditModelPage />} />
          <Route path="/selectCharacter" element={<SelectCharacterPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/addMcpServer" element={<AddMcpServerPage />} />
          <Route path="/editMcpServer" element={<EditMcpServerPage />} />
        </Routes>
  )
}

export default App