/**
 * Authentication state for the whole app.
 *
 * The session is restored from the stored platform token on every page load, so a refresh keeps the
 * user signed in without keeping credentials in memory. Account creation belongs to the platform
 * identity provider, so this provider exposes a redirect-based sign-in instead of a credential form.
 */
import { createClient } from '@metagptx/web-sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAuthGateway, type AuthGateway, type AuthOutcome } from './gateway';
import type { SignedInUser } from './session';

export type AuthStatus = 'checking' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: SignedInUser | null;
  startSignIn: AuthGateway['startSignIn'];
  signOut: () => Promise<void>;
  completeCallback: () => Promise<AuthOutcome>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, client }: { children: ReactNode; client?: AuthGateway }) {
  const gateway = useMemo(() => client ?? createAuthGateway(createClient().auth), [client]);
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<SignedInUser | null>(null);

  useEffect(() => {
    let active = true;
    void gateway.restoreSession().then((outcome) => {
      if (!active) return;
      if (outcome.status === 'authenticated') {
        setUser(outcome.user);
        setStatus('authenticated');
      } else {
        setUser(null);
        setStatus('anonymous');
      }
    });
    return () => {
      active = false;
    };
  }, [gateway]);

  const signOut = useCallback(async () => {
    await gateway.signOut();
    setUser(null);
    setStatus('anonymous');
  }, [gateway]);

  const completeCallback = useCallback(async () => {
    const outcome = await gateway.completeCallback();
    if (outcome.status === 'authenticated') {
      setUser(outcome.user);
      setStatus('authenticated');
    } else {
      setUser(null);
      setStatus('anonymous');
    }
    return outcome;
  }, [gateway]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, startSignIn: gateway.startSignIn, signOut, completeCallback }),
    [status, user, gateway, signOut, completeCallback],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
