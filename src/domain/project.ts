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

export const VersionSchema = z.object({
  id: z.string().min(1),
  parentVersionId: z.string().nullable(),
  createdAt: z.string(),
  reason: z.string().min(1),
  applicationDefinition: AppDefinitionSchema,
  acceptanceTestIds: z.array(z.string()),
  verificationStatus: z.enum(['pending', 'passed', 'failed', 'invalidated']),
  lifecycleStatus: z.enum(['candidate', 'stable']),
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
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

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
  aiAssistedCallCount: z.number().int().min(0),
  /** Automatic repair is excluded from Stage 3, so this is always 0. */
  repairAttemptCount: z.literal(0),
});
export type Project = z.infer<typeof ProjectSchema>;
