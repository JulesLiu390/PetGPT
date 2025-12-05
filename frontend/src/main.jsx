import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './components/App';
import { HashRouter } from 'react-router-dom';
import { StateProvider } from './context/StateProvider'; // 👈 js文件
import reducer from './context/reducer';                 // 👈 js文件
import { initialState } from './context/initialState';   // 👈 js文件
import ErrorBoundary from './components/ErrorBoundary';

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <StateProvider initialState={initialState} reducer={reducer}>
          <App />
        </StateProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);