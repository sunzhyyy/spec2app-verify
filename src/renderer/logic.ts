import type { AppDefinition, AppRecord, FieldDefinition, MetricDefinition } from '../domain/project';

export type FormValues = Record<string, string>;
export type FieldErrors = Record<string, string>;

export function emptyForm(def: AppDefinition): FormValues {
  return Object.fromEntries(def.entity.fields.map((f) => [f.key, '']));
}

export function recordToForm(def: AppDefinition, record: AppRecord): FormValues {
  return Object.fromEntries(def.entity.fields.map((f) => [f.key, record[f.key] === undefined ? '' : String(record[f.key])]));
}

function validateField(f: FieldDefinition, raw: string): { value?: string | number | boolean; error?: string } {
  const v = raw.trim();
  if (v === '') return f.required ? { error: `${f.label} is required` } : {};
  switch (f.type) {
    case 'text':
      return v.length > f.maxLength ? { error: `${f.label} must be at most ${f.maxLength} characters` } : { value: v };
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `${f.label} must be a number` };
      if (f.min !== undefined && f.max !== undefined && (n < f.min || n > f.max)) {
        return { error: `${f.label} must be between ${f.min} and ${f.max} ${f.unit}` };
      }
      if (f.min !== undefined && n < f.min) return { error: `${f.label} must be ≥ ${f.min} ${f.unit}` };
      if (f.max !== undefined && n > f.max) return { error: `${f.label} must be ≤ ${f.max} ${f.unit}` };
      return { value: n };
    }
    case 'enum':
      return f.options.includes(v) ? { value: v } : { error: `Select a valid ${f.label.toLowerCase()}` };
    case 'boolean':
      return v === 'true' || v === 'false' ? { value: v === 'true' } : { error: `Select ${f.label.toLowerCase()}` };
  }
}

export function validateRecord(
  def: AppDefinition,
  values: FormValues,
): { ok: true; value: Omit<AppRecord, 'id'> } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const value: Record<string, string | number | boolean> = {};
  for (const f of def.entity.fields) {
    const r = validateField(f, values[f.key] ?? '');
    if (r.error) errors[f.key] = r.error;
    else if (r.value !== undefined) value[f.key] = r.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export function filterRecords(records: AppRecord[], active: Record<string, string>): AppRecord[] {
  const entries = Object.entries(active).filter(([, v]) => v !== '');
  return records.filter((r) => entries.every(([k, v]) => String(r[k]) === v));
}

export function computeMetric(metric: MetricDefinition, records: AppRecord[]): number | null {
  if (metric.kind === 'count') return records.length;
  if (records.length === 0) return null;
  if (metric.kind === 'average') {
    const nums = records.map((r) => r[metric.field]).filter((v): v is number => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  }
  return records.filter((r) => r[metric.field] === true).length / records.length;
}

export function formatMetric(metric: MetricDefinition, value: number | null): string {
  if (value === null) return '—';
  if (metric.kind === 'count') return String(value);
  if (metric.kind === 'average') return `${value.toFixed(metric.decimals)} ${metric.unit}`;
  return `${(value * 100).toFixed(1)}%`;
}

export function formatValue(f: FieldDefinition, v: AppRecord[string] | undefined): string {
  if (v === undefined || v === '') return '—';
  if (f.type === 'boolean') return v === true ? f.trueLabel : f.falseLabel;
  if (f.type === 'number') return `${v} ${f.unit}`;
  return String(v);
}
