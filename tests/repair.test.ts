import { describe, expect, it } from 'vitest';
import * as A from '../src/engine/actions';
import { generateDefinition } from '../src/engine/demo';
import { DEFAULT_CHECKS, verifyProject, type VerificationCheck } from '../src/engine/verify';
import {
  applyRepair, buildRepairContext, cancelRepair, CORE_REGRESSION_IDS, deterministicRepairProvider, failureSignature, latestReport,
  proposeRepair, repairEligibility, requestHttpRepair, reverifyRepair, selectReverification, validateProposal, type RepairProvider,
} from '../src/engine/repair';
import { buildExport, ExportSchema } from '../src/engine/export';
import { loadStore, saveStore } from '../src/store/projects';
import { REPAIR_LIMITS, type AppDefinition, type Project, type RepairProposal } from '../src/domain/project';

const T = '2026-02-01T00:00:00.000Z';
const ok = (r: { ok: boolean }): Project => {
  if (!('project' in r)) throw new Error((r as { error: string }).error);
  return (r as { project: Project }).project;
};
type Mut = (d: AppDefinition) => void;
const producer = (mut: Mut): A.DefinitionProducer => (a, t, o) => {
  const d = structuredClone(generateDefinition(a, t, o)) as AppDefinition;
  mut(d);
  return d;
};
const badAccuracy: Mut = (d) => { d.entity.fields = d.entity.fields.map((f) => (f.key === 'accuracy' ? { ...f, max: 1000 } : f)); };
const noDelete: Mut = (d) => { d.actions = ['create', 'update']; };

function stableProject(): Project {
  let p = A.createProject({ id: 'p', name: 'Bench', now: T });
  p = ok(A.analyze(p, T));
  p = ok(A.proposeAcceptanceTests(p, T));
  p = ok(A.approveTests(p, T));
  p = ok(A.generate(p, T));
  return ok(verifyProject(p, T));
}
/** Stable v1, then a new failing candidate v2 produced with the given defect. */
function failingCandidate(mut: Mut, checks: VerificationCheck[] = DEFAULT_CHECKS): Project {
  let p = ok(A.returnToTestEditing(stableProject(), T));
  p = ok(A.approveTests(p, T));
  p = ok(A.generate(p, T, producer(mut)));
  return ok(verifyProject(p, T, checks));
}
const unrepairable: VerificationCheck = { id: 'VC-X', title: 'Fixture: unrepairable failure', expected: 'never passes', run: () => ({ passed: false, observed: 'forced', evidence: 'fixture' }) };
const withX = [...DEFAULT_CHECKS, unrepairable];
const stepwise: RepairProvider = (ctx, p, now) => {
  const r = deterministicRepairProvider(ctx, p, now) as RepairProposal;
  return { ...r, proposedChanges: r.proposedChanges.slice(0, 1), affectedDefinitionPaths: r.affectedDefinitionPaths.slice(0, 1) };
};
const cycle = (p: Project, provider?: RepairProvider, checks = DEFAULT_CHECKS) =>
  ok(reverifyRepair(ok(applyRepair(ok(proposeRepair(p, T, provider, checks)), T, checks)), T, checks));

describe('eligibility', () => {
  it('rejects repair when no failure exists', () => {
    const p = stableProject();
    expect(repairEligibility(p).eligible).toBe(false);
    expect(proposeRepair(p, T).ok).toBe(false);
    expect(applyRepair(p, T).ok).toBe(false);
  });
  it('is eligible after a failed verification and reports why', () => {
    const e = repairEligibility(failingCandidate(badAccuracy));
    expect(e).toEqual({ eligible: true, reason: '1 failed, 0 blocked check(s) in p-v2.' });
  });
  it('is disabled when approved tests changed', () => {
    const p = failingCandidate(badAccuracy);
    const tampered = { ...p, acceptanceTests: p.acceptanceTests.map((t, i) => (i ? t : { ...t, expectedResult: 'weakened result text' })) };
    expect(repairEligibility(tampered).reason).toMatch(/Approved tests changed/);
  });
});

