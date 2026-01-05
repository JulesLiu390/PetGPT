import { useState } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import AddAssistantPage from '../pages/AddAssistantPage';
import EditAssistantPage from '../pages/EditAssistantPage';
import AddMcpServerPage from '../pages/AddMcpServerPage';
import EditMcpServerPage from '../pages/EditMcpServerPage';
import ManagementPage from '../pages/ManagementPage';



function App() {
  return (
        <Routes>
          <Route path="/" element={
            <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)] overflow-hidden'>
            <ChatboxBody className='z-10' />
            </div>
          } />
          <Route path="/character" element={<CharacterPage />} />
          <Route path="/addAssistant" element={<AddAssistantPage />} />
          <Route path="/editAssistant" element={<EditAssistantPage />} />
          <Route path="/manage" element={<ManagementPage />} />
          <Route path="/addMcpServer" element={<AddMcpServerPage />} />
          <Route path="/editMcpServer" element={<EditMcpServerPage />} />
        </Routes>
  )
}

export default App