/**
 * Authentication gateway.
 *
 * Sign-in is owned entirely by the platform identity provider through the `@metagptx/web-sdk` auth
 * module: `toLogin()` starts the OIDC redirect, `login()` completes it and stores the bearer token,
 * `me()` reads the signed-in profile and `logout()` ends the provider session.
 *
 * This module deliberately adds no credential handling of its own — no password form, no
 * registration call and no password storage — so an application-managed password can never exist.
 * Every provider failure is mapped onto one generic message, so a caller can never learn whether a
 * given account exists, and no raw provider diagnostic is ever surfaced or persisted.
 */
import { clearSession, readToken, readUser, writeToken, writeUser, type SignedInUser } from './session';

/** Single message used for failed, aborted or cancelled sign-in attempts. */
export const GENERIC_AUTH_ERROR = 'Sign-in could not be completed. Please try again.';
/** Explains who owns account creation, shown next to the sign-in entry point. */
export const MANAGED_ACCOUNT_NOTE =
  'Accounts are created by the platform identity provider. This app has no separate sign-up form.';

export interface AuthClient {
  /** Reads the platform token from the callback URL and stores it for API calls. */
  login(): Promise<unknown>;
  /** Returns the signed-in profile, or rejects when there is no valid session. */
  me(): Promise<unknown>;
  /** Ends the provider session. */
  logout(): Promise<unknown>;
  /** Redirects the browser to the platform sign-in page. */
  toLogin(): void;
}

export type AuthOutcome =
  | { status: 'authenticated'; user: SignedInUser }
  | { status: 'redirecting' }
  | { status: 'anonymous'; message?: string };

export interface AuthGatewayOptions {
  storage?: Storage;
}

const profileOf = (value: unknown): { id: string; email: string } | null => {
  const body = (value as { data?: unknown })?.data ?? value;
  if (!body || typeof body !== 'object') return null;
  const record = body as { id?: unknown; email?: unknown };
  if (typeof record.id !== 'string' || !record.id) return null;
  return { id: record.id, email: typeof record.email === 'string' ? record.email : '' };
};

const tokenOf = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  const body = (value as { data?: unknown })?.data ?? value;
  if (!body || typeof body !== 'object') return null;
  const record = body as { token?: unknown };
  return typeof record.token === 'string' && record.token ? record.token : null;
};

const statusOf = (error: unknown): number | null => {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  return typeof status === 'number' ? status : null;
};

export function createAuthGateway(client: AuthClient, options: AuthGatewayOptions = {}) {
  const storage = options.storage;

  /** A signed-in session must be backed by a token; the user's own rows are scoped by that token. */
  const established = async (fallback?: SignedInUser | null): Promise<AuthOutcome> => {
    const profile = profileOf(await client.me());
    if (!profile) {
      if (fallback) {
        writeUser(fallback, storage);
        return { status: 'authenticated', user: fallback };
      }
      return { status: 'anonymous', message: GENERIC_AUTH_ERROR };
    }
    const user: SignedInUser = { id: profile.id, email: profile.email || fallback?.email || '' };
    writeUser(user, storage);
    return { status: 'authenticated', user };
  };

  return {
    /**
     * Restores the session after a page refresh using the stored token only.
     * A rejected token is discarded so the user lands back on sign-in; a transient network failure
     * keeps the stored session so a working login is not thrown away.
     */
    async restoreSession(): Promise<AuthOutcome> {
      if (!readToken(storage)) return { status: 'anonymous' };
      const stored = readUser(storage);
      try {
        return await established(stored);
      } catch (error) {
        const status = statusOf(error);
        if (status === 401 || status === 403) {
          clearSession(storage);
          return { status: 'anonymous' };
        }
        if (stored) return { status: 'authenticated', user: stored };
        clearSession(storage);
        return { status: 'anonymous' };
      }
    },

    /**
     * Hands the browser to the platform identity provider. No credential is collected here, so a
     * password never passes through application code.
     */
    startSignIn(): AuthOutcome {
      try {
        client.toLogin();
      } catch {
        return { status: 'anonymous', message: GENERIC_AUTH_ERROR };
      }
      return { status: 'redirecting' };
    },

    /** Completes the provider redirect, then loads the signed-in user's id and email. */
    async completeCallback(): Promise<AuthOutcome> {
      let token: string | null = null;
      try {
        token = tokenOf(await client.login()) ?? readToken(storage);
      } catch {
        clearSession(storage);
        return { status: 'anonymous', message: GENERIC_AUTH_ERROR };
      }
      if (!token) return { status: 'anonymous', message: GENERIC_AUTH_ERROR };
      writeToken(token, storage);
      try {
        return await established();
      } catch {
        clearSession(storage);
        return { status: 'anonymous', message: GENERIC_AUTH_ERROR };
      }
    },

    /** Signs out locally even when the provider's logout call fails, so a stale session is never kept. */
    async signOut(): Promise<AuthOutcome> {
      try {
        await client.logout();
      } catch {
        // Ignored: clearing the local session is what protects the next user on this browser.
      }
      clearSession(storage);
      return { status: 'anonymous' };
    },
  };
}

export type AuthGateway = ReturnType<typeof createAuthGateway>;