describe('signature and context', () => {
  it('failure signature is stable and excludes timestamps and ids', () => {
    const a = failureSignature(latestReport(failingCandidate(badAccuracy))!);
    const b = failureSignature({ ...latestReport(failingCandidate(badAccuracy))!, id: 'other', createdAt: 'x' });
    expect(a).toBe(b);
    expect(a).toBe('F:VC-06|B:|P:entity.fields');
  });
  it('compact context contains only failing checks and relevant fragments, no records or secrets', () => {
    const p = { ...failingCandidate(badAccuracy), applicationRecords: [{ id: 'r', modelName: 'secret-record' }] };
    const ctx = buildRepairContext(p, latestReport(p)!);
    expect(ctx.failures.map((f) => f.testId)).toEqual(['VC-06']);
    expect(Object.keys(ctx.definitionFragments)).toEqual(['entity.fields']);
    expect(ctx.approvedRequirementIds).toHaveLength(13);
    expect(JSON.stringify(ctx)).not.toMatch(/secret-record|applicationRecords|originalRequirement|versions/);
  });
});

describe('Scenario A – numeric constraint repaired', () => {
  it('repairs only the constraint, reruns affected + core checks, promotes to stable', () => {
    const p = failingCandidate(badAccuracy);
    const proposed = ok(proposeRepair(p, T));
    expect(proposed.pendingRepair!.proposedChanges.map((c) => c.path)).toEqual(['entity.fields.accuracy']);
    expect(proposed.pendingRepair!.repairMode).toBe('deterministic');
    expect(proposed.aiAssistedCallCount).toBe(0);
    expect(ok(cancelRepair(proposed, T)).pendingRepair).toBeNull();
    const applied = ok(applyRepair(proposed, T));
    const v3 = applied.versions.at(-1)!;
    expect(v3).toMatchObject({ id: 'p-v3', parentVersionId: 'p-v2', kind: 'repair', repairAttemptNumber: 1, lifecycleStatus: 'candidate', changedDefinitionPaths: ['entity.fields.accuracy'] });
    expect(applied.stableVersionId).toBe('p-v1');
    expect(applied.repairAttemptCount).toBe(1);
    const done = ok(reverifyRepair(applied, T));
    const rep = done.verificationReports.at(-1)!;
    expect(rep.scope).toBe('targeted');
    expect(rep.selection.map((s) => s.testId)).toEqual(expect.arrayContaining([...CORE_REGRESSION_IDS, 'VC-06', 'VC-08']));
    expect(rep.selection.find((s) => s.testId === 'VC-06')!.reason).toBe('failed or blocked before repair');
    expect(rep.carriedForward).toContain('VC-10');
    expect(done.workflowStatus).toBe('verified');
    expect(done.stableVersionId).toBe('p-v3');
    expect(done.repairAttempts[0]).toMatchObject({ outcome: 'repaired', failedCountBefore: 1, failedCountAfter: 0, regressedTestIds: [] });
    expect(done.versions.map((v) => v.id)).toEqual(['p-v1', 'p-v2', 'p-v3']);
    expect(done.acceptanceTests).toEqual(p.acceptanceTests);
  });
});

describe('Scenario B – bounded stop', () => {
  it('second attempt reaches the limit, workflow stops, stable protected', () => {
    const p = failingCandidate((d) => { badAccuracy(d); noDelete(d); }, withX);
    const one = cycle(p, stepwise, withX);
    expect(one.repairAttempts[0].outcome).toBe('improved');
    expect(one.workflowStatus).toBe('verification_failed');
    const two = cycle(one, stepwise, withX);
    expect(two.repairAttempts[1]).toMatchObject({ attemptNumber: 2, outcome: 'limit_reached' });
    expect(two.workflowStatus).toBe('stopped');
    expect(two.repairAttemptCount).toBe(REPAIR_LIMITS.maxRepairAttempts);
    expect(two.stableVersionId).toBe('p-v1');
    expect(two.repairStopReason).toMatch(/limit/);
    expect(proposeRepair(two, T, stepwise, withX).ok).toBe(false);
    expect(repairEligibility({ ...two, workflowStatus: 'verification_failed' }).eligible).toBe(false);
  });
  it('repeated failure signature stops after one attempt', () => {
    const p = failingCandidate(badAccuracy);
    const same: RepairProvider = (ctx, q, now) => {
      const r = deterministicRepairProvider(ctx, q, now) as RepairProposal;
      return { ...r, proposedChanges: [{ path: 'entity.fields.accuracy', value: { ...(r.proposedChanges[0].value as object), max: 500 } }] };
    };
    const s = cycle(p, same);
    expect(s.repairAttempts[0].outcome).toBe('repeated_failure');
    expect(s.workflowStatus).toBe('stopped');
    expect(s.stableVersionId).toBe('p-v1');
  });
  it('unsupported defect is rejected without an attempt', () => {
    const p = failingCandidate(() => undefined, withX);
    const r = ok(proposeRepair(p, T, undefined, withX));
    expect(r.pendingRepair).toBeNull();
    expect(r.repairAttemptCount).toBe(0);
    expect(r.repairRejections.at(-1)!.reason).toMatch(/No supported definition-level defect/);
  });
});

