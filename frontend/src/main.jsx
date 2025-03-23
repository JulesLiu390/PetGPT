import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './components/App';
import { HashRouter } from 'react-router-dom';
import { StateProvider } from './content/StateProvider'; // 👈 js文件
import reducer from './content/reducer';                 // 👈 js文件
import { initialState } from './content/initialState';   // 👈 js文件

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <HashRouter>
      <StateProvider initialState={initialState} reducer={reducer}>
        <App />
      </StateProvider>
    </HashRouter>
  </React.StrictMode>
);