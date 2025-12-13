import React, { useState } from 'react';
import { MdCancel } from 'react-icons/md';


export const AddModelTitleBar = () => {
  const [apiSelection, setApiSelection] = useState('openai');
  const [modelName, setModelName] = useState('');

  const handleClose = () => {
    window.electron?.changeAddCharacterWindow();
  };

  const handleApiChange = (e) => {
    setApiSelection(e.target.value);
  };

  const handleModelNameChange = (e) => {
    setModelName(e.target.value);
  };

  return (
    <div
    className='draggable w-full h-12 flex justify-start p-3 bg-[rgba(255,255,255,0.8)]'
    >
      <MdCancel className='no-drag hover:text-gray-800 text-gray-400 cursor-pointer'
      onClick={handleClose}
      ></MdCancel>
            <div className='h-full w-full flex items-center justify-center'>
      <h2 className='select-none'>ADD MODEL</h2>
      </div>
    </div>
  );
};

export default AddModelTitleBar;