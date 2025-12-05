import { useState } from 'react'
import ChatboxBody from './Chat/ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import CharacterPage from '../pages/CharacterPage';
import AddCharacterPage from '../pages/AddCharacterPage';
import SelectCharacterPage from '../pages/SelectCharacterPage';
import SettingsPage from '../pages/SettingsPage';



function App() {
  return (
    // <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)]'>
      
    // </div>
        <Routes>
          <Route path="/" element={
            <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)]'>
            <ChatboxBody className='z-10' />
            </div>
          } />
          <Route path="/character" element={<CharacterPage />} />
          <Route path="/addCharacter" element={<AddCharacterPage />} />
          <Route path="/selectCharacter" element={<SelectCharacterPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
  )
}

export default App