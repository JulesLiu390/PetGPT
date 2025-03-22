import { useState } from 'react'
import ChatboxBody from './ChatboxBody'

function App() {
  return (
    <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)]'>
      <ChatboxBody className='z-10'></ChatboxBody>
    </div>
  )
}

export default App