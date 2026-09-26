import { describe, expect, it } from 'vitest';
import * as A from '../src/engine/actions';
import { canTransition } from '../src/domain/workflow';
import { analyzeRequirement, DEFAULT_REQUIREMENT, generateDefinition } from '../src/engine/demo';
import { computeMetric, filterRecords, formatMetric, validateRecord } from '../src/renderer/logic';
import { loadStore, migrate, resetStore, saveStore, serializeStore, STORAGE_KEY } from '../src/store/projects';
import { DEFAULT_CHECKS, runChecks, verifyProject, type VerificationCheck } from '../src/engine/verify';
import { buildExport, exportFilename, ExportSchema } from '../src/engine/export';
import type { AppRecord, Project } from '../src/domain/project';

const T = '2026-01-01T00:00:00.000Z';
const ok = (r: A.ActionResult | ReturnType<typeof verifyProject>): Project => {
  if ('error' in r) throw new Error(r.error);
  return r.project;
};
const draft = () => A.createProject({ id: 'p1', name: 'My Bench!', now: T });
const proposed = () => ok(A.proposeAcceptanceTests(ok(A.analyze(draft(), T)), T));
const approved = () => ok(A.approveTests(proposed(), T));
const generated = () => ok(A.generate(approved(), T));
const def = generated().applicationDefinition!;
const VALID = { modelName: 'M', hardwarePlatform: 'Raspberry Pi 5', precision: 'INT8', accuracy: '50', latency: '5', memoryUsage: '10', passed: 'true' };
const recs: AppRecord[] = [
  { id: '1', hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'INT8', latency: 10, passed: true },
  { id: '2', hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'FP16', latency: 20, passed: true },
  { id: '3', hardwarePlatform: 'Raspberry Pi 5', precision: 'INT8', latency: 30, passed: true },
  { id: '4', hardwarePlatform: 'Raspberry Pi 5', precision: 'INT8', latency: 40, passed: false },
];
const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
};
const failingCheck: VerificationCheck = { id: 'VC-FIXTURE', title: 'Test-only failing fixture', expected: 'fails', run: () => ({ passed: false, observed: 'forced', evidence: 'fixture' }) };

describe('workflow', () => {
  it('allows valid and rejects invalid transitions', () => {
    expect(canTransition('draft', 'analyzed')).toBe(true);
    expect(canTransition('generated', 'verifying')).toBe(true);
    expect(canTransition('draft', 'generated')).toBe(false);
    expect(canTransition('awaiting_test_approval', 'generating')).toBe(false);
  });
  it('rejects empty and unknown requirements', () => {
    expect(A.analyze({ ...draft(), originalRequirement: '  ' }, T).ok).toBe(false);
    expect(A.analyze({ ...draft(), originalRequirement: 'todo list' }, T).ok).toBe(false);
  });
  it('analysis is deterministic', () => {
    expect(analyzeRequirement(DEFAULT_REQUIREMENT)).toEqual(analyzeRequirement(DEFAULT_REQUIREMENT));
    expect(proposed().acceptanceTests).toHaveLength(13);
    expect(JSON.stringify(generated())).toBe(JSON.stringify(generated()));
  });
  it('validates acceptance tests and blocks approval when invalid', () => {
    const p = ok(A.updateTests(proposed(), [...proposed().acceptanceTests, A.blankTest(proposed().acceptanceTests)], T));
    expect(Object.keys(A.validateTests(p.acceptanceTests))).toEqual(['AT-14']);
    expect(A.approveTests(p, T).ok).toBe(false);
    expect(A.approveTests({ ...proposed(), acceptanceTests: [] }, T).ok).toBe(false);
  });
  it('blocks generation before approval', () => {
    const r = A.generate(proposed(), T);
    expect(r.ok).toBe(false);
  });
  it('locks approved tests', () => {
    const p = approved();
    expect(p.acceptanceTests.every((t) => t.approved)).toBe(true);
    expect(A.updateTests(p, [], T).ok).toBe(false);
    expect(A.updateTests(generated(), [], T).ok).toBe(false);
  });
  it('return-to-editing invalidates candidate but keeps stable', () => {
    const v = ok(verifyProject(generated(), T));
    const u = ok(A.returnToTestEditing(v, T));
    expect(u.applicationDefinition).toBeNull();
    expect(u.currentVersionId).toBeNull();
    expect(u.testsApprovedAt).toBeNull();
    expect(u.acceptanceTests.some((t) => t.approved)).toBe(false);
    expect(u.stableVersionId).toBe('p1-v1');
    const u2 = ok(A.returnToTestEditing(generated(), T));
    expect(u2.versions[0].verificationStatus).toBe('invalidated');
    expect(u2.versions[0].lifecycleStatus).toBe('candidate');
  });
  it('rejects invalid application definitions', () => {
    const bad = (...a: Parameters<typeof generateDefinition>) => ({ ...(generateDefinition(...a) as object), filters: [{ field: 'latency', label: 'L' }] });
    const r = A.generate(approved(), T, bad);
    expect(r.ok).toBe(false);
  });
});

