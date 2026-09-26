import { z } from 'zod';

export const WORKFLOW_STATES = [
  'draft',
  'analyzed',
  'awaiting_test_approval',
  'approved',
  'generating',
  'generated',
  'verifying',
  'verification_failed',
  'verified',
  'stopped',
  'error',
] as const;
export const WorkflowStatusSchema = z.enum(WORKFLOW_STATES);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

const nonEmpty = (message: string) => z.string().trim().min(1, message);

export const AnalysisSchema = z.object({
  source: z.literal('deterministic-demo'),
  purpose: z.string().min(1),
  primaryUser: z.string().min(1),
  dataFields: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(['text', 'number', 'enum', 'boolean']),
        unit: z.string().optional(),
        rule: z.string(),
      }),
    )
    .min(1),
  actions: z.array(z.string()).min(1),
  filters: z.array(z.string()),
  calculatedMetrics: z.array(z.string()),
  validationRules: z.array(z.string()),
  responsiveLayout: z.string(),
  persistence: z.string(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const AcceptanceTestSchema = z.object({
  id: nonEmpty('Test id is required'),
  title: nonEmpty('Title is required'),
  requirementReference: nonEmpty('Requirement reference is required'),
  precondition: z.string(),
  action: nonEmpty('Action is required'),
  expectedResult: z
    .string()
    .trim()
    .min(8, 'Expected result must describe an observable outcome (at least 8 characters)'),
  verificationType: z.enum(['automated', 'manual']),
  priority: z.enum(['high', 'medium', 'low']),
  approved: z.boolean(),
});
export type AcceptanceTest = z.infer<typeof AcceptanceTestSchema>;

const fieldKey = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'Field keys must be camelCase identifiers');
const fieldBase = { key: fieldKey, label: z.string().min(1), required: z.boolean() };

export const FieldSchema = z.discriminatedUnion('type', [
  z.object({ ...fieldBase, type: z.literal('text'), maxLength: z.number().int().positive() }),
  z.object({
    ...fieldBase,
    type: z.literal('number'),
    unit: z.string().min(1),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ ...fieldBase, type: z.literal('enum'), options: z.array(z.string().min(1)).min(1) }),
  z.object({
    ...fieldBase,
    type: z.literal('boolean'),
    trueLabel: z.string().min(1),
    falseLabel: z.string().min(1),
  }),
]);
export type FieldDefinition = z.infer<typeof FieldSchema>;

const metricBase = { id: z.string().min(1), label: z.string().min(1) };
export const MetricSchema = z.discriminatedUnion('kind', [
  z.object({ ...metricBase, kind: z.literal('count') }),
  z.object({
    ...metricBase,
    kind: z.literal('average'),
    field: fieldKey,
    unit: z.string().min(1),
    decimals: z.number().int().min(0).max(4),
  }),
  z.object({ ...metricBase, kind: z.literal('ratio'), field: fieldKey }),
]);
export type MetricDefinition = z.infer<typeof MetricSchema>;

const stateContent = z.object({ title: z.string().min(1), description: z.string().min(1) });

export const AppDefinitionSchema = z
  .object({
    metadata: z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      schemaVersion: z.literal(1),
    }),
    entity: z.object({
      name: z.string().min(1),
      pluralName: z.string().min(1),
      fields: z.array(FieldSchema).min(1),
    }),
    actions: z.array(z.enum(['create', 'update', 'delete'])).min(1),
    filters: z.array(z.object({ field: fieldKey, label: z.string().min(1) })),
    metrics: z.array(MetricSchema),
    layout: z.object({ sections: z.array(z.enum(['metrics', 'filters', 'form', 'table'])).min(1) }),
    emptyState: stateContent,
    noResults: stateContent,
    acceptanceTestRefs: z.array(z.string().min(1)).min(1),
    version: z.object({
      number: z.number().int().positive(),
      generatedAt: z.string().min(1),
      testsApprovedAt: z.string().min(1),
    }),
  })
  .superRefine((def, ctx) => {
    const fields = new Map(def.entity.fields.map((f) => [f.key, f]));
    if (fields.size !== def.entity.fields.length) {
      ctx.addIssue({ code: 'custom', path: ['entity', 'fields'], message: 'Field keys must be unique' });
    }
    def.entity.fields.forEach((f, i) => {
      if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) {
        ctx.addIssue({ code: 'custom', path: ['entity', 'fields', i], message: `${f.label}: min exceeds max` });
      }
    });
    def.filters.forEach((flt, i) => {
      const f = fields.get(flt.field);
      if (!f || (f.type !== 'enum' && f.type !== 'boolean')) {
        ctx.addIssue({ code: 'custom', path: ['filters', i], message: `Filter "${flt.field}" must reference an enum or boolean field` });
      }
    });
    def.metrics.forEach((m, i) => {
      if (m.kind === 'count') return;
      const f = fields.get(m.field);
      const expected = m.kind === 'average' ? 'number' : 'boolean';
      if (!f || f.type !== expected) {
        ctx.addIssue({ code: 'custom', path: ['metrics', i], message: `Metric "${m.id}" must reference a ${expected} field` });
      }
    });
    if (new Set(def.acceptanceTestRefs).size !== def.acceptanceTestRefs.length) {
      ctx.addIssue({ code: 'custom', path: ['acceptanceTestRefs'], message: 'Acceptance test references must be unique' });
    }
  });
export type AppDefinition = z.infer<typeof AppDefinitionSchema>;

export const AppRecordSchema = z
  .object({ id: z.string().min(1) })
  .catchall(z.union([z.string(), z.number(), z.boolean()]));
export type AppRecord = z.infer<typeof AppRecordSchema>;

