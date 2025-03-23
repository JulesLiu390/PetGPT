import { useState } from 'react'
import ChatboxBody from './ChatboxBody'
import { HashRouter, Routes, Route } from "react-router-dom";
import Character from './Character';
import AddCharacterPage from './AddCharacterPage';
import SelectCharacterPage from './SelectCharacterPage';



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
          <Route path="/character" element={<Character />} />
          <Route path="/addCharacter" element={<AddCharacterPage />} />
          <Route path="/selectCharacter" element={<SelectCharacterPage />} />
        </Routes>
  )
}

export default App