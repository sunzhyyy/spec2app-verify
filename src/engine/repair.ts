import {
  AppDefinitionSchema, REPAIR_LIMITS, RepairProposalSchema, type AcceptanceTest, type AppDefinition, type Project,
  type RepairAttempt, type RepairProposal, type VerificationReport,
} from '../domain/project';
import { canTransition } from '../domain/workflow';
import { generateDefinition } from './demo';
import { DEFAULT_CHECKS, runChecks, type VerificationCheck } from './verify';
import { testsDigest } from './digest';
export { testsDigest };
import { formatZodError, type ActionResult } from './actions';

export const DETERMINISTIC_REPAIR_LABEL = 'Deterministic Repair Mode – no model call';

/** Mandatory core regression set, re-run after every applied repair. */
export const CORE_REGRESSION_IDS = ['VC-01', 'VC-03', 'VC-04', 'VC-05', 'VC-06', 'VC-07', 'VC-16', 'VC-17', 'VC-20', 'VC-21', 'VC-22'];

/** Definition-path categories each check depends on; used for scope, signatures and affected-test selection. */
export const CHECK_PATHS: Record<string, string[]> = {
  'VC-04': ['acceptanceTestRefs', 'entity.fields', 'filters', 'metrics'],
  'VC-05': ['entity.fields'], 'VC-06': ['entity.fields'], 'VC-07': ['entity.fields'], 'VC-08': ['entity.fields', 'metrics'],
  'VC-13': ['metrics'], 'VC-14': ['metrics'], 'VC-15': ['metrics'],
  'VC-22': ['actions', 'layout.sections', 'filters', 'emptyState', 'noResults'],
};
const TOP_PATHS = ['filters', 'actions', 'layout.sections', 'emptyState', 'noResults', 'acceptanceTestRefs'] as const;
const REQUIRED = {
  fields: ['modelName', 'hardwarePlatform', 'precision', 'accuracy', 'latency', 'memoryUsage', 'passed'],
  actions: ['create', 'update', 'delete'], filters: ['hardwarePlatform', 'precision'], metrics: ['recordCount', 'avgLatency', 'passRate'],
};
const STOP_OUTCOMES: RepairAttempt['outcome'][] = ['repeated_failure', 'no_improvement', 'regression', 'limit_reached'];

const pathsOf = (id: string, checks: VerificationCheck[]) => checks.find((c) => c.id === id)?.paths ?? CHECK_PATHS[id] ?? [];
export const categoryOf = (path: string) => (/^(entity\.fields|metrics)\./.test(path) ? path.split('.').slice(0, 2).join('.') : path);


const bad = (r: VerificationReport) => ({
  failed: r.results.filter((x) => x.status === 'failed').map((x) => x.testId).sort(),
  blocked: r.results.filter((x) => x.status === 'blocked').map((x) => x.testId).sort(),
});

/** Deterministic signature: failing IDs, blocked IDs and the definition-path categories involved. No timestamps or IDs. */
export function failureSignature(r: VerificationReport, checks: VerificationCheck[] = DEFAULT_CHECKS): string {
  const { failed, blocked } = bad(r);
  const paths = [...new Set([...failed, ...blocked].flatMap((id) => pathsOf(id, checks)))].sort();
  return `F:${failed.join(',')}|B:${blocked.join(',')}|P:${paths.join(',')}`;
}

export const latestReport = (p: Project) => [...p.verificationReports].reverse().find((r) => r.versionId === p.currentVersionId) ?? null;

export function baselineOf(p: Project, versionId: string | null): string | null {
  let v = p.versions.find((x) => x.id === versionId);
  while (v && v.kind === 'repair') v = p.versions.find((x) => x.id === v!.parentVersionId);
  return v?.id ?? null;
}
const attemptsFor = (p: Project) => {
  const base = baselineOf(p, p.currentVersionId);
  return p.repairAttempts.filter((a) => baselineOf(p, a.sourceVersionId) === base);
};

export interface Eligibility { eligible: boolean; reason: string }

