import { describe, expect, it } from 'vitest';
import * as A from '../src/engine/actions';
import { generateDefinition } from '../src/engine/demo';
import { DEFAULT_CHECKS, verifyProject, type VerificationCheck } from '../src/engine/verify';
import {
  applyRepair, buildRepairContext, cancelRepair, deterministicRepairProvider, latestReport, missingCapabilities,
  proposeRepair, reverifyRepair, type RepairProvider,
} from '../src/engine/repair';
import { buildExport } from '../src/engine/export';
import { loadStore, saveStore } from '../src/store/projects';
import type { AppDefinition, Project, RepairProposal } from '../src/domain/project';

const T = '2026-03-01T00:00:00.000Z';
const ok = (r: { ok: boolean }): Project => {
  if (!('project' in r)) throw new Error((r as { error: string }).error);
  return (r as { project: Project }).project;
};
type Mut = (d: AppDefinition) => void;
const badAccuracy: Mut = (d) => { d.entity.fields = d.entity.fields.map((f) => (f.key === 'accuracy' ? { ...f, max: 1000 } : f)); };
const noDelete: Mut = (d) => { d.actions = ['create', 'update']; };
const both: Mut = (d) => { badAccuracy(d); noDelete(d); };
const producer = (mut: Mut): A.DefinitionProducer => (a, t, o) => { const d = structuredClone(generateDefinition(a, t, o)) as AppDefinition; mut(d); return d; };
const withoutVC22 = DEFAULT_CHECKS.filter((c) => c.id !== 'VC-22');
const fail: VerificationCheck = { id: 'VC-X', title: 'Fixture failure', expected: 'never', run: () => ({ passed: false, observed: 'forced', evidence: 'fixture' }) };
const withX = [...DEFAULT_CHECKS, fail];
const stepwise: RepairProvider = (ctx, p, now) => {
  const r = deterministicRepairProvider(ctx, p, now) as RepairProposal;
  return { ...r, proposedChanges: r.proposedChanges.slice(0, 1), affectedDefinitionPaths: r.affectedDefinitionPaths.slice(0, 1) };
};

function failing(mut: Mut, checks = DEFAULT_CHECKS): Project {
  let p = A.createProject({ id: 'p', name: 'Bench', now: T });
  p = ok(A.approveTests(ok(A.proposeAcceptanceTests(ok(A.analyze(p, T)), T)), T));
  p = ok(verifyProject(ok(A.generate(p, T)), T));
  p = ok(A.approveTests(ok(A.returnToTestEditing(p, T)), T));
  return ok(verifyProject(ok(A.generate(p, T, producer(mut))), T, checks));
}
const propose = (p: Project, pr?: RepairProvider, c = DEFAULT_CHECKS) => ok(proposeRepair(p, T, pr, c));
const cycle = (p: Project, pr?: RepairProvider, c = DEFAULT_CHECKS) => ok(reverifyRepair(ok(applyRepair(propose(p, pr, c), T, c)), T, c));
const strip = (p: Project) => ({ ...p, repairRejections: [], updatedAt: '' });

describe('1. repair-result invariants', () => {
  it('incremental repair leaves an incomplete candidate non-stable; second repair completes it', () => {
    const p = failing(both);
    const one = cycle(p, stepwise);
    const a1 = one.repairAttempts[0];
    expect(a1).toMatchObject({ proposalAccepted: true, candidateStructurallyValid: false, candidateVerificationPassed: false, promotedToStable: false, outcome: 'improved' });
    expect(a1.missingCapabilities).toEqual(['action delete']);
    expect(a1.remainingFailedTestIds).toContain('VC-22');
    expect(one.stableVersionId).toBe('p-v1');
    expect(one.versions.at(-1)!.lifecycleStatus).toBe('candidate');
    const two = cycle(one, stepwise);
    expect(two.repairAttempts[1]).toMatchObject({ candidateStructurallyValid: true, candidateVerificationPassed: true, promotedToStable: true, outcome: 'repaired' });
    expect(two.stableVersionId).toBe('p-v4');
    expect(two.versions.find((v) => v.id === 'p-v3')!.lifecycleStatus).toBe('candidate');
  });
  it('capability invariants block promotion even when the selected checks pass', () => {
    const s = cycle(failing(both, withoutVC22), undefined, withoutVC22);
    expect(latestReport(s)!.passed).toBe(true);
    expect(s.repairAttempts[0]).toMatchObject({ candidateStructurallyValid: false, promotedToStable: false, outcome: 'no_improvement' });
    expect(s.repairStopReason).toMatch(/missing required capabilities: action delete/);
    expect(s.stableVersionId).toBe('p-v1');
    expect(s.workflowStatus).toBe('stopped');
  });
  it('missingCapabilities checks the full definition, including refs and states', () => {
    const p = failing(badAccuracy);
    const d = structuredClone(p.applicationDefinition!);
    expect(missingCapabilities(d, p.acceptanceTests)).toEqual([]);
    const broken = { ...d, acceptanceTestRefs: d.acceptanceTestRefs.slice(1), layout: { ...d.layout, sections: ['table'] }, emptyState: { ...d.emptyState, title: '' } } as AppDefinition;
    expect(missingCapabilities(broken, p.acceptanceTests)).toEqual(expect.arrayContaining(['section metrics', 'section form', `test reference ${p.acceptanceTests[0].id}`, 'empty state']));
  });
});

