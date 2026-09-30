/**
 * Sign-in, session restoration and sign-out behaviour.
 *
 * These cover the properties that matter for a supported OIDC sign-in: the session is restored from
 * the stored platform token only, an invalid session is discarded, a transient failure does not log
 * the user out, every provider failure maps onto one generic message, and sign-out always clears the
 * local session. No credential is ever accepted or persisted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthGateway, GENERIC_AUTH_ERROR, MANAGED_ACCOUNT_NOTE, type AuthClient } from '../src/gen/auth/gateway';
import { readToken, readUser, TOKEN_KEY, USER_KEY, writeToken, writeUser } from '../src/gen/auth/session';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

const httpError = (status: number) => Object.assign(new Error('request failed'), { response: { status } });

function makeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    login: vi.fn(async () => ({ token: 'platform-token' })),
    me: vi.fn(async () => ({ data: { id: 'user-a', email: 'a@example.com' } })),
    logout: vi.fn(async () => ({})),
    toLogin: vi.fn(() => undefined),
    ...overrides,
  };
}

describe('auth gateway', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('stays anonymous when no token is stored', async () => {
    const client = makeClient();
    const gateway = createAuthGateway(client, { storage });

    await expect(gateway.restoreSession()).resolves.toEqual({ status: 'anonymous' });
    expect(client.me).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  });

  it('restores a session from the stored token and caches only the public profile', async () => {
    writeToken('stored-token', storage);
    const client = makeClient();
    const gateway = createAuthGateway(client, { storage });

    await expect(gateway.restoreSession()).resolves.toEqual({
      status: 'authenticated',
      user: { id: 'user-a', email: 'a@example.com' },
    });
    expect(readUser(storage)).toEqual({ id: 'user-a', email: 'a@example.com' });
    expect(storage.keys().sort()).toEqual([TOKEN_KEY, USER_KEY].sort());
  });

  it('discards a rejected session', async () => {
    writeToken('expired', storage);
    writeUser({ id: 'user-a', email: 'a@example.com' }, storage);
    const client = makeClient({
      me: vi.fn(async () => {
        throw httpError(401);
      }),
    });
    const gateway = createAuthGateway(client, { storage });

    await expect(gateway.restoreSession()).resolves.toEqual({ status: 'anonymous' });
    expect(readToken(storage)).toBeNull();
    expect(readUser(storage)).toBeNull();
  });

  it('keeps a working session across a transient provider failure', async () => {
    writeToken('stored-token', storage);
    writeUser({ id: 'user-a', email: 'a@example.com' }, storage);
    const client = makeClient({
      me: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const gateway = createAuthGateway(client, { storage });

    await expect(gateway.restoreSession()).resolves.toEqual({
      status: 'authenticated',
      user: { id: 'user-a', email: 'a@example.com' },
    });
    expect(readToken(storage)).toBe('stored-token');
  });

  it('hands off to the provider and reports a generic error when the redirect cannot start', () => {
    const client = makeClient();
    const gateway = createAuthGateway(client, { storage });
    expect(gateway.startSignIn()).toEqual({ status: 'redirecting' });
    expect(client.toLogin).toHaveBeenCalledTimes(1);

    const broken = createAuthGateway(
      makeClient({
        toLogin: vi.fn(() => {
          throw new Error('popup blocked');
        }),
      }),
      { storage },
    );
    expect(broken.startSignIn()).toEqual({ status: 'anonymous', message: GENERIC_AUTH_ERROR });
  });

  it('completes the callback, storing the token and the loaded profile', async () => {
    const client = makeClient();
    const gateway = createAuthGateway(client, { storage });

    await expect(gateway.completeCallback()).resolves.toEqual({
      status: 'authenticated',
      user: { id: 'user-a', email: 'a@example.com' },
    });
    expect(readToken(storage)).toBe('platform-token');
    expect(storage.keys().sort()).toEqual([TOKEN_KEY, USER_KEY].sort());
  });

  it('never surfaces a provider diagnostic from a failed callback', async () => {
    const client = makeClient({
      login: vi.fn(async () => {
        throw httpError(400);
      }),
    });
    const gateway = createAuthGateway(client, { storage });

    const outcome = await gateway.completeCallback();
    expect(outcome).toEqual({ status: 'anonymous', message: GENERIC_AUTH_ERROR });
    expect(JSON.stringify(outcome)).not.toMatch(/400|password|secret/i);
    expect(readToken(storage)).toBeNull();
  });

  it('fails the callback when no token can be obtained', async () => {
    const gateway = createAuthGateway(makeClient({ login: vi.fn(async () => ({})) }), { storage });
    await expect(gateway.completeCallback()).resolves.toEqual({ status: 'anonymous', message: GENERIC_AUTH_ERROR });
    expect(storage.length).toBe(0);
  });

  it('always clears the local session on sign-out, even if the provider call fails', async () => {
    writeToken('stored-token', storage);
    writeUser({ id: 'user-a', email: 'a@example.com' }, storage);
    const gateway = createAuthGateway(
      makeClient({
        logout: vi.fn(async () => {
          throw new Error('provider unavailable');
        }),
      }),
      { storage },
    );

    await expect(gateway.signOut()).resolves.toEqual({ status: 'anonymous' });
    expect(readToken(storage)).toBeNull();
    expect(readUser(storage)).toBeNull();
  });

  it('explains that account creation belongs to the provider', () => {
    expect(MANAGED_ACCOUNT_NOTE).toMatch(/identity provider/i);
    expect(MANAGED_ACCOUNT_NOTE).toMatch(/no separate sign-up form/i);
  });
});
