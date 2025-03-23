import React, { useState } from 'react';
import { MdCancel } from 'react-icons/md';

export const AddCharacterTitleBar = () => {
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
    <div className="draggable w-full h-16 flex justify-between items-center p-3 bg-gray-100">
      <div className="flex-col items-center">
        <MdCancel 
          className="no-drag hover:text-gray-800 text-gray-400 cursor-pointer"
          onClick={handleClose}
        />
        <span className="ml-4 text-lg font-semibold text-gray-800">
          Add Character
        </span>
      </div>

    </div>
  );
};

export default AddCharacterTitleBar;