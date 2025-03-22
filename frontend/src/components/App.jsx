import { useState } from 'react'
import ChatboxBody from './ChatboxBody'
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Character from './Character';



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
        </Routes>
  )
}

export default App