import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import CameraFeeds from './pages/CameraFeeds';
import Conversion from './pages/Conversion';
import Tagging from './pages/Tagging';
import Processing from './pages/Processing';
import FileManager from './pages/FileManager';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <CameraFeeds /> },
      { path: 'conversion', element: <Conversion /> },
      { path: 'tagging', element: <Tagging /> },
      { path: 'processing', element: <Processing /> },
      { path: 'filemanager', element: <FileManager /> },
    ],
  },
]);

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App;
