export const APP_NAME = 'Spec2App Verify';

export const WORKFLOW_STAGES = [
  'Requirement',
  'Structured Analysis',
  'Acceptance Tests',
  'Human Approval',
  'App Definition',
  'Interactive Rendering',
  'Deterministic Verification',
  'Bounded Repair',
  'Stable Version & Report',
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
