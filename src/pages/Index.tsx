import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FALLBACK_LABEL, IFRAME_SANDBOX, createPageResource, modeLabel, validateBridgeMessage, type GeneratedFiles, type PageResource } from '@/gen/core';
import { requestGeneration } from '@/gen/api';
import { FALLBACK_EXAMPLES } from '@/gen/fallback';
import { GenerationFailure } from '@/gen/provider';
import {
  addVersion,
  createProject,
  getAppState,
  loadWorkspace,
  markRendered,
  recordFailedPrompt,
  saveWorkspace,
  selectVersion,
  setAppState,
  type Workspace,
} from '@/gen/store';

const EXAMPLES = [
  'Create a todo board with priorities and due dates. Users can add, complete and delete tasks.',
  'Create a mortgage calculator with loan amount, annual interest rate, loan term and monthly payment.',
  'Create a personal portfolio with a hero section, projects, skills and a contact form.',
];
const FILE_TABS: { key: keyof GeneratedFiles | 'preview'; label: string }[] = [
  { key: 'preview', label: 'Preview' },
  { key: 'indexHtml', label: 'index.html' },
  { key: 'stylesCss', label: 'styles.css' },
  { key: 'scriptJs', label: 'script.js' },
  { key: 'readme', label: 'README.md' },
];
const fmt = (iso: string) => new Date(iso).toLocaleString();

interface FailedAttempt {
  prompt: string;
  kind: 'initial' | 'followup';
  error: GenerationFailure;
}

