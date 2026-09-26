import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AppDefinition, AppRecord, FieldDefinition } from '@/domain/project';
import { ConfirmDialog } from './ConfirmDialog';
import {
  computeMetric, emptyForm, filterRecords, formatMetric, formatValue, recordToForm, validateRecord,
  type FieldErrors, type FormValues,
} from './logic';

interface Props {
  definition: AppDefinition;
  records: AppRecord[];
  onChange: (records: AppRecord[]) => void;
}

const selectCls = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

function FieldInput({ f, value, onChange, error }: { f: FieldDefinition; value: string; onChange: (v: string) => void; error?: string }) {
  const id = `f-${f.key}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{f.label}{f.type === 'number' ? ` (${f.unit})` : ''}</Label>
      {f.type === 'enum' || f.type === 'boolean' ? (
        <select id={id} className={selectCls} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error}>
          <option value="">Select…</option>
          {f.type === 'enum'
            ? f.options.map((o) => <option key={o} value={o}>{o}</option>)
            : [<option key="t" value="true">{f.trueLabel}</option>, <option key="f" value="false">{f.falseLabel}</option>]}
        </select>
      ) : (
        <Input id={id} inputMode={f.type === 'number' ? 'decimal' : undefined} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}

/** Trusted renderer: only interprets validated definitions; never executes generated code. */
export function TrackerRenderer({ definition: def, records, onChange }: Props) {
  const [form, setForm] = useState<FormValues>(() => emptyForm(def));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const visible = useMemo(() => filterRecords(records, filters), [records, filters]);
  const fieldMap = new Map(def.entity.fields.map((f) => [f.key, f]));

  const reset = () => { setForm(emptyForm(def)); setErrors({}); setEditingId(null); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = validateRecord(def, form);
    if ('errors' in r) return setErrors(r.errors);
    if (editingId) onChange(records.map((x) => (x.id === editingId ? { ...r.value, id: editingId } : x)));
    else onChange([...records, { ...r.value, id: crypto.randomUUID() }]);
    reset();
  };

  const sections = {
    metrics: (
      <div key="metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {def.metrics.map((m) => (
          <div key={m.id} className="rounded-lg border bg-card p-4">
            <p className="text-xs text-muted-foreground">{m.label}</p>
            <p className="text-2xl font-semibold" data-testid={`metric-${m.id}`}>{formatMetric(m, computeMetric(m, visible))}</p>
          </div>
        ))}
      </div>
    ),
    filters: (
      <div key="filters" className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {def.filters.map((flt) => {
          const f = fieldMap.get(flt.field)!;
          const opts = f.type === 'enum' ? f.options.map((o) => [o, o]) : f.type === 'boolean' ? [['true', f.trueLabel], ['false', f.falseLabel]] : [];
          return (
            <div key={flt.field} className="flex-1 space-y-1">
              <Label htmlFor={`flt-${flt.field}`}>{flt.label}</Label>
              <select id={`flt-${flt.field}`} className={selectCls} value={filters[flt.field] ?? ''} onChange={(e) => setFilters({ ...filters, [flt.field]: e.target.value })}>
                <option value="">All</option>
                {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          );
        })}
        <Button variant="outline" onClick={() => setFilters({})}>Reset filters</Button>
      </div>
    ),
    form: (
      <form key="form" onSubmit={submit} className="grid grid-cols-1 gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4" noValidate>
        {def.entity.fields.map((f) => (
          <FieldInput key={f.key} f={f} value={form[f.key] ?? ''} error={errors[f.key]} onChange={(v) => setForm({ ...form, [f.key]: v })} />
        ))}
        <div className="flex items-end gap-2">
          <Button type="submit">{editingId ? 'Save changes' : 'Add record'}</Button>
          {editingId && <Button type="button" variant="outline" onClick={reset}>Cancel</Button>}
        </div>
      </form>
    ),
    table: (
      <div key="table" className="space-y-2">
        {records.length === 0 || visible.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="font-medium">{(records.length === 0 ? def.emptyState : def.noResults).title}</p>
            <p className="text-sm text-muted-foreground">{(records.length === 0 ? def.emptyState : def.noResults).description}</p>
          </div>
        ) : (
          visible.map((r) => (
            <div key={r.id} className="flex flex-col gap-2 rounded-lg border p-3 md:flex-row md:items-center">
              <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-7">
                {def.entity.fields.map((f) => (
                  <div key={f.key} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="truncate">{formatValue(f, r[f.key])}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { setEditingId(r.id); setErrors({}); setForm(recordToForm(def, r)); }}>Edit</Button>
                <Button size="sm" variant="destructive" onClick={() => setPendingDelete(r.id)}>Delete</Button>
              </div>
            </div>
          ))
        )}
      </div>
    ),
  };

  return (
    <section className="space-y-4" aria-label={def.metadata.name}>
      <header>
        <h3 className="text-lg font-semibold">{def.metadata.name}</h3>
        <p className="text-sm text-muted-foreground">{def.metadata.description}</p>
      </header>
      {def.layout.sections.map((s) => sections[s])}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this record?"
        description="This benchmark record will be permanently removed."
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { onChange(records.filter((r) => r.id !== pendingDelete)); if (editingId === pendingDelete) reset(); setPendingDelete(null); }}
      />
    </section>
  );
}
