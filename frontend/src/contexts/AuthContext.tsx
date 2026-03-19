// OmniMap — Auth Context
// Wraps AWS Amplify Cognito. Provides the current user (email, role, id)
// and token-retrieval helper used by the API client.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
  type AuthUser,
} from 'aws-amplify/auth';

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export type UserRole = 'administrator' | 'reviewer' | 'adjudicator' | 'auditor';

export interface AuthenticatedUser {
  cognitoSub: string;
  email:      string;
  role:       UserRole;
  mfaEnabled: boolean;
}

interface AuthContextValue {
  user:      AuthenticatedUser | null;
  loading:   boolean;
  login:     (email: string, password: string) => Promise<void>;
  logout:    () => Promise<void>;
  getToken:  () => Promise<string>;
}

// -----------------------------------------------------------------
// Context
// -----------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]       = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve user from Amplify session
  const resolveUser = useCallback(async () => {
    try {
      const cognitoUser: AuthUser = await getCurrentUser();
      const session  = await fetchAuthSession();
      const idToken  = session.tokens?.idToken;
      if (!idToken) throw new Error('No id token');

      const payload = idToken.payload;
      setUser({
        cognitoSub: cognitoUser.userId,
        email:      (payload.email as string) ?? '',
        role:       (payload['custom:role'] as UserRole) ?? 'reviewer',
        mfaEnabled: payload['custom:mfa_enabled'] === 'true',
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { resolveUser(); }, [resolveUser]);

  const login = useCallback(async (email: string, password: string) => {
    await signIn({ username: email, password });
    await resolveUser();
  }, [resolveUser]);

  const logout = useCallback(async () => {
    await signOut();
    setUser(null);
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    const session = await fetchAuthSession();
    const token   = session.tokens?.accessToken?.toString();
    if (!token) throw new Error('Not authenticated');
    return token;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useRole(...roles: UserRole[]): boolean {
  const { user } = useAuth();
  return user !== null && roles.includes(user.role);
}
