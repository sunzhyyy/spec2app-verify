import { describe, expect, it } from 'vitest';
import * as A from '../src/engine/actions';
import { canTransition } from '../src/domain/workflow';
import { generateDefinition } from '../src/engine/demo';
import { computeMetric, filterRecords, formatMetric, validateRecord } from '../src/renderer/logic';
import { loadStore, saveStore, STORAGE_KEY } from '../src/store/projects';
import type { Project } from '../src/domain/project';

const T = '2026-01-01T00:00:00.000Z';
const ok = (r: A.ActionResult): Project => {
  if (!r.ok) throw new Error(r.error);
  return r.project;
};
const toApproved = () => {
  let p = A.createProject({ id: 'p1', name: 'P', now: T });
  p = ok(A.analyze(p, T));
  p = ok(A.proposeAcceptanceTests(p, T));
  return ok(A.approveTests(p, T));
};

describe('workflow', () => {
  it('rejects invalid transitions', () => {
    expect(canTransition('draft', 'generated')).toBe(false);
    expect(A.generate(A.createProject({ id: 'x', name: 'x', now: T }), T).ok).toBe(false);
  });
  it('rejects empty and unknown requirements in demo mode', () => {
    const p = A.createProject({ id: 'x', name: 'x', now: T, requirement: '  ' });
    expect(A.analyze(p, T).ok).toBe(false);
    expect(A.analyze({ ...p, originalRequirement: 'todo list' }, T).ok).toBe(false);
  });
  it('is deterministic and proposes 13 tests', () => {
    const a = toApproved();
    expect(a.acceptanceTests).toHaveLength(13);
    expect(a.acceptanceTests.every((t) => t.approved)).toBe(true);
    expect(JSON.stringify(toApproved())).toBe(JSON.stringify(a));
  });
  it('blocks approval of invalid tests', () => {
    let p = ok(A.proposeAcceptanceTests(ok(A.analyze(A.createProject({ id: 'x', name: 'x', now: T }), T)), T));
    p = ok(A.updateTests(p, [...p.acceptanceTests, A.blankTest(p.acceptanceTests)], T));
    expect(A.approveTests(p, T).ok).toBe(false);
  });
  it('locks tests after approval and invalidates generated app on unlock', () => {
    const g = ok(A.generate(toApproved(), T));
    expect(g.workflowStatus).toBe('generated');
    expect(g.versions[0].status).toBe('candidate');
    expect(A.updateTests(g, [], T).ok).toBe(false);
    const u = ok(A.returnToTestEditing(g, T));
    expect(u.applicationDefinition).toBeNull();
    expect(u.versions[0].status).toBe('invalidated');
    expect(u.acceptanceTests.some((t) => t.approved)).toBe(false);
  });
  it('refuses to render an invalid definition', () => {
    const bad = (...args: Parameters<typeof generateDefinition>) => ({ ...(generateDefinition(...args) as object), filters: [{ field: 'latency', label: 'L' }] });
    const r = A.generate(toApproved(), T, bad);
    expect(r.ok).toBe(false);
  });
});

describe('renderer logic', () => {
  const def = ok(A.generate(toApproved(), T)).applicationDefinition!;
  const recs = [
    { id: '1', latency: 10, passed: true, precision: 'INT8' },
    { id: '2', latency: 20, passed: true, precision: 'FP16' },
    { id: '3', latency: 30, passed: true, precision: 'INT8' },
    { id: '4', latency: 40, passed: false, precision: 'INT8' },
  ];
  it('computes metrics', () => {
    const [count, avg, rate] = def.metrics;
    expect(formatMetric(avg, computeMetric(avg, recs.slice(0, 2)))).toBe('15.00 ms');
    expect(formatMetric(rate, computeMetric(rate, recs))).toBe('75.0%');
    expect(formatMetric(avg, computeMetric(avg, []))).toBe('—');
    expect(computeMetric(count, filterRecords(recs, { precision: 'INT8' }))).toBe(3);
  });
  it('validates records', () => {
    const r = validateRecord(def, { modelName: '', accuracy: '120', latency: '-1', memoryUsage: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.modelName).toBe('Model name is required');
      expect(r.errors.accuracy).toMatch(/between 0 and 100/);
      expect(r.errors.latency).toMatch(/≥ 0/);
      expect(r.errors.memoryUsage).toMatch(/must be a number/);
    }
  });
});

describe('store', () => {
  it('round-trips and ignores corrupt data', () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveStore(s, [toApproved()], 'p1');
    expect(loadStore(s).projects).toHaveLength(1);
    m.set(STORAGE_KEY, '{bad');
    expect(loadStore(s).dropped).toBe(1);
  });
});
