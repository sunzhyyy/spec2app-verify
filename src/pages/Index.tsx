import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AcceptanceTest, Project } from '@/domain/project';
import { APP_NAME, STATUS_LABELS, TESTS_LOCKED_STATES } from '@/domain/workflow';
import { DEMO_MODE_LABEL } from '@/engine/demo';
import * as A from '@/engine/actions';
import { ConfirmDialog } from '@/renderer/ConfirmDialog';
import { TrackerRenderer } from '@/renderer/TrackerRenderer';
import { loadStore, saveStore } from '@/store/projects';

const now = () => new Date().toISOString();
const TEXT_KEYS: (keyof AcceptanceTest)[] = ['title', 'requirementReference', 'precondition', 'action', 'expectedResult'];

export default function Index() {
  const initial = useMemo(() => loadStore(localStorage), []);
  const [projects, setProjects] = useState<Project[]>(initial.projects);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(
    initial.dropped ? { kind: 'error', text: `${initial.dropped} invalid stored project(s) were ignored.` } : null,
  );
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  useEffect(() => saveStore(localStorage, projects, selectedId), [projects, selectedId]);

  const project = projects.find((p) => p.id === selectedId) ?? null;
  const apply = (r: A.ActionResult) => {
    if ('error' in r) return setMessage({ kind: 'error', text: r.error });
    setProjects((ps) => ps.map((p) => (p.id === r.project.id ? r.project : p)));
    setMessage(r.notice ? { kind: 'info', text: r.notice } : null);
  };
  const create = () => {
    const p = A.createProject({ id: crypto.randomUUID(), name: `Project ${projects.length + 1}`, now: now() });
    setProjects([...projects, p]);
    setSelectedId(p.id);
    setMessage(null);
  };

  const locked = project ? TESTS_LOCKED_STATES.includes(project.workflowStatus) : true;
  const testIssues = project ? A.validateTests(project.acceptanceTests) : {};
  const editTest = (i: number, patch: Partial<AcceptanceTest>) =>
    project && apply(A.updateTests(project, project.acceptanceTests.map((t, j) => (j === i ? { ...t, ...patch } : t)), now()));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h1 className="text-xl font-bold">{APP_NAME}</h1>
        <Badge variant="secondary">{DEMO_MODE_LABEL}</Badge>
      </header>
      <div className="flex flex-col md:flex-row">
        <aside className="space-y-2 border-b p-4 md:w-60 md:border-b-0 md:border-r">
          <Button className="w-full" onClick={create}>New project</Button>
          <nav aria-label="Projects" className="flex gap-2 overflow-x-auto md:flex-col">
            {projects.map((p) => (
              <button key={p.id} onClick={() => setSelectedId(p.id)} className={`shrink-0 rounded-md px-3 py-2 text-left text-sm ${p.id === selectedId ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
                {p.name}
                <span className="block text-xs opacity-80">{STATUS_LABELS[p.workflowStatus]}</span>
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 space-y-6 p-4">
          {message && (
            <p role={message.kind === 'error' ? 'alert' : 'status'} className={`rounded-md border p-3 text-sm ${message.kind === 'error' ? 'border-destructive text-destructive' : 'border-primary/40'}`}>
              {message.text}
            </p>
          )}
          {!project ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="font-medium">No project selected</p>
              <p className="text-sm text-muted-foreground">Create a project to turn a requirement into a verified application.</p>
            </div>
          ) : (
            <>
              <section className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Project name" className="max-w-xs" value={project.name} onChange={(e) => apply({ ok: true, project: { ...project, name: e.target.value || 'Untitled', updatedAt: now() } })} />
                  <Badge>{STATUS_LABELS[project.workflowStatus]}</Badge>
                  {project.currentVersionId && <Badge variant="outline">v{project.versions.length} candidate</Badge>}
                </div>
                <Label htmlFor="req">1. Requirement</Label>
                <Textarea id="req" rows={4} value={project.originalRequirement} disabled={project.workflowStatus !== 'draft'} onChange={(e) => apply(A.setRequirement(project, e.target.value, now()))} />
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => apply(A.analyze(project, now()))} disabled={project.workflowStatus !== 'draft'}>Analyze requirement</Button>
                  {(project.workflowStatus === 'analyzed' || project.workflowStatus === 'awaiting_test_approval') && (
                    <Button variant="outline" onClick={() => apply(A.editRequirement(project, now()))}>Edit requirement</Button>
                  )}
                </div>
              </section>

              {project.structuredAnalysis && (
                <section className="space-y-2 rounded-lg border p-4">
                  <h2 className="font-semibold">2. Structured analysis</h2>
                  <p className="text-sm"><b>Purpose:</b> {project.structuredAnalysis.purpose}</p>
                  <p className="text-sm"><b>User:</b> {project.structuredAnalysis.primaryUser}</p>
                  <ul className="grid gap-1 text-sm sm:grid-cols-2">
                    {project.structuredAnalysis.dataFields.map((f) => <li key={f.key}>• <b>{f.label}</b> ({f.type}{f.unit ? `, ${f.unit}` : ''}) – {f.rule}</li>)}
                  </ul>
                  <p className="text-sm"><b>Filters:</b> {project.structuredAnalysis.filters.join(', ')} · <b>Metrics:</b> {project.structuredAnalysis.calculatedMetrics.join(', ')}</p>
                  {project.workflowStatus === 'analyzed' && <Button onClick={() => apply(A.proposeAcceptanceTests(project, now()))}>Propose acceptance tests</Button>}
                </section>
              )}

              {project.acceptanceTests.length > 0 && (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="font-semibold">3. Acceptance tests ({project.acceptanceTests.length}) {locked && <Badge variant="outline">Locked</Badge>}</h2>
                    <div className="flex flex-wrap gap-2">
                      {!locked && <Button variant="outline" onClick={() => apply(A.updateTests(project, [...project.acceptanceTests, A.blankTest(project.acceptanceTests)], now()))}>Add test</Button>}
                      {!locked && <Button onClick={() => apply(A.approveTests(project, now()))}>Approve test set</Button>}
                      {locked && <Button variant="outline" onClick={() => setConfirmUnlock(true)}>Return to test editing</Button>}
                    </div>
                  </div>
                  {project.acceptanceTests.map((t, i) => (
                    <div key={t.id} className="space-y-2 rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">{t.id}</Badge>
                        {t.approved && <Badge>Approved</Badge>}
                        <select aria-label={`${t.id} verification type`} disabled={locked} className="h-8 rounded border bg-background px-2 text-sm" value={t.verificationType} onChange={(e) => editTest(i, { verificationType: e.target.value as AcceptanceTest['verificationType'] })}>
                          <option value="automated">automated</option><option value="manual">manual</option>
                        </select>
                        <select aria-label={`${t.id} priority`} disabled={locked} className="h-8 rounded border bg-background px-2 text-sm" value={t.priority} onChange={(e) => editTest(i, { priority: e.target.value as AcceptanceTest['priority'] })}>
                          <option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
                        </select>
                        {!locked && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => apply(A.updateTests(project, project.acceptanceTests.filter((_, j) => j !== i), now()))}>Remove</Button>}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {TEXT_KEYS.map((k) => (
                          <Input key={k} aria-label={`${t.id} ${k}`} placeholder={k} disabled={locked} value={String(t[k])} onChange={(e) => editTest(i, { [k]: e.target.value })} />
                        ))}
                      </div>
                      {testIssues[t.id] && <p className="text-xs text-destructive">{testIssues[t.id].join('; ')}</p>}
                    </div>
                  ))}
                  {project.workflowStatus === 'approved' && <Button onClick={() => apply(A.generate(project, now()))}>Generate application</Button>}
                </section>
              )}

              {project.applicationDefinition && (
                <section className="space-y-2 rounded-lg border p-4">
                  <h2 className="font-semibold">4. Generated application preview</h2>
                  <TrackerRenderer key={project.currentVersionId ?? ''} definition={project.applicationDefinition} records={project.applicationRecords} onChange={(r) => apply(A.updateRecords(project, r, now()))} />
                </section>
              )}
              <ConfirmDialog
                open={confirmUnlock}
                title="Return to test editing?"
                description="Tests will be unlocked, and any generated candidate application will be invalidated until tests are approved again."
                confirmLabel="Unlock tests"
                onCancel={() => setConfirmUnlock(false)}
                onConfirm={() => { setConfirmUnlock(false); apply(A.returnToTestEditing(project, now())); }}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
