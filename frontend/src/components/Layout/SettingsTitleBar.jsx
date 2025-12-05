import React from 'react'
import { MdCancel } from 'react-icons/md';

export const SettingsTitleBar = () => {

  const handleClose = () => {
    window.electron?.changeSettingsWindow();
  };
  return (
    <div
    className='draggable w-full h-16 flex justify-start p-3'
    >
      <MdCancel className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer'
      onClick={handleClose}
      ></MdCancel>
      <div className='h-full w-full flex items-center justify-center'>
      <h2>SETTINGS</h2>
      </div>
      
    </div>
  );
}

export default SettingsTitleBar;