/** Hard limits for bounded repair. Enforced by the engine and by the schemas below. */
export const REPAIR_LIMITS = { maxRepairAttempts: 2, maxAiAssistedCalls: 5 } as const;

export const VersionSchema = z.object({
  id: z.string().min(1),
  parentVersionId: z.string().nullable(),
  createdAt: z.string(),
  reason: z.string().min(1),
  applicationDefinition: AppDefinitionSchema,
  acceptanceTestIds: z.array(z.string()),
  verificationStatus: z.enum(['pending', 'passed', 'failed', 'invalidated']),
  lifecycleStatus: z.enum(['candidate', 'stable']),
  /** Defaults keep Stage 3 stored data loadable. */
  kind: z.enum(['baseline', 'repair']).default('baseline'),
  repairId: z.string().nullable().default(null),
  repairAttemptNumber: z.number().int().min(0).max(REPAIR_LIMITS.maxRepairAttempts).default(0),
  changedDefinitionPaths: z.array(z.string()).default([]),
  acceptanceTestsDigest: z.string().default(''),
});
export type Version = z.infer<typeof VersionSchema>;

export const VerificationResultSchema = z.object({
  testId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked']),
  expectedResult: z.string(),
  observedResult: z.string(),
  evidence: z.string(),
  timestamp: z.string(),
  applicationVersion: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationReportSchema = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
  createdAt: z.string(),
  passed: z.boolean(),
  results: z.array(VerificationResultSchema),
  /** "targeted" reports ran only the selected checks; the rest are listed in carriedForward, not re-run. */
  scope: z.enum(['full', 'targeted']).default('full'),
  selection: z.array(z.object({ testId: z.string(), reason: z.string() })).default([]),
  carriedForward: z.array(z.string()).default([]),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const RepairChangeSchema = z.object({ path: z.string().min(1), value: z.unknown() }).strict();

export const RepairProposalSchema = z
  .object({
    repairId: z.string().min(1),
    sourceVersionId: z.string().min(1),
    failedTestIds: z.array(z.string()),
    blockedTestIds: z.array(z.string()),
    diagnosedCause: z.string().min(1),
    affectedDefinitionPaths: z.array(z.string().min(1)).min(1),
    proposedChanges: z.array(RepairChangeSchema).min(1),
    preservedRequirements: z.array(z.string()),
    expectedImprovement: z.string().min(1),
    regressionRisk: z.enum(['low', 'medium', 'high']),
    repairMode: z.enum(['deterministic', 'http']),
    createdAt: z.string().min(1),
  })
  .strict();
export type RepairProposal = z.infer<typeof RepairProposalSchema>;

export const REPAIR_OUTCOMES = [
  'pending_reverification', 'repaired', 'improved', 'no_improvement', 'repeated_failure', 'regression', 'limit_reached',
] as const;

export const RepairAttemptSchema = z.object({
  attemptNumber: z.number().int().min(1).max(REPAIR_LIMITS.maxRepairAttempts),
  repairId: z.string().min(1),
  repairMode: z.enum(['deterministic', 'http']),
  sourceVersionId: z.string().min(1),
  candidateVersionId: z.string().min(1),
  sourceReportId: z.string().min(1),
  reverificationReportId: z.string().nullable(),
  failureSignatureBefore: z.string(),
  failureSignatureAfter: z.string().nullable(),
  failedCountBefore: z.number().int().min(0),
  failedCountAfter: z.number().int().min(0).nullable(),
  blockedCountBefore: z.number().int().min(0),
  blockedCountAfter: z.number().int().min(0).nullable(),
  changedDefinitionPaths: z.array(z.string()),
  affectedTestIds: z.array(z.string()),
  regressionTestIds: z.array(z.string()),
  regressedTestIds: z.array(z.string()),
  outcome: z.enum(REPAIR_OUTCOMES),
  stopReason: z.string().nullable(),
  createdAt: z.string(),
});
export type RepairAttempt = z.infer<typeof RepairAttemptSchema>;

export const RepairRejectionSchema = z.object({
  repairId: z.string().nullable(),
  repairMode: z.enum(['deterministic', 'http']),
  sourceVersionId: z.string().nullable(),
  reason: z.string().min(1),
  createdAt: z.string(),
});
export type RepairRejection = z.infer<typeof RepairRejectionSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  originalRequirement: z.string(),
  structuredAnalysis: AnalysisSchema.nullable(),
  acceptanceTests: z.array(AcceptanceTestSchema.extend({
    title: z.string(),
    requirementReference: z.string(),
    action: z.string(),
    expectedResult: z.string(),
  })),
  testsApprovedAt: z.string().nullable(),
  applicationDefinition: AppDefinitionSchema.nullable(),
  applicationRecords: z.array(AppRecordSchema),
  verificationReports: z.array(VerificationReportSchema),
  versions: z.array(VersionSchema),
  currentVersionId: z.string().nullable(),
  stableVersionId: z.string().nullable(),
  workflowStatus: WorkflowStatusSchema,
  aiMode: z.enum(['demo', 'http']),
  aiAssistedCallCount: z.number().int().min(0).max(REPAIR_LIMITS.maxAiAssistedCalls),
  /** Applied repairs for the current baseline generation; reset only by a new approved generation. */
  repairAttemptCount: z.number().int().min(0).max(REPAIR_LIMITS.maxRepairAttempts),
  repairAttempts: z.array(RepairAttemptSchema).default([]),
  repairRejections: z.array(RepairRejectionSchema).default([]),
  pendingRepair: RepairProposalSchema.nullable().default(null),
  repairStopReason: z.string().nullable().default(null),
});
export type Project = z.infer<typeof ProjectSchema>;
