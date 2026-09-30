import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './gen/auth/AuthProvider';
import { RequireAuth } from './components/RequireAuth';
import Landing from './pages/Landing';
import SignIn from './pages/SignIn';
import AuthCallback from './pages/AuthCallback';
import Index from './pages/Index';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/app"
            element={
              <RequireAuth>
                <Index />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
