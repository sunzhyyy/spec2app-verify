import type { AcceptanceTest, Analysis, FieldDefinition } from '../domain/project';

export const DEFAULT_REQUIREMENT =
  'Create an embedded AI benchmark tracker. I need to record the model name, hardware platform, precision, accuracy, latency, and memory usage. I want to add, edit, and delete benchmark records, filter results by hardware platform and precision, and see summary statistics including average latency and pass rate.';

export const DEMO_MODE_LABEL = 'Deterministic Demo Mode – no model call';

export class DemoAnalysisError extends Error {}

export const BENCHMARK_FIELDS: FieldDefinition[] = [
  { key: 'modelName', label: 'Model name', type: 'text', required: true, maxLength: 80 },
  {
    key: 'hardwarePlatform',
    label: 'Hardware platform',
    type: 'enum',
    required: true,
    options: ['NVIDIA Jetson Orin', 'Raspberry Pi 5', 'Google Coral Edge TPU', 'Qualcomm RB5', 'STM32 MCU'],
  },
  { key: 'precision', label: 'Precision', type: 'enum', required: true, options: ['FP32', 'FP16', 'INT8', 'INT4'] },
  { key: 'accuracy', label: 'Accuracy', type: 'number', required: true, unit: '%', min: 0, max: 100 },
  { key: 'latency', label: 'Latency', type: 'number', required: true, unit: 'ms', min: 0 },
  { key: 'memoryUsage', label: 'Memory usage', type: 'number', required: true, unit: 'MB', min: 0 },
  { key: 'passed', label: 'Pass status', type: 'boolean', required: true, trueLabel: 'Pass', falseLabel: 'Fail' },
];

/** Deterministic rule-based analysis. No model is called. */
export function analyzeRequirement(requirement: string): Analysis {
  const text = requirement.trim().toLowerCase();
  if (!text) throw new DemoAnalysisError('An empty requirement cannot be analyzed.');
  if (!text.includes('benchmark')) {
    throw new DemoAnalysisError(
      'Deterministic Demo Mode only recognizes the embedded AI benchmark tracker requirement. Use the default requirement or describe a benchmark tracker.',
    );
  }
  return {
    source: 'deterministic-demo',
    purpose: 'Record, compare and summarize benchmark results of AI models running on embedded hardware.',
    primaryUser: 'Embedded AI / ML engineer evaluating models on edge devices.',
    dataFields: [
      { key: 'modelName', label: 'Model name', type: 'text', rule: 'Required, up to 80 characters' },
      { key: 'hardwarePlatform', label: 'Hardware platform', type: 'enum', rule: 'Required, one of the supported platforms' },
      { key: 'precision', label: 'Precision', type: 'enum', rule: 'Required: FP32, FP16, INT8 or INT4' },
      { key: 'accuracy', label: 'Accuracy', type: 'number', unit: '%', rule: 'Required number between 0 and 100' },
      { key: 'latency', label: 'Latency', type: 'number', unit: 'ms', rule: 'Required number ≥ 0' },
      { key: 'memoryUsage', label: 'Memory usage', type: 'number', unit: 'MB', rule: 'Required number ≥ 0' },
      { key: 'passed', label: 'Pass status', type: 'boolean', rule: 'Required Pass/Fail; needed to compute pass rate' },
    ],
    actions: ['Add benchmark record', 'Edit benchmark record', 'Delete benchmark record after confirmation'],
    filters: ['Hardware platform', 'Precision'],
    calculatedMetrics: ['Record count (filtered)', 'Average latency (ms)', 'Pass rate (%)'],
    validationRules: [
      'Model name, hardware platform, precision and pass status are required',
      'Accuracy must be a number between 0 and 100 (%)',
      'Latency must be a number ≥ 0 (ms)',
      'Memory usage must be a number ≥ 0 (MB)',
    ],
    responsiveLayout: 'Usable on desktop and on a 390 px mobile width; records become stacked cards on narrow screens.',
    persistence: 'Records persist in browser localStorage and survive a page refresh.',
  };
}

type TestSeed = Omit<AcceptanceTest, 'id' | 'approved'>;

