/**
 * Pure routing decision for protected routes.
 *
 * Kept free of React so the guard's behaviour can be tested directly: only a resolved,
 * authenticated session may reach the generator; a pending session shows a loading state and
 * everything else is sent to sign-in.
 */
import type { AuthStatus } from './AuthProvider';

export type AccessDecision = 'loading' | 'allowed' | 'sign-in';

export function accessDecision(status: AuthStatus): AccessDecision {
  if (status === 'checking') return 'loading';
  if (status === 'authenticated') return 'allowed';
  return 'sign-in';
}
