import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import Layout from './components/Layout';
import CameraFeeds from './pages/CameraFeeds';
import Tagging from './pages/Tagging';
import Processing from './pages/Processing';
import FileManager from './pages/FileManager';

function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<CameraFeeds />} />
            <Route path="tagging" element={<Tagging />} />
            <Route path="processing" element={<Processing />} />
            <Route path="filemanager" element={<FileManager />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