describe('Scenario C – regression blocks promotion', () => {
  it('detects the regression and stops without replacing stable', () => {
    const p = failingCandidate(badAccuracy);
    const regress: RepairProvider = (ctx, q, now) => {
      const r = deterministicRepairProvider(ctx, q, now) as RepairProposal;
      const latency = q.applicationDefinition!.entity.fields.find((f) => f.key === 'latency')!;
      const change = { path: 'entity.fields.latency', value: { ...latency, max: 5 } };
      return { ...r, proposedChanges: [...r.proposedChanges, change], affectedDefinitionPaths: [...r.affectedDefinitionPaths, change.path] };
    };
    const s = cycle(p, regress);
    expect(s.repairAttempts[0].outcome).toBe('regression');
    expect(s.repairAttempts[0].regressedTestIds).toContain('VC-07');
    expect(s.workflowStatus).toBe('stopped');
    expect(s.stableVersionId).toBe('p-v1');
    expect(s.versions.at(-1)!.lifecycleStatus).toBe('candidate');
  });
});

describe('Scenario D – approved-test immutability', () => {
  it('rejects proposals touching acceptance tests before application', () => {
    const p = failingCandidate(badAccuracy);
    const good = deterministicRepairProvider(buildRepairContext(p, latestReport(p)!), p, T) as RepairProposal;
    for (const raw of [
      { ...good, acceptanceTests: [] },
      { ...good, proposedChanges: [{ path: 'acceptanceTests.0.expectedResult', value: 'x' }], affectedDefinitionPaths: ['acceptanceTests.0.expectedResult'] },
      { ...good, proposedChanges: [{ path: 'acceptanceTestRefs', value: ['AT-01'] }], affectedDefinitionPaths: ['acceptanceTestRefs'] },
    ]) {
      const r = ok(proposeRepair(p, T, () => raw));
      expect(r.pendingRepair).toBeNull();
      expect(r.acceptanceTests).toEqual(p.acceptanceTests);
      expect(r.stableVersionId).toBe('p-v1');
      expect(r.versions).toHaveLength(2);
    }
  });
  it('rejects unrelated paths, removed requirements, code and invalid schema', () => {
    const p = failingCandidate(badAccuracy);
    const good = deterministicRepairProvider(buildRepairContext(p, latestReport(p)!), p, T) as RepairProposal;
    const mk = (path: string, value: unknown) => ({ ...good, proposedChanges: [{ path, value }], affectedDefinitionPaths: [path] });
    const err = (raw: unknown) => { const v = validateProposal(p, raw, 'deterministic'); return 'error' in v ? v.error : ''; };
    expect(err(mk('metrics.passRate', {}))).toMatch(/unrelated/);
    expect(err(mk('metadata.name', 'x'))).toMatch(/outside/);
    expect(err({ ...good, affectedDefinitionPaths: ['entity.fields.latency'] })).toMatch(/not declared/);
    expect(err(mk('entity.fields.modelName', { key: 'modelName', label: 'M', type: 'text', required: false, maxLength: 5 }))).toMatch(/removes required field modelName/);
    expect(err(mk('entity.fields.accuracy', { key: 'accuracy', label: '() => alert(1)', type: 'number', required: true, unit: '%' }))).toMatch(/executable/);
    expect(err(mk('entity.fields.accuracy', { key: 'accuracy', type: 'number' }))).toMatch(/schema validation/);
    expect(validateProposal(p, good, 'deterministic').ok).toBe(true);
  });
});

