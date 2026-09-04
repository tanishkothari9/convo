import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './styles/base.css'
import './components/ui.css'
import './styles/landing.css'
import './dashboard/dashboard.css'
import './chat/chat.css'
import { AuthProvider, RequireAuth } from './dashboard/auth'
import { SignIn } from './dashboard/SignIn'
import { SignUp } from './dashboard/SignUp'
import { DashboardLayout } from './dashboard/Layout'
import { Overview } from './dashboard/Overview'
import { Catalog } from './dashboard/Catalog'
import { Providers } from './dashboard/Providers'
import { AuditLog } from './dashboard/AuditLog'
import { Settings } from './dashboard/Settings'
import { ChatPage } from './chat/ChatPage'
import { Landing } from './Landing'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route path="/chat/:slug" element={<ChatPage />} />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Overview />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="provider" element={<Providers />} />
            <Route path="audit" element={<AuditLog />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
