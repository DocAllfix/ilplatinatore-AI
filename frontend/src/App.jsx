import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';

import AppLayout from './components/layout/AppLayout';
import { GamificationProvider } from './context/GamificationContext';
import ChatLayout from './components/layout/ChatLayout';
import ProtectedRoute from './components/ProtectedRoute';
import { Navigate } from 'react-router-dom';
import Landing from './pages/Landing';
import Chat from './pages/Chat';
import Profile from './pages/Profile';
import Pricing from './pages/Pricing';
import About from './pages/About';
import Games from './pages/Games';
import Community from './pages/Community';
import ProfileSettings from './pages/ProfileSettings';
import Login from './pages/Login';
import Register from './pages/Register';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-primary/20 border-t-primary rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">Caricamento...</span>
        </div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    }
  }

  return (
    <Routes>
      <Route element={<ChatLayout />}>
        <Route path="/" element={<Chat />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/giochi" element={<Games />} />
        <Route path="/community" element={<Community />} />
        {/* Pagine protette: redirect a /login se non autenticato */}
        <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
          <Route path="/profilo" element={<Profile />} />
          <Route path="/impostazioni" element={<ProfileSettings />} />
        </Route>
      </Route>
      <Route element={<AppLayout />}>
        <Route path="/landing" element={<Landing />} />
        <Route path="/prezzi" element={<Pricing />} />
        <Route path="/chi-siamo" element={<About />} />
        <Route path="/login" element={<Login />} />
        <Route path="/registrati" element={<Register />} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <GamificationProvider>
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
    </GamificationProvider>
  )
}

export default App