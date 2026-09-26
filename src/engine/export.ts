import { z } from 'zod';
import {
  AcceptanceTestSchema, AnalysisSchema, REPAIR_LIMITS, RepairAttemptSchema, RepairProposalSchema, RepairRejectionSchema, AppDefinitionSchema, AppRecordSchema, VerificationReportSchema, VersionSchema,
  WorkflowStatusSchema, type Project,
} from '../domain/project';
import { APP_NAME } from '../domain/workflow';
import { repairEligibility } from './repair';

export const EXPORT_SCHEMA_VERSION = 2;

export const ExportSchema = z
  .object({
    exportSchemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
    exportedAt: z.string().min(1),
    product: z.object({ name: z.literal(APP_NAME), stage: z.literal(4) }).strict(),
    project: z.object({ id: z.string(), name: z.string(), createdAt: z.string(), updatedAt: z.string() }).strict(),
    originalRequirement: z.string(),
    structuredAnalysis: AnalysisSchema.nullable(),
    approvedAcceptanceTests: z.array(AcceptanceTestSchema.refine((t) => t.approved, 'Only approved tests are exported')),
    testsApprovedAt: z.string().nullable(),
    applicationDefinition: AppDefinitionSchema.nullable(),
    benchmarkRecords: z.array(AppRecordSchema),
    verificationReport: VerificationReportSchema.nullable(),
    versions: z.object({
      currentVersionId: z.string().nullable(),
      stableVersionId: z.string().nullable(),
      history: z.array(VersionSchema),
    }).strict(),
    workflowStatus: WorkflowStatusSchema,
    counters: z.object({
      aiMode: z.enum(['demo', 'http']),
      aiAssistedCallCount: z.number().int().min(0),
      repairAttemptCount: z.number().int().min(0).max(REPAIR_LIMITS.maxRepairAttempts),
    }).strict(),
    repair: z.object({
      configuration: z.object({ maxRepairAttempts: z.literal(2), maxAiAssistedCalls: z.literal(5), defaultMode: z.literal('deterministic') }).strict(),
      eligibility: z.object({ eligible: z.boolean(), reason: z.string() }).strict(),
      attempts: z.array(RepairAttemptSchema),
      rejections: z.array(RepairRejectionSchema),
      pendingProposal: RepairProposalSchema.nullable(),
      stopReason: z.string().nullable(),
      finalCandidateVersionId: z.string().nullable(),
      lastStableVersionId: z.string().nullable(),
    }).strict(),
    verificationReports: z.array(VerificationReportSchema),
  })
  .strict();
export type ProjectExport = z.infer<typeof ExportSchema>;

const SECRET_PATTERN = /(api[_-]?key|secret|password|token|bearer|authorization|VITE_AI_ENDPOINT|https?:\/\/)/i;

/** Builds an export from an explicit allow-list of fields so nothing hidden leaks in. */
export function buildExport(p: Project, now: string): { ok: true; data: ProjectExport; json: string } | { ok: false; error: string } {
  const candidate = {
    exportSchemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now,
    product: { name: APP_NAME, stage: 4 },
    project: { id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt },
    originalRequirement: p.originalRequirement,
    structuredAnalysis: p.structuredAnalysis,
    approvedAcceptanceTests: p.testsApprovedAt ? p.acceptanceTests.filter((t) => t.approved) : [],
    testsApprovedAt: p.testsApprovedAt,
    applicationDefinition: p.applicationDefinition,
    benchmarkRecords: p.applicationRecords,
    verificationReport: p.verificationReports.at(-1) ?? null,
    versions: { currentVersionId: p.currentVersionId, stableVersionId: p.stableVersionId, history: p.versions },
    workflowStatus: p.workflowStatus,
    counters: { aiMode: p.aiMode, aiAssistedCallCount: p.aiAssistedCallCount, repairAttemptCount: p.repairAttemptCount },
    repair: {
      configuration: { maxRepairAttempts: REPAIR_LIMITS.maxRepairAttempts, maxAiAssistedCalls: REPAIR_LIMITS.maxAiAssistedCalls, defaultMode: 'deterministic' },
      eligibility: repairEligibility(p),
      attempts: p.repairAttempts,
      rejections: p.repairRejections,
      pendingProposal: p.pendingRepair,
      stopReason: p.repairStopReason,
      finalCandidateVersionId: p.currentVersionId,
      lastStableVersionId: p.stableVersionId,
    },
    verificationReports: p.verificationReports,
  };
  const parsed = ExportSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: `Export failed validation: ${parsed.error.issues[0]?.message}` };
  const json = JSON.stringify(parsed.data, null, 2);
  const leak = SECRET_PATTERN.exec(json);
  if (leak) return { ok: false, error: `Export blocked: it appears to contain sensitive content ("${leak[0]}").` };
  return { ok: true, data: parsed.data, json };
}

export function exportFilename(p: Project): string {
  const name = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `spec2app-${name}-${p.currentVersionId ?? p.stableVersionId ?? 'no-version'}.json`;
}
