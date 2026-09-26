import type { ZodError } from 'zod';
import {
  AcceptanceTestSchema,
  AppDefinitionSchema,
  AppRecordSchema,
  type AcceptanceTest,
  type AppRecord,
  type Project,
  type WorkflowStatus,
} from '../domain/project';
import { canTransition, STATUS_LABELS } from '../domain/workflow';
import { testsDigest } from './digest';
import { DEFAULT_REQUIREMENT, DemoAnalysisError, analyzeRequirement, generateDefinition, proposeTests } from './demo';

export type ActionResult = { ok: true; project: Project; notice?: string } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });

function move(p: Project, to: WorkflowStatus, now: string, patch: Partial<Project> = {}): Project {
  if (!canTransition(p.workflowStatus, to)) {
    throw new Error(`Invalid transition: ${p.workflowStatus} → ${to}`);
  }
  return { ...p, ...patch, workflowStatus: to, updatedAt: now };
}

function blocked(p: Project, to: WorkflowStatus): ActionResult | null {
  return canTransition(p.workflowStatus, to)
    ? null
    : fail(`Not allowed while the project is "${STATUS_LABELS[p.workflowStatus]}".`);
}

export function formatZodError(error: ZodError, limit = 5): string {
  return error.issues
    .slice(0, limit)
    .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
    .join('; ');
}

export function createProject(input: { id: string; name: string; now: string; requirement?: string }): Project {
  return {
    id: input.id,
    name: input.name,
    createdAt: input.now,
    updatedAt: input.now,
    originalRequirement: input.requirement ?? DEFAULT_REQUIREMENT,
    structuredAnalysis: null,
    acceptanceTests: [],
    testsApprovedAt: null,
    applicationDefinition: null,
    applicationRecords: [],
    verificationReports: [],
    versions: [],
    currentVersionId: null,
    stableVersionId: null,
    workflowStatus: 'draft',
    aiMode: 'demo',
    aiAssistedCallCount: 0,
    repairAttemptCount: 0,
    repairAttempts: [],
    repairRejections: [],
    pendingRepair: null,
    repairStopReason: null,
  };
}

export function setRequirement(p: Project, text: string, now: string): ActionResult {
  if (p.workflowStatus !== 'draft') return fail('The requirement can only be edited in draft. Use "Edit requirement" first.');
  return { ok: true, project: { ...p, originalRequirement: text, updatedAt: now } };
}

export function analyze(p: Project, now: string): ActionResult {
  if (p.workflowStatus !== 'draft') return fail('Analysis is only available while the project is in draft.');
  if (!p.originalRequirement.trim()) return fail('Enter a requirement first. An empty requirement cannot be analyzed.');
  try {
    const analysis = analyzeRequirement(p.originalRequirement);
    return { ok: true, project: move(p, 'analyzed', now, { structuredAnalysis: analysis }) };
  } catch (e) {
    if (e instanceof DemoAnalysisError) return fail(e.message);
    throw e;
  }
}

export function proposeAcceptanceTests(p: Project, now: string): ActionResult {
  if (p.workflowStatus !== 'analyzed' || !p.structuredAnalysis) return fail('Analyze the requirement before proposing tests.');
  return {
    ok: true,
    project: move(p, 'awaiting_test_approval', now, { acceptanceTests: proposeTests(p.structuredAnalysis) }),
  };
}

/** Returns to draft, discarding analysis and tests, so the requirement can be changed. */
export function editRequirement(p: Project, now: string): ActionResult {
  if (p.workflowStatus !== 'analyzed' && p.workflowStatus !== 'awaiting_test_approval') {
    return fail('Return to test editing before changing the requirement.');
  }
  return {
    ok: true,
    project: move(p, 'draft', now, { structuredAnalysis: null, acceptanceTests: [], testsApprovedAt: null }),
  };
}

export function validateTests(tests: AcceptanceTest[]): Record<string, string[]> {
  const issues: Record<string, string[]> = {};
  const seen = new Set<string>();
  tests.forEach((t, i) => {
    const key = t.id || `#${i + 1}`;
    const r = AcceptanceTestSchema.safeParse(t);
    const list = r.success ? [] : r.error.issues.map((x) => x.message);
    if (seen.has(t.id)) list.push(`Duplicate test id ${t.id}`);
    seen.add(t.id);
    if (list.length) issues[key] = list;
  });
  return issues;
}

export function updateTests(p: Project, tests: AcceptanceTest[], now: string): ActionResult {
  if (p.workflowStatus !== 'awaiting_test_approval') {
    return fail('Approved tests are locked. Use "Return to test editing" to change them.');
  }
  return {
    ok: true,
    project: { ...p, acceptanceTests: tests.map((t) => ({ ...t, approved: false })), updatedAt: now },
  };
}

