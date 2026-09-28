import { z } from 'zod';
import { PageResourceSchema, newId, type PageResource } from './core';

export const STORAGE_KEY = 'ai-webpage-generator.workspace';
export const SCHEMA_VERSION = 1;

const PromptEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['initial', 'followup']),
  createdAt: z.string(),
  status: z.enum(['ok', 'error']),
  versionId: z.string().nullable(),
  error: z.string().nullable(),
});
export type PromptEntry = z.infer<typeof PromptEntrySchema>;

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  prompts: z.array(PromptEntrySchema),
  versions: z.array(PageResourceSchema),
  selectedVersionId: z.string().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

const AppStateEntrySchema = z.object({ data: z.unknown(), savedAt: z.string() });

export const WorkspaceSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  projects: z.array(ProjectSchema),
  selectedProjectId: z.string().nullable(),
  appState: z.record(AppStateEntrySchema),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const emptyWorkspace = (): Workspace => ({ schemaVersion: SCHEMA_VERSION, projects: [], selectedProjectId: null, appState: {} });

export const appStateKey = (projectId: string, versionId: string) => `${projectId}:${versionId}`;

export interface LoadResult {
  workspace: Workspace;
  warning: string | null;
}

export function loadWorkspace(storage: Storage = localStorage): LoadResult {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return { workspace: emptyWorkspace(), warning: null };
  try {
    const parsed = WorkspaceSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { workspace: parsed.data, warning: null };
  } catch {
    /* fall through to recovery */
  }
  storage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw);
  return { workspace: emptyWorkspace(), warning: 'Stored workspace was corrupted or incompatible. A backup copy was kept and a fresh workspace was started.' };
}

export function saveWorkspace(ws: Workspace, storage: Storage = localStorage): string | null {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ws));
    return null;
  } catch (e) {
    return `Could not save workspace: ${(e as Error).message}`;
  }
}

const now = () => new Date().toISOString();

export function createProject(ws: Workspace, name = 'Untitled project'): { ws: Workspace; project: Project } {
  const t = now();
  const project: Project = { id: newId('p'), name, createdAt: t, updatedAt: t, prompts: [], versions: [], selectedVersionId: null };
  return { ws: { ...ws, projects: [project, ...ws.projects], selectedProjectId: project.id }, project };
}

function updateProject(ws: Workspace, projectId: string, fn: (p: Project) => Project): Workspace {
  return { ...ws, projects: ws.projects.map((p) => (p.id === projectId ? fn(p) : p)) };
}

export function addVersion(ws: Workspace, page: PageResource): Workspace {
  return updateProject(ws, page.projectId, (p) => ({
    ...p,
    name: p.versions.length === 0 ? page.title : p.name,
    versions: [...p.versions, page],
    selectedVersionId: page.id,
    prompts: [
      ...p.prompts,
      { id: newId('q'), text: page.prompt, kind: page.kind, createdAt: page.createdAt, status: 'ok', versionId: page.id, error: null },
    ],
    updatedAt: now(),
  }));
}

export function recordFailedPrompt(ws: Workspace, projectId: string, text: string, kind: 'initial' | 'followup', error: string): Workspace {
  return updateProject(ws, projectId, (p) => ({
    ...p,
    prompts: [...p.prompts, { id: newId('q'), text, kind, createdAt: now(), status: 'error', versionId: null, error }],
    updatedAt: now(),
  }));
}

export function selectVersion(ws: Workspace, projectId: string, versionId: string): Workspace {
  return updateProject(ws, projectId, (p) => ({ ...p, selectedVersionId: versionId }));
}

export function markRendered(ws: Workspace, projectId: string, versionId: string): Workspace {
  const project = ws.projects.find((p) => p.id === projectId);
  const version = project?.versions.find((v) => v.id === versionId);
  if (!version || version.renderVerified) return ws;
  return updateProject(ws, projectId, (p) => ({ ...p, versions: p.versions.map((v) => (v.id === versionId ? { ...v, renderVerified: true } : v)) }));
}

export function setAppState(ws: Workspace, projectId: string, versionId: string, data: unknown): Workspace {
  return { ...ws, appState: { ...ws.appState, [appStateKey(projectId, versionId)]: { data, savedAt: now() } } };
}

export function getAppState(ws: Workspace, projectId: string, versionId: string): unknown {
  return ws.appState[appStateKey(projectId, versionId)]?.data ?? null;
}

export function deleteProject(ws: Workspace, projectId: string): Workspace {
  const appState = Object.fromEntries(Object.entries(ws.appState).filter(([k]) => !k.startsWith(`${projectId}:`)));
  const projects = ws.projects.filter((p) => p.id !== projectId);
  return { ...ws, projects, appState, selectedProjectId: ws.selectedProjectId === projectId ? projects[0]?.id ?? null : ws.selectedProjectId };
}