describe('Scenario E – malformed or unavailable provider', () => {
  it('rejects malformed deterministic output safely', () => {
    const p = failingCandidate(badAccuracy);
    for (const raw of ['garbage', null, {}, { repairId: 'x' }]) {
      const r = ok(proposeRepair(p, T, () => raw));
      expect(r.pendingRepair).toBeNull();
      expect(r.repairRejections.at(-1)!.reason).toMatch(/Malformed/);
      expect(repairEligibility(r).eligible).toBe(true);
    }
  });
  it('HTTP provider failures and out-of-scope responses are rejected and counted', async () => {
    const p = failingCandidate(badAccuracy);
    const down = ok(await requestHttpRepair(p, T, async () => { throw new Error('offline'); }));
    expect(down.aiAssistedCallCount).toBe(1);
    expect(down.repairRejections.at(-1)!.reason).toMatch(/unavailable: offline/);
    const good = deterministicRepairProvider(buildRepairContext(p, latestReport(p)!), p, T) as RepairProposal;
    const scope = ok(await requestHttpRepair(down, T, async () => ({ ...good, repairMode: 'http', proposedChanges: [{ path: 'metadata.name', value: 'x' }], affectedDefinitionPaths: ['metadata.name'] })));
    expect(scope.pendingRepair).toBeNull();
    expect(scope.stableVersionId).toBe('p-v1');
    const accepted = ok(await requestHttpRepair(scope, T, async () => ({ ...good, repairMode: 'http' })));
    expect(accepted.pendingRepair!.repairMode).toBe('http');
    expect(accepted.aiAssistedCallCount).toBe(3);
  });
  it('enforces the maximum of 5 AI-assisted calls', async () => {
    const p = { ...failingCandidate(badAccuracy), aiAssistedCallCount: 5 };
    let called = false;
    const r = await requestHttpRepair(p, T, async () => { called = true; return {}; });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
  it('deterministic repair never counts as a model call', () => {
    const s = cycle(failingCandidate(badAccuracy));
    expect(s.aiAssistedCallCount).toBe(0);
    expect(s.repairAttempts[0].repairMode).toBe('deterministic');
  });
});

describe('selection, persistence, reset and export', () => {
  it('selects affected, path-mapped, core and prerequisite checks', () => {
    const { selection } = selectReverification({ affectedTestIds: ['VC-06'], changedDefinitionPaths: ['entity.fields.accuracy'] } as never);
    const ids = selection.map((s) => s.testId);
    expect(ids).toEqual(expect.arrayContaining(['VC-06', 'VC-05', 'VC-08', 'VC-19', ...CORE_REGRESSION_IDS]));
    expect(ids).not.toContain('VC-10');
  });
  it('persists repair history and attempts across reload', () => {
    const s = cycle(failingCandidate(badAccuracy));
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveStore(store, [s], s.id);
    const l = loadStore(store);
    expect(l.projects[0].repairAttempts).toEqual(s.repairAttempts);
    expect(l.projects[0].repairAttemptCount).toBe(1);
    expect(l.projects[0].versions.at(-1)!.kind).toBe('repair');
  });
  it('resets repairAttemptCount only on a newly approved baseline generation', () => {
    const s = cycle(failingCandidate(badAccuracy));
    let p = ok(A.returnToTestEditing(s, T));
    expect(p.repairAttemptCount).toBe(1);
    p = ok(A.generate(ok(A.approveTests(p, T)), T));
    expect(p.repairAttemptCount).toBe(0);
    expect(p.repairAttempts).toHaveLength(1);
  });
  it('exports repair evidence without secrets', () => {
    const s = cycle(failingCandidate(badAccuracy));
    const e = buildExport(s, T);
    if (!e.ok) throw new Error(e.error);
    expect(ExportSchema.safeParse(JSON.parse(e.json)).success).toBe(true);
    expect(e.data.repair.attempts[0].failureSignatureBefore).toBe('F:VC-06|B:|P:entity.fields');
    expect(e.data.repair.lastStableVersionId).toBe('p-v3');
    expect(e.data.repair.configuration).toEqual({ maxRepairAttempts: 2, maxAiAssistedCalls: 5, defaultMode: 'deterministic' });
    expect(e.json).not.toMatch(/api[_-]?key|secret|password|token|bearer|authorization|https?:\/\//i);
  });
});