describe('2. repair limit semantics', () => {
  it('counts 0 → 1 → 2, then no third repair; verify/cancel/reject/reload do not change it; new baseline resets', () => {
    const p = failing(both, withX);
    expect(p.repairAttemptCount).toBe(0);
    expect(ok(cancelRepair(propose(p, stepwise, withX), T)).repairAttemptCount).toBe(0);
    expect(propose(p, () => 'garbage').repairAttemptCount).toBe(0);
    const one = cycle(p, stepwise, withX);
    expect(one.repairAttemptCount).toBe(1);
    expect(ok(verifyProject(one, T, withX)).repairAttemptCount).toBe(1);
    const two = cycle(one, stepwise, withX);
    expect(two.repairAttemptCount).toBe(2);
    expect(proposeRepair(two, T, stepwise, withX).ok).toBe(false);
    expect(proposeRepair({ ...two, workflowStatus: 'verification_failed' }, T, stepwise, withX).ok).toBe(false);
    expect(applyRepair({ ...two, workflowStatus: 'verification_failed', pendingRepair: one.repairAttempts[0] as never }, T).ok).toBe(false);
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveStore(st, [two], two.id);
    expect(loadStore(st).projects[0].repairAttemptCount).toBe(2);
    const reset = ok(A.generate(ok(A.approveTests(ok(A.returnToTestEditing(two, T)), T)), T));
    expect(reset.repairAttemptCount).toBe(0);
    expect(reset.repairAttempts).toEqual(two.repairAttempts);
  });
});

describe('3. stop report', () => {
  it('stop evidence includes reason, remaining checks, candidate, last stable and next action', () => {
    const s = cycle(cycle(failing(both, withX), stepwise, withX), stepwise, withX);
    const a = s.repairAttempts[1];
    expect(a.outcome).toBe('limit_reached');
    expect(a.stopReason).toMatch(/limit/);
    expect(a.remainingFailedTestIds).toEqual(['VC-X']);
    expect(a.remainingBlockedTestIds).toEqual([]);
    expect(a.candidateVersionId).toBe(s.currentVersionId);
    expect(a.lastStableVersionId).toBe('p-v1');
    expect(a.suggestedNextAction).toMatch(/Manual action/);
    expect(s.stableVersionId).toBe('p-v1');
  });
});

describe('4. approved-test protection', () => {
  const p = failing(badAccuracy);
  const good = deterministicRepairProvider(buildRepairContext(p, latestReport(p)!), p, T) as RepairProposal;
  const tests = p.acceptanceTests;
  it.each([
    ['modify test', { acceptanceTests: [{ ...tests[0], title: 'x' }] }],
    ['weaken expected result', { acceptanceTests: tests.map((t, i) => (i ? t : { ...t, expectedResult: 'anything' })) }],
    ['change priority', { acceptanceTests: tests.map((t, i) => (i ? t : { ...t, priority: 'low' })) }],
    ['change verification type', { acceptanceTests: tests.map((t, i) => (i ? t : { ...t, verificationType: 'manual' })) }],
    ['remove test reference', { proposedChanges: [{ path: 'acceptanceTestRefs', value: tests.slice(1).map((t) => t.id) }], affectedDefinitionPaths: ['acceptanceTestRefs'] }],
    ['path into tests', { proposedChanges: [{ path: 'acceptanceTests.0.priority', value: 'low' }], affectedDefinitionPaths: ['acceptanceTests.0.priority'] }],
  ])('rejects: %s, leaving state unchanged', (_n, patch) => {
    const r = propose(p, () => ({ ...good, ...patch }));
    expect(r.pendingRepair).toBeNull();
    expect(r.repairRejections).toHaveLength(1);
    expect(strip(r)).toEqual(strip(p));
  });
  it('approved tests are deep-equal before and after every attempt', () => {
    const q = failing(both);
    const one = cycle(q, stepwise);
    const two = cycle(one, stepwise);
    expect(one.acceptanceTests).toEqual(q.acceptanceTests);
    expect(two.acceptanceTests).toEqual(q.acceptanceTests);
  });
});

describe('5. export evidence', () => {
  it('distinguishes stages and contains no secrets or foreign storage', () => {
    const s = cycle(propose(cycle(failing(both), stepwise), () => 'garbage'), stepwise);
    const e = buildExport(s, T);
    if (!e.ok) throw new Error(e.error);
    const r = e.data.repair;
    expect(e.data.versions.history.map((v) => v.kind)).toEqual(['baseline', 'baseline', 'repair', 'repair']);
    expect(r.attempts.map((a) => [a.proposalAccepted, a.candidateStructurallyValid, a.candidateVerificationPassed, a.promotedToStable])).toEqual([[true, false, false, false], [true, true, true, true]]);
    expect(r.rejections).toHaveLength(1);
    expect(r.attempts[0].affectedTestIds.length).toBeGreaterThan(0);
    expect(r.attempts[0].regressionTestIds).toContain('VC-22');
    expect(r.lastStableVersionId).toBe('p-v4');
    expect(e.json).not.toMatch(/"(api[_-]?key|credentials?|secret|password|token|authorization|headers|endpoint)"\s*:|Bearer\s|VITE_AI_ENDPOINT|https?:\/\//i);
    expect(Object.keys(e.data).sort()).toEqual(Object.keys(e.data).filter((k) => !/storage|env|config/i.test(k)).sort());
  });
});
