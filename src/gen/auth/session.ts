/**
 * Session persistence.
 *
 * The platform issues an opaque bearer token and the SDK sends it as `Authorization: Bearer ...`
 * (it reads and writes the `token` key). Only that token plus the public user id/email are kept
 * here; no password, secret or provider diagnostic is ever persisted.
 */
export const TOKEN_KEY = 'token';
export const USER_KEY = 'spec2app.auth.user';
export const IMPORT_ASKED_KEY = 'spec2app.import.asked';

export interface SignedInUser {
  id: string;
  email: string;
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readToken(storage?: Storage): string | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  const token = store.getItem(TOKEN_KEY);
  return token && token.trim() ? token : null;
}

export function writeToken(token: string, storage?: Storage): void {
  resolveStorage(storage)?.setItem(TOKEN_KEY, token);
}

export function readUser(storage?: Storage): SignedInUser | null {
  const store = resolveStorage(storage);
  if (!store) return null;
  const raw = store.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; email?: unknown };
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) return null;
    return { id: parsed.id, email: typeof parsed.email === 'string' ? parsed.email : '' };
  } catch {
    return null;
  }
}

export function writeUser(user: SignedInUser, storage?: Storage): void {
  resolveStorage(storage)?.setItem(USER_KEY, JSON.stringify({ id: user.id, email: user.email }));
}

/** Clears the application session. Used on sign-out and when a stored token is rejected. */
export function clearSession(storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  store.removeItem(TOKEN_KEY);
  store.removeItem(USER_KEY);
}

export function hasSession(storage?: Storage): boolean {
  return Boolean(readToken(storage));
}

export function importPromptAsked(storage?: Storage): boolean {
  return resolveStorage(storage)?.getItem(IMPORT_ASKED_KEY) === '1';
}

export function markImportPromptAsked(storage?: Storage): void {
  resolveStorage(storage)?.setItem(IMPORT_ASKED_KEY, '1');
}