export function repairEligibility(p: Project): Eligibility {
  const no = (reason: string) => ({ eligible: false, reason });
  if (p.workflowStatus === 'verified') return no('Verification passed; no repair is needed.');
  if (p.workflowStatus === 'stopped') return no(`Repair stopped: ${p.repairStopReason ?? 'stop condition reached'}.`);
  if (p.workflowStatus !== 'verification_failed') return no('Repair is only available after a failed verification.');
  const def = p.applicationDefinition;
  const version = p.versions.find((v) => v.id === p.currentVersionId);
  if (!def || !version) return no('No candidate version exists.');
  const report = latestReport(p);
  if (!report || bad(report).failed.length + bad(report).blocked.length === 0) return no('No failed or blocked verification result exists.');
  if (!AppDefinitionSchema.safeParse(def).success) return no('The application definition is invalid and cannot be safely inspected.');
  if (!p.testsApprovedAt || !p.acceptanceTests.every((t) => t.approved)) return no('Approved acceptance tests are not locked.');
  if (version.acceptanceTestsDigest && version.acceptanceTestsDigest !== testsDigest(p.acceptanceTests)) return no('Approved tests changed since this candidate was generated.');
  if (p.repairAttemptCount >= REPAIR_LIMITS.maxRepairAttempts) return no(`Repair limit reached (${REPAIR_LIMITS.maxRepairAttempts}).`);
  const last = attemptsFor(p).at(-1);
  if (last && STOP_OUTCOMES.includes(last.outcome)) return no(`Previous repair ended with ${last.outcome}.`);
  return { eligible: true, reason: `${bad(report).failed.length} failed, ${bad(report).blocked.length} blocked check(s) in ${version.id}.` };
}

export interface RepairContext {
  currentVersionId: string;
  failures: { testId: string; status: string; expectedResult: string; observedResult: string; evidence: string }[];
  definitionFragments: Record<string, unknown>;
  approvedRequirementIds: string[];
  previousOutcomes: { attemptNumber: number; outcome: string; failureSignatureAfter: string | null }[];
}

function readPath(def: AppDefinition, cat: string): unknown {
  return cat === 'entity.fields' ? def.entity.fields : cat === 'layout.sections' ? def.layout.sections : def[cat as keyof AppDefinition];
}

/** Compact, secret-free context: only failing checks, relevant definition fragments and approved test IDs. */
export function buildRepairContext(p: Project, report: VerificationReport, checks: VerificationCheck[] = DEFAULT_CHECKS): RepairContext {
  const failures = report.results.filter((r) => r.status !== 'passed');
  const cats = [...new Set(failures.flatMap((r) => pathsOf(r.testId, checks)))];
  return {
    currentVersionId: report.versionId,
    failures: failures.map((r) => ({ testId: r.testId, status: r.status, expectedResult: r.expectedResult, observedResult: r.observedResult, evidence: r.evidence.slice(0, 300) })),
    definitionFragments: Object.fromEntries(cats.map((c) => [c, readPath(p.applicationDefinition!, c)])),
    approvedRequirementIds: p.acceptanceTests.map((t) => t.id),
    previousOutcomes: attemptsFor(p).map((a) => ({ attemptNumber: a.attemptNumber, outcome: a.outcome, failureSignatureAfter: a.failureSignatureAfter })),
  };
}

export type RepairProvider = (ctx: RepairContext, p: Project, now: string) => unknown;
export class UnsupportedRepairError extends Error {}