const TEST_SEEDS: TestSeed[] = [
  {
    title: 'Add a valid benchmark record',
    requirementReference: 'Actions: add record',
    precondition: 'The tracker is rendered.',
    action: 'Fill in MobileNetV3, NVIDIA Jetson Orin, INT8, 74.2, 12.5, 48, Pass and select Add record.',
    expectedResult: 'The record appears in the list and the record count increases by 1.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Model name is required',
    requirementReference: 'Validation: required model name',
    precondition: 'The tracker is rendered.',
    action: 'Leave model name empty, fill other fields validly and submit.',
    expectedResult: 'The message "Model name is required" is shown and no record is added.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Numeric fields are validated',
    requirementReference: 'Validation: numeric ranges',
    precondition: 'The tracker is rendered.',
    action: 'Enter accuracy 120, latency -1 and memory usage "abc", then submit.',
    expectedResult: 'Errors are shown for accuracy (0–100), latency (≥ 0) and memory usage (must be a number); no record is added.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Edit a benchmark record',
    requirementReference: 'Actions: edit record',
    precondition: 'At least one record exists.',
    action: 'Select Edit on a record, change latency to 9.8 and save.',
    expectedResult: 'The record shows 9.8 ms and average latency is recalculated.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Delete a record with confirmation',
    requirementReference: 'Actions: delete record',
    precondition: 'At least one record exists.',
    action: 'Select Delete, then Cancel; select Delete again, then Confirm.',
    expectedResult: 'A confirmation dialog appears; Cancel keeps the record and Confirm removes it.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Filter by hardware platform',
    requirementReference: 'Filters: hardware platform',
    precondition: 'Records exist on at least two platforms.',
    action: 'Select one hardware platform in the filter.',
    expectedResult: 'Only records on that platform are listed.',
    verificationType: 'automated',
    priority: 'medium',
  },
  {
    title: 'Filter by precision',
    requirementReference: 'Filters: precision',
    precondition: 'Records exist with at least two precisions.',
    action: 'Select one precision in the filter.',
    expectedResult: 'Only records with that precision are listed.',
    verificationType: 'automated',
    priority: 'medium',
  },
  {
    title: 'Record count is calculated',
    requirementReference: 'Metrics: record count',
    precondition: 'Several records exist.',
    action: 'Apply and reset filters.',
    expectedResult: 'The record count equals the number of records matching the current filters.',
    verificationType: 'automated',
    priority: 'medium',
  },
  {
    title: 'Average latency is calculated',
    requirementReference: 'Metrics: average latency',
    precondition: 'Records with latencies 10 ms and 20 ms match the filters.',
    action: 'View the metric cards.',
    expectedResult: 'Average latency shows 15.00 ms, the arithmetic mean of matching records.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Pass rate is calculated',
    requirementReference: 'Metrics: pass rate',
    precondition: '3 of 4 matching records have Pass status.',
    action: 'View the metric cards.',
    expectedResult: 'Pass rate shows 75.0%.',
    verificationType: 'automated',
    priority: 'high',
  },
  {
    title: 'Records persist after refresh',
    requirementReference: 'Persistence',
    precondition: 'At least one record was added.',
    action: 'Refresh the browser page and reopen the project.',
    expectedResult: 'The same records and metric values are shown after the refresh.',
    verificationType: 'manual',
    priority: 'medium',
  },
  {
    title: 'Empty state is shown',
    requirementReference: 'Empty state',
    precondition: 'No records exist.',
    action: 'Open the generated tracker.',
    expectedResult: 'An empty-state message is shown and average metrics display "—".',
    verificationType: 'automated',
    priority: 'medium',
  },
  {
    title: 'Mobile layout is usable',
    requirementReference: 'Responsive layout',
    precondition: 'The preview is switched to mobile width (390 px).',
    action: 'Add, edit, filter and delete a record.',
    expectedResult: 'All fields, filters and actions are reachable without horizontal scrolling of the page.',
    verificationType: 'manual',
    priority: 'medium',
  },
];

export function proposeTests(analysis: Analysis): AcceptanceTest[] {
  void analysis;
  return TEST_SEEDS.map((seed, i) => ({ ...seed, id: `AT-${String(i + 1).padStart(2, '0')}`, approved: false }));
}

export interface DefinitionOptions {
  versionNumber: number;
  now: string;
  testsApprovedAt: string;
}

/** Produces an unvalidated candidate; callers must validate it with AppDefinitionSchema. */
export function generateDefinition(analysis: Analysis, tests: AcceptanceTest[], opts: DefinitionOptions): unknown {
  return {
    metadata: { name: 'Embedded AI Benchmark Tracker', description: analysis.purpose, schemaVersion: 1 },
    entity: { name: 'Benchmark record', pluralName: 'Benchmark records', fields: BENCHMARK_FIELDS },
    actions: ['create', 'update', 'delete'],
    filters: [
      { field: 'hardwarePlatform', label: 'Hardware platform' },
      { field: 'precision', label: 'Precision' },
    ],
    metrics: [
      { id: 'recordCount', label: 'Records', kind: 'count' },
      { id: 'avgLatency', label: 'Average latency', kind: 'average', field: 'latency', unit: 'ms', decimals: 2 },
      { id: 'passRate', label: 'Pass rate', kind: 'ratio', field: 'passed' },
    ],
    layout: { sections: ['metrics', 'filters', 'form', 'table'] },
    emptyState: { title: 'No benchmark records yet', description: 'Add your first benchmark result using the form.' },
    noResults: { title: 'No records match these filters', description: 'Change or reset the filters to see more records.' },
    acceptanceTestRefs: tests.map((t) => t.id),
    version: { number: opts.versionNumber, generatedAt: opts.now, testsApprovedAt: opts.testsApprovedAt },
  };
}
