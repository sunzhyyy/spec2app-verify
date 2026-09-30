/** Route protection and callback detection for the sign-in flow. */
import { describe, expect, it } from 'vitest';
import { accessDecision } from '../src/gen/auth/access';
import { isAuthCallback } from '../src/gen/auth/callback';
import { importPromptAsked, markImportPromptAsked } from '../src/gen/auth/session';

describe('protected route decision', () => {
  it('waits while the session is being restored', () => {
    expect(accessDecision('checking')).toBe('loading');
  });

  it('allows a restored session through', () => {
    expect(accessDecision('authenticated')).toBe('allowed');
  });

  it('sends a signed-out visitor to sign-in', () => {
    expect(accessDecision('anonymous')).toBe('sign-in');
  });
});

describe('provider callback detection', () => {
  it('detects each parameter the provider can return', () => {
    for (const param of ['token', 'code', 'platform_token', 'id_token']) {
      expect(isAuthCallback(`?${param}=value`)).toBe(true);
    }
  });

  it('ignores empty values and unrelated query strings', () => {
    expect(isAuthCallback('')).toBe(false);
    expect(isAuthCallback('?token=')).toBe(false);
    expect(isAuthCallback('?utm_source=email')).toBe(false);
  });
});

describe('one-time local import prompt', () => {
  it('is asked at most once per browser', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;

    expect(importPromptAsked(storage)).toBe(false);
    markImportPromptAsked(storage);
    expect(importPromptAsked(storage)).toBe(true);
  });
});
