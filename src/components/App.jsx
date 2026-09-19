import { useEffect, lazy, Suspense } from 'react'
import { HashRouter, Routes, Route } from "react-router-dom";
import { useDispatch } from '../context/StateProvider';
import { actionType } from '../context/reducer';
import * as tauri from '../utils/tauri';
import { normalizeApiProviders } from '../utils/apiProviders';

/**
 * 每个路由单独切一个 chunk。
 *
 * 五个窗口（chat / character / manage / social / screenshot-prompt）各自是一个
 * WebView 进程，但加载的是同一个入口。静态 import 的话，260×390 的桌宠窗口也要
 * 下载并解析 ManagementPage(5080 行)、SocialPage(3020 行)、CodeMirror、xterm、
 * html2canvas —— 它一个都用不上。拆开之后各窗口只解析自己那条路由。
 *
 * ChatboxBody 也一起拆：它只服务 "/" 这一个窗口，却是全项目最大的组件之一。
 */
const ChatboxBody = lazy(() => import('./Chat/ChatboxBody'));
const CharacterPage = lazy(() => import('../pages/CharacterPage'));
const ManagementPage = lazy(() => import('../pages/ManagementPage'));
const SocialPage = lazy(() => import('../pages/SocialPage'));
const ScreenshotOverlay = lazy(() => import('../pages/ScreenshotOverlay'));

/**
 * 路由切换时的占位。
 *
 * 刻意是全透明的空块而不是 spinner：这些窗口本身是透明无边框的，塞一个可见的
 * 加载指示会在桌宠窗口上凭空闪一个方块出来。chunk 是本地磁盘读取，这段空窗
 * 只有几十毫秒。
 */
const RouteFallback = () => <div className="h-full w-full" />;

function App() {
  // 只要 dispatch：用 useDispatch 而不是 useStateValue，这样任何状态变化
  // （尤其是流式回复）都不会把 App 连同整棵路由树重渲染一遍。
  const dispatch = useDispatch();

  useEffect(() => {
    const fetchGlobalData = async () => {
      try {
        const providers = await tauri.getApiProviders();
        if (providers) {
          dispatch({
            type: actionType.SET_API_PROVIDERS,
            apiProviders: normalizeApiProviders(providers)
          });
        }
      } catch (error) {
        console.error("Failed to fetch API providers:", error);
      }
    };
    
    fetchGlobalData();
  }, []);

  return (
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={
              <ChatboxBody />
            } />
            <Route path="/character" element={<CharacterPage />} />
            <Route path="/manage" element={<ManagementPage />} />
            <Route path="/social" element={<SocialPage />} />
            <Route path="/screenshot-prompt" element={<ScreenshotOverlay />} />
          </Routes>
        </Suspense>
  )
}

export default App
