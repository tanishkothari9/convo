import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { api, ApiError, type Tenant, type TenantUser } from '../lib/api'

interface Session {
  user: TenantUser
  tenant: Tenant
}

interface AuthValue {
  session: Session | null
  loading: boolean
  signIn(email: string, password: string): Promise<void>
  signUp(input: { email: string; password: string; brandName: string }): Promise<void>
  signOut(): Promise<void>
  setTenant(tenant: Tenant): void
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .get<Session>('/auth/me')
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false))
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setSession(await api.post<Session>('/auth/login', { email, password }))
  }, [])

  const signUp = useCallback(
    async (input: { email: string; password: string; brandName: string }) => {
      setSession(await api.post<Session>('/auth/signup', input))
    },
    [],
  )

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } catch (error) {
      // A session that is already gone on the server is still signed out here.
      if (!(error instanceof ApiError)) throw error
    }
    setSession(null)
  }, [])

  const setTenant = useCallback((tenant: Tenant) => {
    setSession((current) => (current ? { ...current, tenant } : current))
  }, [])

  const value = useMemo(
    () => ({ session, loading, signIn, signUp, signOut, setTenant }),
    [session, loading, signIn, signUp, signOut, setTenant],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="boot" aria-busy="true" />
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <>{children}</>
}
