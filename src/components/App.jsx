import { useState } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
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
          <Route path="/manage" element={<ManagementPage />} />
        </Routes>
  )
}

export default App