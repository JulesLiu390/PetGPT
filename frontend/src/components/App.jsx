import { useState } from 'react'
import Chatbox from './ChatboxMain'

function App() {
  return (
    <div className='h-screen rounded-3xl bg-[rgba(245,245,255,0.99)]'>
      <Chatbox className='z-10'></Chatbox>
    </div>
  )
}

export default App