describe('record logic', () => {
  it('requires fields', () => {
    const r = validateRecord(def, { ...VALID, modelName: '' });
    expect('errors' in r && r.errors.modelName).toBe('Model name is required');
  });
  it('validates numeric fields', () => {
    const r = validateRecord(def, { ...VALID, accuracy: '120', latency: '-1', memoryUsage: 'abc' });
    expect('errors' in r && Object.keys(r.errors).sort()).toEqual(['accuracy', 'latency', 'memoryUsage']);
    expect(validateRecord(def, { ...VALID, accuracy: '100', latency: '0' }).ok).toBe(true);
  });
  it('add, edit and delete records through the engine', () => {
    const v = validateRecord(def, VALID);
    if (!('value' in v)) throw new Error('invalid');
    let p = ok(A.updateRecords(generated(), [{ ...v.value, id: 'a' }], T));
    expect(p.applicationRecords[0].latency).toBe(5);
    p = ok(A.updateRecords(p, p.applicationRecords.map((r) => ({ ...r, latency: 9.8 })), T));
    expect(p.applicationRecords[0].latency).toBe(9.8);
    p = ok(A.updateRecords(p, [], T));
    expect(p.applicationRecords).toHaveLength(0);
    expect(A.updateRecords(draft(), [], T).ok).toBe(false);
  });
  it('filters by hardware, precision and both', () => {
    expect(filterRecords(recs, { hardwarePlatform: 'Raspberry Pi 5' }).map((r) => r.id)).toEqual(['3', '4']);
    expect(filterRecords(recs, { precision: 'INT8' }).map((r) => r.id)).toEqual(['1', '3', '4']);
    expect(filterRecords(recs, { hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'INT8' }).map((r) => r.id)).toEqual(['1']);
    expect(filterRecords(recs, { hardwarePlatform: '', precision: '' })).toHaveLength(4);
  });
  it('computes count, average latency and pass rate', () => {
    const [count, avg, rate] = def.metrics;
    expect(computeMetric(count, filterRecords(recs, { precision: 'INT8' }))).toBe(3);
    expect(formatMetric(avg, computeMetric(avg, recs.slice(0, 2)))).toBe('15.00 ms');
    expect(formatMetric(avg, computeMetric(avg, []))).toBe('—');
    expect(formatMetric(rate, computeMetric(rate, recs))).toBe('75.0%');
  });
});

describe('persistence', () => {
  it('serializes with schemaVersion and restores exactly', () => {
    const s = mem();
    saveStore(s, [generated()], 'p1');
    expect(JSON.parse(s.m.get(STORAGE_KEY)!).schemaVersion).toBe(1);
    const l = loadStore(s);
    expect(l.projects[0]).toEqual(generated());
    expect(l.selectedProjectId).toBe('p1');
    expect(l.warning).toBeNull();
  });
  it('falls back safely on corrupted data with an actionable warning', () => {
    for (const bad of ['{bad', '42', JSON.stringify({ schemaVersion: 1, projects: 'x' })]) {
      const l = loadStore(mem({ [STORAGE_KEY]: bad }));
      expect(l.projects).toEqual([]);
      expect(l.warning).toMatch(/Reset Spec2App data/);
    }
    const partial = loadStore(mem({ [STORAGE_KEY]: serializeStore([generated(), { ...draft(), id: '' }], 'p1') }));
    expect(partial.projects).toHaveLength(1);
    expect(partial.dropped).toBe(1);
  });
  it('handles schema versions via the migration boundary', () => {
    expect(migrate({ schemaVersion: 1 }).error).toBeUndefined();
    expect(migrate({ schemaVersion: 2 }).error).toMatch(/newer/);
    expect(migrate({ schemaVersion: 0 }).error).toMatch(/No migration/);
    expect(migrate({}).error).toMatch(/no schemaVersion/);
  });
  it('reset removes only Spec2App keys', () => {
    const s = mem({ [STORAGE_KEY]: '{}', 's2av:other': '1', unrelated: 'keep' });
    expect(resetStore(s)).toBe(2);
    expect([...s.m.keys()]).toEqual(['unrelated']);
  });
  it('rejects repairAttemptCount above the limit of 2', () => {
    const l = loadStore(mem({ [STORAGE_KEY]: serializeStore([{ ...generated(), repairAttemptCount: 3 }], null) }));
    expect(l.projects).toHaveLength(0);
  });
});

