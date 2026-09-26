import type { WorkflowStatus } from './project';

export const APP_NAME = 'Spec2App Verify';

const TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  draft: ['analyzed', 'error'],
  analyzed: ['awaiting_test_approval', 'draft', 'error'],
  awaiting_test_approval: ['approved', 'draft', 'error'],
  approved: ['generating', 'awaiting_test_approval', 'error'],
  generating: ['generated', 'approved', 'stopped', 'error'],
  generated: ['verifying', 'awaiting_test_approval', 'error'],
  verifying: ['verified', 'verification_failed', 'stopped', 'error'],
  verification_failed: ['verifying', 'awaiting_test_approval', 'stopped', 'error'],
  verified: ['verifying', 'awaiting_test_approval'],
  stopped: ['awaiting_test_approval', 'draft'],
  error: ['draft', 'awaiting_test_approval'],
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: 'Draft',
  analyzed: 'Analyzed',
  awaiting_test_approval: 'Awaiting test approval',
  approved: 'Tests approved',
  generating: 'Generating',
  generated: 'Generated (candidate)',
  verifying: 'Verifying',
  verification_failed: 'Verification failed',
  verified: 'Verified',
  stopped: 'Stopped',
  error: 'Error',
};

/** States in which the acceptance-test set is locked against edits. */
export const TESTS_LOCKED_STATES: readonly WorkflowStatus[] = [
  'approved',
  'generating',
  'generated',
  'verifying',
  'verification_failed',
  'verified',
  'stopped',
];
