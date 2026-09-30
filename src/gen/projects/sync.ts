/**
 * Translation between the browser workspace shape and the stored cloud payload.
 *
 * The payload keeps the existing local project object plus its per-version app state, so moving a
 * project into the account never changes the data the generator and preview already work with.
 * Existing local data is only ever read here, never rewritten or removed.
 */
import { SCHEMA_VERSION, WorkspaceSchema, emptyWorkspace, type Project, type Workspace } from '../store';
import type { CloudProject } from './access';
import type { ProjectPayload } from './cloud';

interface StoredPayload {
  project?: unknown;
  appState?: Record<string, unknown>;
}

export function projectPayload(workspace: Workspace, projectId: string): ProjectPayload | null {
  const project = workspace.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const appState = Object.fromEntries(Object.entries(workspace.appState).filter(([key]) => key.startsWith(`${projectId}:`)));
  return {
    name: project.name,
    local_id: project.id,
    payload_json: JSON.stringify({ project, appState }),
    created_local_at: project.createdAt,
  };
}

export function localIdOf(row: CloudProject): string | null {
  try {
    const parsed = JSON.parse(row.payload_json) as StoredPayload;
    const id = (parsed?.project as { id?: unknown })?.id;
    if (typeof id === 'string' && id) return id;
  } catch {
    /* fall back to the recorded local id */
  }
  return row.local_id ?? null;
}

/** Rebuilds a workspace from stored cloud rows, skipping any row that cannot be understood. */
export function workspaceFromCloud(rows: CloudProject[]): Workspace {
  const projects: unknown[] = [];
  const appState: Record<string, unknown> = {};
  for (const row of rows ?? []) {
    if (!row || typeof row.payload_json !== 'string') continue;
    try {
      const parsed = JSON.parse(row.payload_json) as StoredPayload;
      if (!parsed || typeof parsed !== 'object' || !parsed.project) continue;
      projects.push(parsed.project);
      if (parsed.appState && typeof parsed.appState === 'object') Object.assign(appState, parsed.appState);
    } catch {
      /* ignore unreadable rows instead of failing the whole account */
    }
  }
  const selectedProjectId = (projects[0] as { id?: string } | undefined)?.id ?? null;
  const candidate = WorkspaceSchema.safeParse({ schemaVersion: SCHEMA_VERSION, projects, selectedProjectId, appState });
  return candidate.success ? candidate.data : emptyWorkspace();
}

/** Union of two workspaces: `primary` wins on conflicts and `extra` only contributes missing projects. */
export function mergeWorkspaces(primary: Workspace, extra: Workspace): Workspace {
  const byId = new Map<string, Project>();
  for (const project of primary.projects) byId.set(project.id, project);
  for (const project of extra.projects) if (!byId.has(project.id)) byId.set(project.id, project);
  const projects = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    schemaVersion: SCHEMA_VERSION,
    projects,
    selectedProjectId: primary.selectedProjectId && byId.has(primary.selectedProjectId) ? primary.selectedProjectId : projects[0]?.id ?? null,
    appState: { ...primary.appState, ...extra.appState },
  };
}
