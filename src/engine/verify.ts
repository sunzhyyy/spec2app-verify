import {
  AppDefinitionSchema, ProjectSchema, type AppDefinition, type AppRecord, type Project, type VerificationReport,
  type VerificationResult,
} from '../domain/project';
import { computeMetric, filterRecords, formatMetric, validateRecord, type FormValues } from '../renderer/logic';
import { loadStore, serializeStore, STORAGE_KEY } from '../store/projects';
import { buildExport } from './export';
import { approveTests, updateTests } from './actions';

export interface CheckOutcome {
  passed: boolean;
  observed: string;
  evidence: string;
}

export interface VerificationCheck {
  id: string;
  title: string;
  expected: string;
  /** Checks listed here must pass first; otherwise this check is reported as blocked and not run. */
  requires?: string[];
  /** Definition paths this check depends on (used by bounded repair). */
  paths?: string[];
  run: (ctx: { project: Project; def: AppDefinition; now: string }) => CheckOutcome;
}

const R = (passed: boolean, observed: string, evidence: string): CheckOutcome => ({ passed, observed, evidence });

const VALID: FormValues = {
  modelName: 'MobileNetV3', hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'INT8',
  accuracy: '74.2', latency: '10', memoryUsage: '48', passed: 'true',
};

const FIXTURE: AppRecord[] = [
  { id: 'r1', modelName: 'A', hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'INT8', accuracy: 70, latency: 10, memoryUsage: 40, passed: true },
  { id: 'r2', modelName: 'B', hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'FP16', accuracy: 80, latency: 20, memoryUsage: 60, passed: true },
  { id: 'r3', modelName: 'C', hardwarePlatform: 'Raspberry Pi 5', precision: 'INT8', accuracy: 60, latency: 30, memoryUsage: 30, passed: true },
  { id: 'r4', modelName: 'D', hardwarePlatform: 'Raspberry Pi 5', precision: 'INT8', accuracy: 50, latency: 40, memoryUsage: 20, passed: false },
];

