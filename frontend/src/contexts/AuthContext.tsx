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
  confirmSignIn,
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

// -----------------------------------------------------------------
// Dev bypass — skip Cognito entirely in local development
// Set VITE_AUTH_BYPASS=true (and optionally VITE_AUTH_BYPASS_ROLE) in frontend/.env
// -----------------------------------------------------------------

const DEV_BYPASS = import.meta.env.VITE_AUTH_BYPASS === 'true';
const DEV_ROLE   = (import.meta.env.VITE_AUTH_BYPASS_ROLE ?? 'administrator') as UserRole;

const DEV_USER: AuthenticatedUser = {
  cognitoSub: 'dev-bypass-sub',
  email:      'dev@omnimap.local',
  role:       DEV_ROLE,
  mfaEnabled: false,
};

interface AuthContextValue {
  user:               AuthenticatedUser | null;
  loading:            boolean;
  /** Returns the Cognito nextStep string, e.g. 'DONE' or 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' */
  login:              (email: string, password: string) => Promise<string>;
  /** Called after Cognito forces a new password on first sign-in */
  completeNewPassword:(newPassword: string) => Promise<void>;
  logout:             () => Promise<void>;
  getToken:           () => Promise<string>;
}

// -----------------------------------------------------------------
// Context
// -----------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]       = useState<AuthenticatedUser | null>(DEV_BYPASS ? DEV_USER : null);
  const [loading, setLoading] = useState(!DEV_BYPASS);

  // Resolve user from Amplify session (skipped in dev bypass mode)
  const resolveUser = useCallback(async () => {
    if (DEV_BYPASS) return;
    try {
      const cognitoUser: AuthUser = await getCurrentUser();
      const session  = await fetchAuthSession();
      const idToken  = session.tokens?.idToken;
      if (!idToken) throw new Error('No id token');

      const payload = idToken.payload;
      setUser({
        cognitoSub: cognitoUser.userId,
        email:      (payload.email as string) ?? '',
        role:       ((payload['custom:Role'] ?? payload['custom:role']) as UserRole) ?? 'reviewer',
        mfaEnabled: payload['custom:mfa_enabled'] === 'true',
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { resolveUser(); }, [resolveUser]);

  const login = useCallback(async (email: string, password: string): Promise<string> => {
    if (DEV_BYPASS) return 'DONE';
    const { nextStep } = await signIn({ username: email.toLowerCase(), password });
    if (nextStep.signInStep === 'DONE') {
      await resolveUser();
    }
    return nextStep.signInStep;
  }, [resolveUser]);

  const completeNewPassword = useCallback(async (newPassword: string): Promise<void> => {
    if (DEV_BYPASS) return;
    await confirmSignIn({ challengeResponse: newPassword });
    await resolveUser();
  }, [resolveUser]);

  const logout = useCallback(async () => {
    if (DEV_BYPASS) return;
    await signOut();
    setUser(null);
  }, []);

  const getToken = useCallback(async (): Promise<string> => {
    if (DEV_BYPASS) return 'dev-bypass-token';
    const session = await fetchAuthSession();
    const token   = session.tokens?.idToken?.toString();
    if (!token) throw new Error('Not authenticated');
    return token;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, completeNewPassword, logout, getToken }}>
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
