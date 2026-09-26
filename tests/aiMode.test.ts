import { describe, expect, it } from 'vitest';
import { resolveAiMode } from '../src/ai/mode';

describe('resolveAiMode', () => {
  it('defaults to deterministic Demo Mode when the endpoint is empty', () => {
    expect(resolveAiMode(undefined)).toBe('demo');
    expect(resolveAiMode('')).toBe('demo');
    expect(resolveAiMode('   ')).toBe('demo');
  });
  it('uses HTTP mode only with a configured endpoint', () => {
    expect(resolveAiMode('https://example.com/ai')).toBe('http');
  });
});
