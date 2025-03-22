import React from 'react'

export const ChatboxInputArea = () => {
  return (
    <div className='m-3'>
        <TextBox></TextBox>
    </div>
  )
}

const TextBox = () => {
    return (
        <div className='bg-[rgba(220,220,230,0.9)] border-gray-300 h-24 rounded-3xl border-2'>
          <h1 className='m-3 text-gray-400 text-md'>Message FakeGPT</h1>
        </div>
    )
}

export default ChatboxInputArea;