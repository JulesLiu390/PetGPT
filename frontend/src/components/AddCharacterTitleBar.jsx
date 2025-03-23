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
      <div className="no-drag flex items-center space-x-4">
        <div className="flex items-center">
          <label htmlFor="apiSelect" className="text-gray-700 mr-2">
            API:
          </label>
          <select 
            id="apiSelect"
            value={apiSelection}
            onChange={handleApiChange}
            className="p-1 border border-gray-300 rounded"
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </select>
        </div>
        <div className="flex items-center">
          <label htmlFor="modelName" className="text-gray-700 mr-2">
            Model Name:
          </label>
          <input 
            id="modelName"
            type="text"
            value={modelName}
            onChange={handleModelNameChange}
            placeholder="Enter model name"
            className="p-1 border border-gray-300 rounded"
          />
        </div>
      </div>
    </div>
  );
};

export default AddCharacterTitleBar;