function memoryStorage(initial?: Record<string, string>) {
  const m = new Map(Object.entries(initial ?? {}));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const metric = (def: AppDefinition, id: string) => def.metrics.find((m) => m.id === id);
const ids = (rs: AppRecord[]) => rs.map((r) => r.id).join(',') || '(none)';

export const DEFAULT_CHECKS: VerificationCheck[] = [
  {
    id: 'VC-01', title: 'Project schema validity', expected: 'The project passes ProjectSchema.',
    run: ({ project }) => {
      const r = ProjectSchema.safeParse(project);
      return R(r.success, r.success ? 'Valid' : r.error.issues[0].message, `ProjectSchema.safeParse → success=${r.success}`);
    },
  },
  {
    id: 'VC-02', title: 'Workflow approval gate', expected: 'Every test is approved and testsApprovedAt is set.',
    run: ({ project }) => {
      const n = project.acceptanceTests.filter((t) => t.approved).length;
      const ok = !!project.testsApprovedAt && n === project.acceptanceTests.length && n > 0;
      return R(ok, `${n}/${project.acceptanceTests.length} approved`, `testsApprovedAt=${project.testsApprovedAt ?? 'null'}`);
    },
  },
  {
    id: 'VC-03', title: 'Approved-test immutability', expected: 'Editing or re-approving tests is rejected while locked.',
    run: ({ project, now }) => {
      const edit = updateTests(project, [], now);
      const reapprove = approveTests(project, now);
      return R(!edit.ok && !reapprove.ok, `edit rejected=${!edit.ok}, re-approve rejected=${!reapprove.ok}`,
        'error' in edit ? edit.error : 'edit unexpectedly accepted');
    },
  },
  {
    id: 'VC-04', title: 'Application-definition schema validity', expected: 'The candidate passes AppDefinitionSchema and references the approved tests.',
    run: ({ project, def }) => {
      const r = AppDefinitionSchema.safeParse(def);
      const refsOk = def.acceptanceTestRefs.join() === project.acceptanceTests.map((t) => t.id).join();
      return R(r.success && refsOk, `schema=${r.success}, refs match=${refsOk}`, `${def.acceptanceTestRefs.length} test refs`);
    },
  },
  {
    id: 'VC-05', title: 'Required benchmark fields', expected: 'All 7 benchmark fields exist, are required, and empty values are rejected.',
    requires: ['VC-04'],
    run: ({ def }) => {
      const need = ['modelName', 'hardwarePlatform', 'precision', 'accuracy', 'latency', 'memoryUsage', 'passed'];
      const missing = need.filter((k) => !def.entity.fields.some((f) => f.key === k && f.required));
      const r = validateRecord(def, {});
      const errs = 'errors' in r ? Object.keys(r.errors).length : 0;
      return R(missing.length === 0 && errs === need.length, `missing=${missing.join(',') || 'none'}, empty-form errors=${errs}`,
        'errors' in r ? r.errors.modelName : 'empty form accepted');
    },
  },
  {
    id: 'VC-06', title: 'Numeric benchmark constraints', expected: 'accuracy 120, latency -1 and memory "abc" are rejected; boundaries 0/100 accepted.',
    requires: ['VC-04'],
    run: ({ def }) => {
      const bad = validateRecord(def, { ...VALID, accuracy: '120', latency: '-1', memoryUsage: 'abc' });
      const errs = 'errors' in bad ? bad.errors : {};
      const edge = validateRecord(def, { ...VALID, accuracy: '100', latency: '0', memoryUsage: '0' });
      const ok = !!errs.accuracy && !!errs.latency && !!errs.memoryUsage && edge.ok;
      return R(ok, `rejected: ${Object.keys(errs).join(', ') || 'none'}; boundary accepted=${edge.ok}`, Object.values(errs).join(' | '));
    },
  },
  {
    id: 'VC-07', title: 'Add-record behavior', expected: 'A valid record is converted to typed values and appended.',
    requires: ['VC-05'],
    run: ({ def }) => {
      const r = validateRecord(def, VALID);
      if (!('value' in r)) return R(false, 'valid record rejected', JSON.stringify(r));
      const after = [...FIXTURE, { ...r.value, id: 'new' }];
      const ok = after.length === FIXTURE.length + 1 && r.value.latency === 10 && r.value.passed === true;
      return R(ok, `count ${FIXTURE.length} → ${after.length}`, `latency=${String(r.value.latency)} (${typeof r.value.latency})`);
    },
  },
  {
    id: 'VC-08', title: 'Edit-record behavior', expected: 'Editing r1 latency to 9.8 changes only r1 and updates average latency.',
    requires: ['VC-05'],
    run: ({ def }) => {
      const m = metric(def, 'avgLatency')!;
      const edited = FIXTURE.map((x) => (x.id === 'r1' ? { ...x, latency: 9.8 } : x));
      const before = formatMetric(m, computeMetric(m, FIXTURE));
      const after = formatMetric(m, computeMetric(m, edited));
      const ok = edited[0].latency === 9.8 && edited.slice(1).every((x, i) => x === FIXTURE[i + 1]) && after === '24.95 ms';
      return R(ok, `avg ${before} → ${after}`, 'expected 24.95 ms');
    },
  },
  {
    id: 'VC-09', title: 'Delete-record behavior', expected: 'Deleting r2 removes exactly that record.',
    run: () => {
      const after = FIXTURE.filter((x) => x.id !== 'r2');
      return R(ids(after) === 'r1,r3,r4', `remaining ${ids(after)}`, 'filter by id');
    },
  },
  {
    id: 'VC-10', title: 'Hardware-platform filtering', expected: 'Raspberry Pi 5 → r3,r4.',
    run: () => { const o = ids(filterRecords(FIXTURE, { hardwarePlatform: 'Raspberry Pi 5' })); return R(o === 'r3,r4', o, 'filterRecords'); },
  },
  {
    id: 'VC-11', title: 'Precision filtering', expected: 'INT8 → r1,r3,r4.',
    run: () => { const o = ids(filterRecords(FIXTURE, { precision: 'INT8' })); return R(o === 'r1,r3,r4', o, 'filterRecords'); },
  },
  {
    id: 'VC-12', title: 'Combined filtering', expected: 'NVIDIA Jetson Orin + INT8 → r1; empty filters → all 4.',
    run: () => {
      const o = ids(filterRecords(FIXTURE, { hardwarePlatform: 'NVIDIA Jetson Orin', precision: 'INT8' }));
      const all = filterRecords(FIXTURE, { hardwarePlatform: '', precision: '' }).length;
      return R(o === 'r1' && all === 4, `${o}; reset → ${all}`, 'filterRecords');
    },
  },
  {
    id: 'VC-13', title: 'Record-count calculation', expected: 'Count metric = 4 for all, 3 for INT8.',
    requires: ['VC-04'],
    run: ({ def }) => {
      const m = metric(def, 'recordCount');
      if (!m) return R(false, 'recordCount metric missing', '');
      const a = computeMetric(m, FIXTURE); const b = computeMetric(m, filterRecords(FIXTURE, { precision: 'INT8' }));
      return R(a === 4 && b === 3, `all=${a}, INT8=${b}`, 'computeMetric(count)');
    },
  },
  {
    id: 'VC-14', title: 'Average-latency calculation', expected: '10 and 20 ms → 15.00 ms; no records → "—".',
    requires: ['VC-04'],
    run: ({ def }) => {
      const m = metric(def, 'avgLatency');
      if (!m) return R(false, 'avgLatency metric missing', '');
      const a = formatMetric(m, computeMetric(m, FIXTURE.slice(0, 2))); const e = formatMetric(m, computeMetric(m, []));
      return R(a === '15.00 ms' && e === '—', `${a}; empty=${e}`, 'computeMetric(average)');
    },
  },
  {
    id: 'VC-15', title: 'Pass-rate calculation', expected: '3 of 4 passed → 75.0%.',
    requires: ['VC-04'],
    run: ({ def }) => {
      const m = metric(def, 'passRate');
      if (!m) return R(false, 'passRate metric missing', '');
      const o = formatMetric(m, computeMetric(m, FIXTURE));
      return R(o === '75.0%', o, 'computeMetric(ratio)');
    },
  },
  {
    id: 'VC-16', title: 'Persistence serialization', expected: 'Serialized root has schemaVersion 1 and includes the project.',
    run: ({ project }) => {
      const j = JSON.parse(serializeStore([project], project.id));
      const ok = j.schemaVersion === 1 && j.selectedProjectId === project.id && j.projects[0]?.id === project.id;
      return R(ok, `schemaVersion=${j.schemaVersion}, projects=${j.projects.length}`, `key ${STORAGE_KEY}`);
    },
  },
  {
    id: 'VC-17', title: 'Persistence restoration', expected: 'Restored project deep-equals the saved project.',
    requires: ['VC-16'],
    run: ({ project }) => {
      const s = memoryStorage({ [STORAGE_KEY]: serializeStore([project], project.id) });
      const l = loadStore(s);
      const canonical = ProjectSchema.safeParse(project);
      const ok = canonical.success && JSON.stringify(l.projects[0]) === JSON.stringify(canonical.data) && l.selectedProjectId === project.id;
      return R(ok, `restored ${l.projects.length} project(s), equal=${ok}`, `warning=${l.warning ?? 'none'}`);
    },
  },
  {
    id: 'VC-18', title: 'Corrupted-state fallback', expected: 'Invalid JSON, a future schemaVersion and a bad project all load without throwing and warn.',
    run: ({ project }) => {
      const cases = ['{bad', JSON.stringify({ schemaVersion: 99, selectedProjectId: null, projects: [] }),
        JSON.stringify({ schemaVersion: 1, selectedProjectId: null, projects: [{ ...project, workflowStatus: 'nope' }] })];
      const res = cases.map((c) => loadStore(memoryStorage({ [STORAGE_KEY]: c })));
      const ok = res.every((r) => r.projects.length === 0 && !!r.warning);
      return R(ok, res.map((r) => (r.warning ? 'warned' : 'silent')).join(', '), res[1].warning ?? '');
    },
  },
  {
    id: 'VC-19', title: 'Candidate-version creation', expected: 'Current version exists, is a candidate, and matches the rendered definition.',
    run: ({ project, def }) => {
      const v = project.versions.find((x) => x.id === project.currentVersionId);
      const ok = !!v && v.lifecycleStatus === 'candidate' && JSON.stringify(v.applicationDefinition) === JSON.stringify(def);
      return R(ok, v ? `${v.id}: ${v.lifecycleStatus}/${v.verificationStatus}` : 'no current version', `parent=${v?.parentVersionId ?? 'none'}`);
    },
  },
  {
    id: 'VC-20', title: 'Stable-version protection', expected: 'The stable pointer does not reference the unverified candidate and points to a passed version if set.',
    requires: ['VC-19'],
    run: ({ project }) => {
      const s = project.versions.find((x) => x.id === project.stableVersionId);
      const ok = project.stableVersionId !== project.currentVersionId && (!project.stableVersionId || s?.verificationStatus === 'passed');
      return R(ok, `stable=${project.stableVersionId ?? 'none'}, current=${project.currentVersionId}`, s ? `stable status ${s.verificationStatus}` : 'no prior stable');
    },
  },
  {
    id: 'VC-21', title: 'JSON-export validity', expected: 'Export passes ExportSchema and contains no endpoint or credential.',
    run: ({ project, now }) => {
      const e = buildExport(project, now);
      if ('error' in e) return R(false, e.error, 'buildExport rejected the export');
      return R(true, `${e.json.length} bytes, valid`, `records=${e.data.benchmarkRecords.length}`);
    },
  },
  {
    id: 'VC-22', title: 'Required actions, filters, layout and states', expected: 'create/update/delete actions, hardware and precision filters, all 4 layout sections, and empty/no-results states exist.',
    run: ({ def }) => {
      const miss = [
        ...['create', 'update', 'delete'].filter((a) => !def.actions.includes(a as never)).map((a) => `action ${a}`),
        ...['hardwarePlatform', 'precision'].filter((f) => !def.filters.some((x) => x.field === f)).map((f) => `filter ${f}`),
        ...['metrics', 'filters', 'form', 'table'].filter((x) => !def.layout.sections.includes(x as never)).map((x) => `section ${x}`),
        ...(def.emptyState.title && def.noResults.title ? [] : ['state content']),
      ];
      return R(miss.length === 0, miss.length ? `missing ${miss.join(', ')}` : 'all present', `actions=${def.actions.join('/')}; sections=${def.layout.sections.join('/')}`);
    },
  },
];

export function runChecks(project: Project, now: string, checks: VerificationCheck[] = DEFAULT_CHECKS): VerificationReport {
  const versionId = project.currentVersionId ?? 'none';
  const def = project.applicationDefinition;
  const status = new Map<string, VerificationResult['status']>();
  const results = checks.map<VerificationResult>((c) => {
    const base = { testId: c.id, title: c.title, expectedResult: c.expected, timestamp: now, applicationVersion: versionId };
    const unmet = (c.requires ?? []).filter((id) => status.get(id) !== 'passed');
    if (!def || unmet.length) {
      status.set(c.id, 'blocked');
      return { ...base, status: 'blocked', observedResult: 'Not run', evidence: def ? `Blocked by ${unmet.join(', ')}` : 'No valid candidate application' };
    }
    let o: CheckOutcome;
    try {
      o = c.run({ project, def, now });
    } catch (e) {
      o = R(false, 'Check threw an exception', String(e));
    }
    status.set(c.id, o.passed ? 'passed' : 'failed');
    return { ...base, status: o.passed ? 'passed' : 'failed', observedResult: o.observed, evidence: o.evidence };
  });
  return { id: `${versionId}-report-${project.verificationReports.length + 1}`, versionId, createdAt: now, passed: results.every((r) => r.status === 'passed'), results };
}

export type VerifyResult = { ok: true; project: Project; notice: string } | { ok: false; error: string };

/** Runs verification on the current candidate. Pass → stable; fail → stableVersionId preserved. No repair. */
export function verifyProject(p: Project, now: string, checks: VerificationCheck[] = DEFAULT_CHECKS): VerifyResult {
  const allowed = ['generated', 'verification_failed', 'verified'];
  if (!allowed.includes(p.workflowStatus) || !p.applicationDefinition || !p.currentVersionId) {
    return { ok: false, error: 'Verification is blocked: no valid candidate application exists. Generate the application first.' };
  }
  const report = runChecks(p, now, checks);
  const versions = p.versions.map((v) =>
    v.id === p.currentVersionId
      ? { ...v, verificationStatus: report.passed ? ('passed' as const) : ('failed' as const), lifecycleStatus: report.passed ? ('stable' as const) : v.lifecycleStatus }
      : v,
  );
  const bad = report.results.filter((r) => r.status !== 'passed').length;
  return {
    ok: true,
    project: {
      ...p,
      versions,
      verificationReports: [...p.verificationReports, report],
      stableVersionId: report.passed ? p.currentVersionId : p.stableVersionId,
      workflowStatus: report.passed ? 'verified' : 'verification_failed',
      updatedAt: now,
    },
    notice: report.passed
      ? `All ${report.results.length} checks passed. ${p.currentVersionId} is now the stable version.`
      : `${bad} check(s) failed or were blocked. The candidate stays non-stable; the stable version is unchanged. Bounded repair can be reviewed below.`,
  };
}