/** Compares relevant paths with the deterministic reference definition. Never calls a model. */
export const deterministicRepairProvider: RepairProvider = (ctx, p, now) => {
  const def = p.applicationDefinition!;
  const ref = AppDefinitionSchema.parse(generateDefinition(p.structuredAnalysis!, p.acceptanceTests, {
    versionNumber: def.version.number, now: def.version.generatedAt, testsApprovedAt: def.version.testsApprovedAt,
  }));
  const cats = Object.keys(ctx.definitionFragments);
  const changes: { path: string; value: unknown }[] = [];
  const causes: string[] = [];
  const diffList = <T extends { key?: string; id?: string }>(prefix: string, cur: T[], want: T[], k: 'key' | 'id') => {
    for (const w of want) {
      const c = cur.find((x) => x[k] === w[k]);
      if (JSON.stringify(c) === JSON.stringify(w)) continue;
      changes.push({ path: `${prefix}.${w[k]}`, value: w });
      const props = c ? Object.keys(w).filter((q) => JSON.stringify(c[q as keyof T]) !== JSON.stringify(w[q as keyof T])) : ['missing'];
      causes.push(`${prefix}.${w[k]}: ${props.map((q) => (c ? `${q} ${JSON.stringify(c[q as keyof T])} ≠ ${JSON.stringify(w[q as keyof T])}` : 'missing')).join(', ')}`);
    }
  };
  if (cats.includes('entity.fields')) diffList('entity.fields', def.entity.fields, ref.entity.fields, 'key');
  if (cats.includes('metrics')) diffList('metrics', def.metrics, ref.metrics, 'id');
  for (const t of TOP_PATHS) {
    if (cats.includes(t) && JSON.stringify(readPath(def, t)) !== JSON.stringify(readPath(ref, t))) {
      changes.push({ path: t, value: readPath(ref, t) });
      causes.push(`${t} differs from the approved specification`);
    }
  }
  if (!changes.length) throw new UnsupportedRepairError('No supported definition-level defect found for the failing checks; this failure needs manual action.');
  return {
    repairId: `${ctx.currentVersionId}-repair-${p.repairAttemptCount + 1}`,
    sourceVersionId: ctx.currentVersionId,
    failedTestIds: ctx.failures.filter((f) => f.status === 'failed').map((f) => f.testId),
    blockedTestIds: ctx.failures.filter((f) => f.status === 'blocked').map((f) => f.testId),
    diagnosedCause: causes.join('; '),
    affectedDefinitionPaths: changes.map((c) => c.path),
    proposedChanges: changes,
    preservedRequirements: ctx.approvedRequirementIds,
    expectedImprovement: `Restore ${changes.length} definition path(s) so ${ctx.failures.map((f) => f.testId).join(', ')} can pass.`,
    regressionRisk: 'low',
    repairMode: 'deterministic',
    createdAt: now,
  } satisfies RepairProposal;
};

