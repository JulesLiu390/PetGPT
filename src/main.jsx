import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './components/App';
import { HashRouter } from 'react-router-dom';
import { StateProvider } from './context/StateProvider'; // 👈 js文件
import reducer from './context/reducer';                 // 👈 js文件
import { initialState } from './context/initialState';   // 👈 js文件
import ErrorBoundary from './components/ErrorBoundary';
import { I18nProvider } from './i18n/I18nProvider';

// 设置平台 data 属性，用于 CSS 平台特定样式（如 macOS 圆角）
const isMac = navigator.userAgent.includes('Macintosh') || navigator.platform?.startsWith('Mac');
if (isMac) {
  document.documentElement.dataset.platform = 'macos';
} else if (navigator.userAgent.includes('Linux')) {
  document.documentElement.dataset.platform = 'linux';
} else {
  document.documentElement.dataset.platform = 'windows';
}

// 设置窗口类型 data 属性，用于 Linux 上区分需要不透明背景的窗口
const hash = window.location.hash.replace('#', '') || '/';
if (hash.startsWith('/character')) {
  document.documentElement.dataset.window = 'character';
} else if (hash.startsWith('/manage')) {
  document.documentElement.dataset.window = 'manage';
} else if (hash.startsWith('/screenshot')) {
  document.documentElement.dataset.window = 'screenshot';
} else {
  document.documentElement.dataset.window = 'chat';
}

const root = ReactDOM.createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <I18nProvider>
          <StateProvider initialState={initialState} reducer={reducer}>
            <App />
          </StateProvider>
        </I18nProvider>
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