export default function Index() {
  const initial = useMemo(() => loadWorkspace(), []);
  const [ws, setWs] = useState<Workspace>(initial.workspace);
  const [notice, setNotice] = useState<string | null>(initial.warning);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failed, setFailed] = useState<FailedAttempt | null>(null);
  const [tab, setTab] = useState<(typeof FILE_TABS)[number]['key']>('preview');
  const [frameKey, setFrameKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const commit = useCallback((fn: (w: Workspace) => Workspace) => {
    setWs((prev) => {
      const next = fn(prev);
      const err = saveWorkspace(next);
      if (err) setNotice(err);
      return next;
    });
  }, []);

  const project = ws.projects.find((p) => p.id === ws.selectedProjectId) ?? null;
  const page: PageResource | null = project?.versions.find((v) => v.id === project.selectedVersionId) ?? null;

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  // Narrow persistence bridge: only LOAD_STATE / SAVE_STATE / PAGE_READY from the current iframe.
  useEffect(() => {
    if (!page) return;
    const expected = { projectId: page.projectId, versionId: page.id };
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const msg = validateBridgeMessage(event.data, expected);
      if (!msg) return;
      if (msg.type === 'LOAD_STATE') {
        frame.postMessage({ type: 'STATE_LOADED', ...expected, requestId: msg.requestId, payload: getAppState(wsRef.current, expected.projectId, expected.versionId) }, '*');
      } else if (msg.type === 'SAVE_STATE') {
        commit((w) => setAppState(w, expected.projectId, expected.versionId, msg.payload));
      } else {
        commit((w) => markRendered(w, expected.projectId, expected.versionId));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [page, commit]);

  const newProject = () => {
    commit((w) => createProject(w).ws);
    setPrompt('');
    setFailed(null);
    setTab('preview');
  };

  const run = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    let target = project;
    let base = ws;
    if (!target) {
      const created = createProject(ws);
      base = created.ws;
      target = created.project;
      commit(() => base);
    }
    const kind: 'initial' | 'followup' = page ? 'followup' : 'initial';
    const current = page;
    const projectId = target.id;
    const history = target.prompts.filter((p) => p.status === 'ok').map((p) => p.text);
    setBusy(true);
    setElapsed(0);
    setFailed(null);
    try {
      const res = await requestGeneration({
        prompt: trimmed,
        history,
        currentFiles: current ? { indexHtml: current.indexHtml, stylesCss: current.stylesCss, scriptJs: current.scriptJs, readme: current.readme } : null,
      });
      commit((w) => {
        const p = w.projects.find((x) => x.id === projectId)!;
        return addVersion(
          w,
          createPageResource({ projectId, version: p.versions.length + 1, prompt: trimmed, kind, parentVersionId: current?.id ?? null, mode: 'live', provider: res.provider, files: res }),
        );
      });
      setPrompt('');
      setTab('preview');
    } catch (e) {
      const err = e instanceof GenerationFailure ? e : new GenerationFailure('network', String(e), false);
      setFailed({ prompt: trimmed, kind, error: err });
      commit((w) => recordFailedPrompt(w, projectId, trimmed, kind, `${err.code}: ${err.message}`));
    } finally {
      setBusy(false);
    }
  };

  const applyFallback = (key: keyof typeof FALLBACK_EXAMPLES) => {
    if (!failed || !project) return;
    const projectId = project.id;
    const f = failed;
    commit((w) => {
      const p = w.projects.find((x) => x.id === projectId)!;
      return addVersion(
        w,
        createPageResource({ projectId, version: p.versions.length + 1, prompt: f.prompt, kind: f.kind, parentVersionId: page?.id ?? null, mode: 'fallback', provider: 'none', files: FALLBACK_EXAMPLES[key] }),
      );
    });
    setFailed(null);
    setTab('preview');
  };

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900 lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white lg:w-64 lg:border-b-0 lg:border-r">
        <div className="p-3">
          <Button className="w-full" onClick={newProject} disabled={busy}>
            + New Project
          </Button>
        </div>
        <nav className="max-h-40 flex-1 overflow-y-auto px-2 pb-3 lg:max-h-none" aria-label="Saved projects">
          {ws.projects.length === 0 && <p className="px-2 text-sm text-slate-500">No saved projects yet.</p>}
          {ws.projects.map((p) => {
            const active = p.id === ws.selectedProjectId;
            return (
              <button
                key={p.id}
                onClick={() => !busy && commit((w) => ({ ...w, selectedProjectId: p.id }))}
                aria-current={active ? 'true' : undefined}
                className={`mb-1 w-full rounded-md border px-3 py-2 text-left text-sm ${active ? 'border-indigo-500 bg-indigo-50' : 'border-transparent hover:bg-slate-100'}`}
              >
                <div className="flex items-center gap-2 font-medium">
                  {active && <span className="h-2 w-2 rounded-full bg-indigo-600" aria-label="Selected" />}
                  <span className="truncate">{p.name}</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">Created {fmt(p.createdAt)}</div>
                <div className="text-xs text-slate-500">Updated {fmt(p.updatedAt)}</div>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="flex w-full flex-col overflow-y-auto border-slate-200 p-4 lg:w-[420px] lg:shrink-0 lg:border-r">
        <h1 className="text-xl font-semibold">AI Webpage Generator</h1>
        <p className="mt-1 text-sm text-slate-600">Describe a webpage application. AI generates runnable HTML, CSS and JavaScript and previews the application here.</p>
        {notice && (
          <div role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            {notice}{' '}
            <button className="underline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!page && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Example prompts</p>
            {EXAMPLES.map((ex, i) => (
              <button key={ex} onClick={() => setPrompt(ex)} className="block w-full rounded-md border border-slate-200 bg-white p-2 text-left text-sm hover:border-indigo-400">
                {i + 1}. {ex}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(prompt);
          }}
        >
          <label htmlFor="prompt" className="text-sm font-medium">
            {page ? 'Follow-up modification' : 'Webpage idea'}
          </label>
          <Textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={page ? 'e.g. Change the primary color to blue and add a search filter.' : 'Describe the webpage you want…'}
            rows={4}
            className="mt-1 bg-white"
            disabled={busy}
          />
          <Button type="submit" className="mt-2 w-full" disabled={busy || !prompt.trim()}>
            {busy ? 'Generating…' : page ? 'Apply change (new version)' : 'Generate'}
          </Button>
        </form>

        {busy && (
          <div role="status" className="mt-3 rounded-md bg-indigo-50 p-3 text-sm text-indigo-900">
            Server is calling the AI model to write index.html, styles.css and script.js… {elapsed}s (typically 30–120s)
            <div className="mt-2 h-1 overflow-hidden rounded bg-indigo-100">
              <div className="h-full w-1/3 animate-pulse bg-indigo-500" />
            </div>
          </div>
        )}

        {failed && (
          <div role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            <p className="font-semibold">Generation failed ({failed.error.code})</p>
            <p className="mt-1">{failed.error.message}</p>
            <p className="mt-1 text-xs">The last valid version was kept unchanged.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void run(failed.prompt)}>
                Retry live generation
              </Button>
            </div>
            <p className="mt-3 text-xs font-medium">Or explicitly use a saved example ({FALLBACK_LABEL}):</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {(Object.keys(FALLBACK_EXAMPLES) as (keyof typeof FALLBACK_EXAMPLES)[]).map((k) => (
                <Button key={k} size="sm" variant="outline" className="!bg-transparent text-red-900" onClick={() => applyFallback(k)}>
                  Use {k} fallback
                </Button>
              ))}
            </div>
          </div>
        )}

        {project && project.prompts.length > 0 && (
          <section className="mt-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Prompt history</h2>
            <ol className="mt-2 space-y-2">
              {project.prompts.map((q) => {
                const v = project.versions.find((x) => x.id === q.versionId);
                return (
                  <li key={q.id} className={`rounded-md border bg-white p-2 text-sm ${q.status === 'error' ? 'border-red-200' : 'border-slate-200'}`}>
                    <div className="text-xs text-slate-500">
                      {q.kind === 'followup' ? 'Follow-up' : 'Initial'} · {fmt(q.createdAt)}
                      {v && ` · v${v.version} · ${v.generationMode}`}
                    </div>
                    <p className="mt-1">{q.text}</p>
                    {q.error && <p className="mt-1 text-xs text-red-700">{q.error}</p>}
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </main>

      <section className="flex min-h-[520px] flex-1 flex-col" aria-label="App Viewer">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-sm">
          <strong>App Viewer</strong>
          {project && project.versions.length > 0 && (
            <select
              aria-label="Version"
              value={page?.id}
              onChange={(e) => commit((w) => selectVersion(w, project.id, e.target.value))}
              className="rounded border border-slate-300 bg-white px-2 py-1"
            >
              {project.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version} · {v.generationMode} · {v.title}
                </option>
              ))}
            </select>
          )}
          {page && (
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${page.generationMode === 'live' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`} data-testid="mode-label">
              {modeLabel(page)}
            </span>
          )}
          <div className="ml-auto flex gap-1">
            {page &&
              FILE_TABS.map((t) => (
                <button key={t.key} onClick={() => setTab(t.key)} className={`rounded px-2 py-1 text-xs ${tab === t.key ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
                  {t.label}
                </button>
              ))}
            <Button size="sm" variant="outline" className="!bg-transparent" disabled={!page} onClick={() => { setTab('preview'); setFrameKey((k) => k + 1); }}>
              Refresh preview
            </Button>
          </div>
        </div>
        <div className="relative flex-1 bg-slate-100">
          {!page && <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">Your generated webpage will run here in a sandboxed iframe.</div>}
          {page && tab === 'preview' && (
            <iframe
              key={`${page.id}-${frameKey}`}
              ref={iframeRef}
              title={`Generated page v${page.version}`}
              sandbox={IFRAME_SANDBOX}
              srcDoc={page.previewHtml}
              className="absolute inset-0 h-full w-full border-0 bg-white"
            />
          )}
          {page && tab !== 'preview' && <pre className="absolute inset-0 overflow-auto whitespace-pre-wrap bg-slate-950 p-4 text-xs text-slate-100">{page[tab]}</pre>}
        </div>
        {page && (
          <p className="border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
            v{page.version} · {fmt(page.createdAt)} · {page.summary}
          </p>
        )}
      </section>
    </div>
  );
}