function hasCode(v: unknown): boolean {
  if (typeof v === 'function') return true;
  if (typeof v === 'string') return /(=>|function\s*\(|<script|eval\(|new\s+Function|import\()/i.test(v);
  if (v && typeof v === 'object') return Object.values(v).some(hasCode);
  return false;
}

function applyChanges(def: AppDefinition, changes: RepairProposal['proposedChanges']): unknown {
  const d = structuredClone(def) as Record<string, unknown> & AppDefinition;
  for (const { path, value } of changes) {
    const m = /^(entity\.fields|metrics)\.([A-Za-z0-9]+)$/.exec(path);
    if (m) {
      const list = (m[1] === 'metrics' ? d.metrics : d.entity.fields) as { key?: string; id?: string }[];
      const k = m[1] === 'metrics' ? 'id' : 'key';
      const i = list.findIndex((x) => x[k] === m[2]);
      if (i >= 0) list[i] = value as never; else list.push(value as never);
    } else if (path === 'layout.sections') d.layout = { ...d.layout, sections: value as never };
    else d[path] = value;
  }
  return d;
}

export type ProposalCheck = { ok: true; proposal: RepairProposal; definition: AppDefinition } | { ok: false; error: string };

/** Full capability invariants for a definition (not a delta). An empty result is required for stable promotion. */
export function missingCapabilities(d: AppDefinition, tests: AcceptanceTest[]): string[] {
  return [
    ...REQUIRED.fields.filter((k) => !d.entity.fields.some((f) => f.key === k && f.required)).map((k) => `field ${k}`),
    ...REQUIRED.actions.filter((a) => !d.actions.includes(a as never)).map((a) => `action ${a}`),
    ...REQUIRED.filters.filter((f) => !d.filters.some((x) => x.field === f)).map((f) => `filter ${f}`),
    ...REQUIRED.metrics.filter((m) => !d.metrics.some((x) => x.id === m)).map((m) => `metric ${m}`),
    ...['metrics', 'filters', 'form', 'table'].filter((x) => !d.layout.sections.includes(x as never)).map((x) => `section ${x}`),
    ...tests.filter((t) => !d.acceptanceTestRefs.includes(t.id)).map((t) => `test reference ${t.id}`),
    ...(d.emptyState?.title ? [] : ['empty state']),
    ...(d.noResults?.title ? [] : ['no-results state']),
  ];
}

/** Rejects any proposal outside the repair scope before anything is applied. */
export function validateProposal(p: Project, raw: unknown, mode: RepairProposal['repairMode'], checks: VerificationCheck[] = DEFAULT_CHECKS): ProposalCheck {
  const no = (error: string): ProposalCheck => ({ ok: false, error });
  if (raw && typeof raw === 'object' && 'acceptanceTests' in raw) return no('Proposal attempts to modify approved acceptance tests.');
  const parsed = RepairProposalSchema.safeParse(raw);
  if (!parsed.success) return no(`Malformed proposal: ${formatZodError(parsed.error, 3)}`);
  const pr = parsed.data;
  if (pr.repairMode !== mode) return no(`Proposal repairMode "${pr.repairMode}" does not match provider "${mode}".`);
  if (pr.sourceVersionId !== p.currentVersionId) return no('Proposal targets a version that is not the current candidate.');
  if (hasCode(pr)) return no('Proposal contains executable code.');
  const report = latestReport(p);
  const allowed = new Set(report ? [...bad(report).failed, ...bad(report).blocked].flatMap((id) => pathsOf(id, checks)) : []);
  for (const c of pr.proposedChanges) {
    if (/^acceptanceTests|^tests|approved/i.test(c.path)) return no('Proposal attempts to modify approved acceptance tests.');
    if (!/^(entity\.fields\.[a-z][A-Za-z0-9]*|metrics\.[A-Za-z0-9]+|filters|actions|layout\.sections|emptyState|noResults|acceptanceTestRefs)$/.test(c.path)) {
      return no(`Path "${c.path}" is outside the repairable definition scope.`);
    }
    if (!pr.affectedDefinitionPaths.includes(c.path)) return no(`Path "${c.path}" is not declared in affectedDefinitionPaths.`);
    if (!allowed.has(categoryOf(c.path))) return no(`Path "${c.path}" is unrelated to the failed or blocked checks.`);
  }
  const def = AppDefinitionSchema.safeParse(applyChanges(p.applicationDefinition!, pr.proposedChanges));
  if (!def.success) return no(`Repaired definition fails schema validation: ${formatZodError(def.error, 3)}`);
  const d = def.data;
  // Incremental repair may leave capabilities missing that were already missing, but it may never remove one.
  // The candidate still cannot become stable until missingCapabilities() is empty (enforced in reverifyRepair).
  const before = new Set(missingCapabilities(p.applicationDefinition!, p.acceptanceTests));
  const missing = missingCapabilities(d, p.acceptanceTests).filter((m) => !before.has(m) && !m.startsWith('test reference'));
  if (missing.length) return no(`Proposal removes required ${missing.join(', ')}.`);
  if (d.acceptanceTestRefs.join() !== p.acceptanceTests.map((t) => t.id).join()) return no('Proposal changes acceptance-test references away from the approved set.');
  return { ok: true, proposal: pr, definition: d };
}

const reject = (p: Project, now: string, mode: RepairProposal['repairMode'], reason: string, repairId: string | null = null, patch: Partial<Project> = {}): ActionResult => ({
  ok: true,
  project: { ...p, ...patch, pendingRepair: null, updatedAt: now, repairRejections: [...p.repairRejections, { repairId, repairMode: mode, sourceVersionId: p.currentVersionId, reason, createdAt: now }] },
  notice: `Repair proposal rejected and not applied: ${reason} The project and stable version are unchanged.`,
});

function finishProposal(p: Project, now: string, raw: unknown, mode: RepairProposal['repairMode'], checks: VerificationCheck[], patch: Partial<Project> = {}): ActionResult {
  const v = validateProposal(p, raw, mode, checks);
  const id = raw && typeof raw === 'object' && typeof (raw as { repairId?: unknown }).repairId === 'string' ? (raw as { repairId: string }).repairId : null;
  if ('error' in v) return reject(p, now, mode, v.error, id, patch);
  return { ok: true, project: { ...p, ...patch, pendingRepair: v.proposal, updatedAt: now }, notice: 'Repair proposal ready for review. Nothing has been applied yet.' };
}

/** Produces a proposal for review. Deterministic by default; never applies anything. */
export function proposeRepair(p: Project, now: string, provider: RepairProvider = deterministicRepairProvider, checks: VerificationCheck[] = DEFAULT_CHECKS): ActionResult {
  const e = repairEligibility(p);
  if (!e.eligible) return { ok: false, error: `Repair is not available: ${e.reason}` };
  const ctx = buildRepairContext(p, latestReport(p)!, checks);
  let raw: unknown;
  try {
    raw = provider(ctx, p, now);
  } catch (err) {
    return reject(p, now, 'deterministic', err instanceof Error ? err.message : String(err));
  }
  return finishProposal(p, now, raw, 'deterministic', checks);
}

export type HttpRepairCall = (ctx: RepairContext) => Promise<unknown>;

/** Optional HTTP provider boundary. The endpoint comes from the environment only and is never persisted. No credentials are sent. */
export function createHttpRepairCall(endpoint: string, fetchFn: typeof fetch = fetch): HttpRepairCall {
  return async (ctx) => {
    const res = await fetchFn(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ctx) });
    if (!res.ok) throw new Error(`Repair provider responded with HTTP ${res.status}.`);
    return res.json();
  };
}

export async function requestHttpRepair(p: Project, now: string, call: HttpRepairCall, checks: VerificationCheck[] = DEFAULT_CHECKS): Promise<ActionResult> {
  const e = repairEligibility(p);
  if (!e.eligible) return { ok: false, error: `Repair is not available: ${e.reason}` };
  if (p.aiAssistedCallCount >= REPAIR_LIMITS.maxAiAssistedCalls) {
    return { ok: false, error: `AI-assisted call limit reached (${REPAIR_LIMITS.maxAiAssistedCalls}). Use deterministic repair or manual action.` };
  }
  const patch = { aiAssistedCallCount: p.aiAssistedCallCount + 1 };
  let raw: unknown;
  try {
    raw = await call(buildRepairContext(p, latestReport(p)!, checks));
  } catch (err) {
    return reject(p, now, 'http', `Provider unavailable: ${err instanceof Error ? err.message : String(err)}`, null, patch);
  }
  return finishProposal(p, now, raw, 'http', checks, patch);
}

export function cancelRepair(p: Project, now: string): ActionResult {
  if (!p.pendingRepair) return { ok: false, error: 'There is no repair proposal to cancel.' };
  return { ok: true, project: { ...p, pendingRepair: null, updatedAt: now }, notice: 'Repair proposal discarded. Nothing was applied.' };
}

/** Deliberate user action: applies the reviewed proposal as a NEW candidate. The stable version is untouched. */
export function applyRepair(p: Project, now: string, checks: VerificationCheck[] = DEFAULT_CHECKS): ActionResult {
  const pr = p.pendingRepair;
  if (!pr) return { ok: false, error: 'Review a repair proposal before applying it.' };
  const e = repairEligibility(p);
  if (!e.eligible) return { ok: false, error: `Repair is not available: ${e.reason}` };
  const v = validateProposal(p, pr, pr.repairMode, checks);
  if ('error' in v) return reject(p, now, pr.repairMode, v.error, pr.repairId);
  const source = latestReport(p)!;
  const attemptNumber = p.repairAttemptCount + 1;
  const id = `${p.id}-v${p.versions.length + 1}`;
  const failed = bad(source);
  const changed = pr.proposedChanges.map((c) => c.path);
  const attempt: RepairAttempt = {
    attemptNumber, repairId: pr.repairId, repairMode: pr.repairMode, sourceVersionId: p.currentVersionId!, candidateVersionId: id,
    sourceReportId: source.id, reverificationReportId: null, failureSignatureBefore: failureSignature(source, checks), failureSignatureAfter: null,
    failedCountBefore: failed.failed.length, failedCountAfter: null, blockedCountBefore: failed.blocked.length, blockedCountAfter: null,
    changedDefinitionPaths: changed, affectedTestIds: [...failed.failed, ...failed.blocked], regressionTestIds: [], regressedTestIds: [],
    outcome: 'pending_reverification', stopReason: null, createdAt: now,
    proposalAccepted: true, candidateStructurallyValid: null, missingCapabilities: [], candidateVerificationPassed: null, promotedToStable: false,
    remainingFailedTestIds: [], remainingBlockedTestIds: [], lastStableVersionId: p.stableVersionId, suggestedNextAction: null,
  };
  return {
    ok: true,
    project: {
      ...p,
      workflowStatus: 'generated',
      applicationDefinition: v.definition,
      currentVersionId: id,
      pendingRepair: null,
      repairAttemptCount: attemptNumber,
      repairAttempts: [...p.repairAttempts, attempt],
      versions: [...p.versions, {
        id, parentVersionId: p.currentVersionId, createdAt: now, reason: `Repair ${attemptNumber} of ${REPAIR_LIMITS.maxRepairAttempts} (${pr.repairMode}): ${pr.diagnosedCause}`,
        applicationDefinition: v.definition, acceptanceTestIds: p.acceptanceTests.map((t) => t.id), verificationStatus: 'pending', lifecycleStatus: 'candidate',
        kind: 'repair', repairId: pr.repairId, repairAttemptNumber: attemptNumber, changedDefinitionPaths: changed, acceptanceTestsDigest: testsDigest(p.acceptanceTests),
      }],
      updatedAt: now,
    },
    notice: `Repair ${attemptNumber} of ${REPAIR_LIMITS.maxRepairAttempts} applied as new candidate ${id}. Run reverification next; the stable version is unchanged.`,
  };
}

export const pendingAttempt = (p: Project) => p.repairAttempts.find((a) => a.outcome === 'pending_reverification' && a.candidateVersionId === p.currentVersionId) ?? null;

/** Selects affected checks, checks mapped to changed paths, the core regression set, and their prerequisites. */
export function selectReverification(attempt: RepairAttempt, checks: VerificationCheck[] = DEFAULT_CHECKS) {
  const reasons = new Map<string, string>();
  const add = (id: string, why: string) => { if (!reasons.has(id)) reasons.set(id, why); };
  attempt.affectedTestIds.forEach((id) => add(id, 'failed or blocked before repair'));
  const cats = new Set(attempt.changedDefinitionPaths.map(categoryOf));
  checks.forEach((c) => { if (pathsOf(c.id, checks).some((x) => cats.has(x))) add(c.id, 'mapped to a changed definition path'); });
  CORE_REGRESSION_IDS.forEach((id) => add(id, 'core regression set'));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of checks) if (reasons.has(c.id)) for (const r of c.requires ?? []) if (!reasons.has(r)) { add(r, `prerequisite of ${c.id}`); grew = true; }
  }
  const selection = checks.filter((c) => reasons.has(c.id)).map((c) => ({ testId: c.id, reason: reasons.get(c.id)! }));
  return { selection, carriedForward: checks.filter((c) => !reasons.has(c.id)).map((c) => c.id) };
}