export function nextTestId(tests: AcceptanceTest[]): string {
  const max = tests.reduce((m, t) => Math.max(m, Number(/^AT-(\d+)$/.exec(t.id)?.[1] ?? 0)), 0);
  return `AT-${String(max + 1).padStart(2, '0')}`;
}

export function blankTest(tests: AcceptanceTest[]): AcceptanceTest {
  return {
    id: nextTestId(tests),
    title: '',
    requirementReference: '',
    precondition: '',
    action: '',
    expectedResult: '',
    verificationType: 'automated',
    priority: 'medium',
    approved: false,
  };
}

export function approveTests(p: Project, now: string): ActionResult {
  const guard = blocked(p, 'approved');
  if (guard) return guard;
  if (p.acceptanceTests.length === 0) return fail('Add at least one acceptance test before approving.');
  const issues = Object.entries(validateTests(p.acceptanceTests));
  if (issues.length) {
    return fail(`Fix ${issues.length} test(s) before approval: ${issues.map(([id, m]) => `${id} – ${m.join(', ')}`).join('; ')}`);
  }
  return {
    ok: true,
    project: move(p, 'approved', now, {
      acceptanceTests: p.acceptanceTests.map((t) => ({ ...t, approved: true })),
      testsApprovedAt: now,
    }),
    notice: `${p.acceptanceTests.length} tests approved. They are now locked.`,
  };
}

/** Unlocks tests, invalidates the generated application and requires re-approval. The stable version is kept. */
export function returnToTestEditing(p: Project, now: string): ActionResult {
  const guard = blocked(p, 'awaiting_test_approval');
  if (guard) return guard;
  return {
    ok: true,
    project: move(p, 'awaiting_test_approval', now, {
      acceptanceTests: p.acceptanceTests.map((t) => ({ ...t, approved: false })),
      testsApprovedAt: null,
      applicationDefinition: null,
      currentVersionId: null,
      pendingRepair: null,
      versions: p.versions.map((v) =>
        v.id === p.currentVersionId && v.lifecycleStatus === 'candidate' ? { ...v, verificationStatus: 'invalidated' as const } : v,
      ),
    }),
    notice: 'Tests unlocked. The generated application was invalidated; approve the tests again to regenerate.',
  };
}

export type DefinitionProducer = typeof generateDefinition;

export function generate(p: Project, now: string, produce: DefinitionProducer = generateDefinition): ActionResult {
  if (p.workflowStatus !== 'approved') return fail('Approve the acceptance test set before generating the application.');
  if (!p.testsApprovedAt || p.acceptanceTests.length === 0 || p.acceptanceTests.some((t) => !t.approved)) {
    return fail('The current test set is not approved.');
  }
  if (!p.structuredAnalysis) return fail('Structured analysis is missing.');
  const generating = move(p, 'generating', now);
  const versionNumber = p.versions.length + 1;
  const raw = produce(p.structuredAnalysis, p.acceptanceTests, {
    versionNumber,
    now,
    testsApprovedAt: p.testsApprovedAt,
  });
  const parsed = AppDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      `The generated definition failed validation, so it was not rendered and no version was created. ${formatZodError(parsed.error)}`,
    );
  }
  const approvedIds = p.acceptanceTests.map((t) => t.id);
  const refs = parsed.data.acceptanceTestRefs;
  if (refs.length !== approvedIds.length || refs.some((id, i) => id !== approvedIds[i])) {
    return fail('The generated definition does not reference exactly the approved tests. No version was created.');
  }
  const versionId = `${p.id}-v${versionNumber}`;
  return {
    ok: true,
    project: move(generating, 'generated', now, {
      applicationDefinition: parsed.data,
      currentVersionId: versionId,
      repairAttemptCount: 0,
      pendingRepair: null,
      repairStopReason: null,
      versions: [
        ...p.versions,
        {
          id: versionId,
          parentVersionId: p.stableVersionId,
          createdAt: now,
          reason: `Generated from ${approvedIds.length} tests approved at ${p.testsApprovedAt}`,
          applicationDefinition: parsed.data,
          acceptanceTestIds: approvedIds,
          verificationStatus: 'pending',
          lifecycleStatus: 'candidate',
          kind: 'baseline',
          repairId: null,
          repairAttemptNumber: 0,
          changedDefinitionPaths: [],
          acceptanceTestsDigest: testsDigest(p.acceptanceTests),
        },
      ],
    }),
    notice: `Version ${versionNumber} generated as a candidate. It can only become stable after verification passes.`,
  };
}

export function updateRecords(p: Project, records: AppRecord[], now: string): ActionResult {
  if (!p.applicationDefinition) return fail('No valid application definition exists.');
  const bad = records.find((r) => !AppRecordSchema.safeParse(r).success);
  if (bad) return fail('A record has an invalid shape and was not saved.');
  return { ok: true, project: { ...p, applicationRecords: records, updatedAt: now } };
}