describe('versions and verification', () => {
  it('creates a candidate version with required fields', () => {
    const v = generated().versions[0];
    expect(v).toMatchObject({ id: 'p1-v1', parentVersionId: null, lifecycleStatus: 'candidate', verificationStatus: 'pending' });
    expect(v.acceptanceTestIds).toHaveLength(13);
    expect(generated().stableVersionId).toBeNull();
  });
  it('blocks verification without a candidate', () => {
    expect(verifyProject(approved(), T).ok).toBe(false);
    const rep = runChecks(approved(), T);
    expect(rep.results.every((r) => r.status === 'blocked')).toBe(true);
  });
  it('promotes a passing candidate to stable with a full report', () => {
    const p = ok(verifyProject(generated(), T));
    const rep = p.verificationReports[0];
    expect(rep.results).toHaveLength(DEFAULT_CHECKS.length);
    expect(rep.results.filter((r) => r.status !== 'passed')).toEqual([]);
    expect(rep.results[0]).toMatchObject({ applicationVersion: 'p1-v1', timestamp: T });
    expect(p.workflowStatus).toBe('verified');
    expect(p.stableVersionId).toBe('p1-v1');
    expect(p.versions[0]).toMatchObject({ lifecycleStatus: 'stable', verificationStatus: 'passed' });
    expect(p.acceptanceTests).toEqual(generated().acceptanceTests);
  });
  it('failed candidate never replaces stable (fixture)', () => {
    const noStable = ok(verifyProject(generated(), T, [...DEFAULT_CHECKS, failingCheck]));
    expect(noStable.workflowStatus).toBe('verification_failed');
    expect(noStable.stableVersionId).toBeNull();
    expect(noStable.versions[0]).toMatchObject({ lifecycleStatus: 'candidate', verificationStatus: 'failed' });
    expect(noStable.repairAttemptCount).toBe(0);

    const stable = ok(verifyProject(generated(), T));
    let p = ok(A.returnToTestEditing(stable, T));
    p = ok(A.generate(ok(A.approveTests(p, T)), T));
    expect(p.versions[1].parentVersionId).toBe('p1-v1');
    const failed = ok(verifyProject(p, T, [...DEFAULT_CHECKS, failingCheck]));
    expect(failed.stableVersionId).toBe('p1-v1');
    expect(failed.versions).toHaveLength(2);
    expect(failed.versions[1].lifecycleStatus).toBe('candidate');
    expect(failed.verificationReports.at(-1)!.results.at(-1)!.status).toBe('failed');
  });
  it('marks dependent checks blocked when a prerequisite fails', () => {
    const bad: VerificationCheck = { ...DEFAULT_CHECKS.find((c) => c.id === 'VC-04')!, run: () => ({ passed: false, observed: 'x', evidence: 'x' }) };
    const rep = runChecks(generated(), T, DEFAULT_CHECKS.map((c) => (c.id === 'VC-04' ? bad : c)));
    expect(rep.results.find((r) => r.testId === 'VC-05')!.status).toBe('blocked');
    expect(rep.passed).toBe(false);
  });
});

describe('export', () => {
  it('produces a validated export without secrets', () => {
    const p = ok(verifyProject(generated(), T));
    const e = buildExport(p, T);
    if (!e.ok) throw new Error(e.error);
    expect(ExportSchema.safeParse(JSON.parse(e.json)).success).toBe(true);
    expect(e.data.approvedAcceptanceTests).toHaveLength(13);
    expect(e.data.versions.stableVersionId).toBe('p1-v1');
    expect(e.json).not.toMatch(/api[_-]?key|secret|password|token|VITE_AI_ENDPOINT|https?:\/\//i);
    expect(exportFilename(p)).toBe('spec2app-my-bench-p1-v1.json');
  });
  it('blocks exports that would leak credentials', () => {
    const e = buildExport({ ...generated(), originalRequirement: 'benchmark with api_key=abc' }, T);
    expect(e.ok).toBe(false);
  });
});