export function reverifyRepair(p: Project, now: string, checks: VerificationCheck[] = DEFAULT_CHECKS): ActionResult {
  const attempt = pendingAttempt(p);
  if (!attempt || p.workflowStatus !== 'generated' || !canTransition('generated', 'verifying')) return { ok: false, error: 'No applied repair is waiting for reverification.' };
  const source = p.verificationReports.find((r) => r.id === attempt.sourceReportId)!;
  const { selection, carriedForward } = selectReverification(attempt, checks);
  const only = new Set(selection.map((s) => s.testId));
  const report = { ...runChecks(p, now, checks.filter((c) => only.has(c.id))), scope: 'targeted' as const, selection, carriedForward };
  const after = bad(report);
  const status = new Map(report.results.map((r) => [r.testId, r.status]));
  const regressed = source.results.filter((r) => r.status === 'passed' && status.has(r.testId) && status.get(r.testId) !== 'passed').map((r) => r.testId);
  const sigAfter = failureSignature(report, checks);
  const beforeBad = attempt.failedCountBefore + attempt.blockedCountBefore;
  const afterBad = after.failed.length + after.blocked.length;
  const fixedOne = attempt.affectedTestIds.some((id) => status.get(id) === 'passed');
  const schemaOk = AppDefinitionSchema.safeParse(p.applicationDefinition).success;
  const missingCaps = p.applicationDefinition ? missingCapabilities(p.applicationDefinition, p.acceptanceTests) : ['definition'];
  const structurallyValid = schemaOk && missingCaps.length === 0;
  const allPass = report.passed && regressed.length === 0 && structurallyValid;
  let outcome: RepairAttempt['outcome'];
  let stopReason: string | null = null;
  if (allPass) outcome = 'repaired';
  else if (report.passed && !structurallyValid) { outcome = 'no_improvement'; stopReason = `Candidate is missing required capabilities: ${missingCaps.join(', ')}.`; }
  else if (regressed.length) { outcome = 'regression'; stopReason = `Repair introduced a regression in ${regressed.join(', ')}.`; }
  else if (sigAfter === attempt.failureSignatureBefore) { outcome = 'repeated_failure'; stopReason = 'The same failure signature repeated without improvement.'; }
  else if (!(afterBad < beforeBad || fixedOne)) { outcome = 'no_improvement'; stopReason = 'The number of failed or blocked checks did not improve.'; }
  else if (attempt.attemptNumber >= REPAIR_LIMITS.maxRepairAttempts) { outcome = 'limit_reached'; stopReason = `Repair limit of ${REPAIR_LIMITS.maxRepairAttempts} attempts reached with checks still failing.`; }
  else outcome = 'improved';
  const done: RepairAttempt = {
    ...attempt, reverificationReportId: report.id, failureSignatureAfter: sigAfter, failedCountAfter: after.failed.length, blockedCountAfter: after.blocked.length,
    regressionTestIds: selection.map((s) => s.testId).filter((id) => CORE_REGRESSION_IDS.includes(id)), regressedTestIds: regressed, outcome, stopReason,
    candidateStructurallyValid: structurallyValid, missingCapabilities: missingCaps, candidateVerificationPassed: report.passed && regressed.length === 0,
    promotedToStable: allPass, remainingFailedTestIds: after.failed, remainingBlockedTestIds: after.blocked,
    lastStableVersionId: allPass ? p.currentVersionId : p.stableVersionId,
    suggestedNextAction: allPass ? null : stopReason
      ? 'Manual action: return to test editing, review the approved requirement, and generate a new baseline.'
      : 'Review and apply one more deliberate repair for the remaining checks.',
  };
  const workflowStatus = allPass ? 'verified' : stopReason ? 'stopped' : 'verification_failed';
  return {
    ok: true,
    project: {
      ...p,
      workflowStatus,
      verificationReports: [...p.verificationReports, report],
      repairAttempts: p.repairAttempts.map((a) => (a === attempt ? done : a)),
      versions: p.versions.map((v) => (v.id === p.currentVersionId ? { ...v, verificationStatus: allPass ? 'passed' : 'failed', lifecycleStatus: allPass ? 'stable' : 'candidate' } : v)),
      stableVersionId: allPass ? p.currentVersionId : p.stableVersionId,
      repairStopReason: stopReason,
      updatedAt: now,
    },
    notice: allPass
      ? `Repair succeeded: ${report.results.length} selected checks passed (targeted reverification, ${carriedForward.length} carried forward). ${p.currentVersionId} is now stable.`
      : stopReason
        ? `Repair stopped: ${stopReason} Stable version ${p.stableVersionId ?? 'none'} is unchanged.`
        : `Repair improved results but ${afterBad} check(s) still fail. One more deliberate repair is allowed.`,
  };
}
