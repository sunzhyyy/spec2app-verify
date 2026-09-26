import { z } from 'zod';
import { ProjectSchema, type Project } from '../domain/project';

/** All Spec2App Verify keys share this prefix; reset only touches these keys. */
export const STORAGE_PREFIX = 's2av:';
export const STORAGE_KEY = `${STORAGE_PREFIX}v1:projects`;
export const CURRENT_SCHEMA_VERSION = 1;

const StoreSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  selectedProjectId: z.string().nullable(),
  projects: z.array(z.unknown()),
});

export interface LoadedStore {
  projects: Project[];
  selectedProjectId: string | null;
  dropped: number;
  warning: string | null;
}

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;
/** Migration boundary: add `fromVersion -> migrate` entries when the schema changes. */
const MIGRATIONS: Record<number, Migration> = {};

export function migrate(raw: unknown): { data: unknown; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { data: raw, error: 'Stored data is not an object.' };
  let data = raw as Record<string, unknown>;
  if (typeof data.schemaVersion !== 'number') return { data, error: 'Stored data has no schemaVersion.' };
  let v: number = data.schemaVersion;
  if (v > CURRENT_SCHEMA_VERSION) {
    return { data, error: `Stored data uses schemaVersion ${v}, which is newer than this app supports (${CURRENT_SCHEMA_VERSION}).` };
  }
  while (v < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return { data, error: `No migration is available from schemaVersion ${v}.` };
    data = step(data);
    v = data.schemaVersion as number;
  }
  return { data };
}

const RESET_HINT = 'Use "Reset Spec2App data" to clear it and start fresh. Other sites’ and apps’ storage is not affected.';

export function loadStore(storage: Pick<Storage, 'getItem'>): LoadedStore {
  const empty: LoadedStore = { projects: [], selectedProjectId: null, dropped: 0, warning: null };
  let text: string | null;
  try {
    text = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...empty, warning: 'Browser storage is unavailable; changes will not survive a refresh.' };
  }
  if (!text) return empty;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...empty, dropped: 1, warning: `Saved data is corrupted (invalid JSON) and was ignored. ${RESET_HINT}` };
  }
  const m = migrate(json);
  if (m.error) return { ...empty, dropped: 1, warning: `Saved data is incompatible: ${m.error} It was ignored. ${RESET_HINT}` };
  const parsed = StoreSchema.safeParse(m.data);
  if (!parsed.success) return { ...empty, dropped: 1, warning: `Saved data has an invalid structure and was ignored. ${RESET_HINT}` };
  const projects: Project[] = [];
  for (const p of parsed.data.projects) {
    const r = ProjectSchema.safeParse(p);
    if (r.success) projects.push(r.data);
  }
  const dropped = parsed.data.projects.length - projects.length;
  const sel = parsed.data.selectedProjectId;
  return {
    projects,
    selectedProjectId: projects.some((p) => p.id === sel) ? sel : (projects[0]?.id ?? null),
    dropped,
    warning: dropped ? `${dropped} saved project(s) failed validation and were skipped. ${RESET_HINT}` : null,
  };
}

export function serializeStore(projects: Project[], selectedProjectId: string | null): string {
  return JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, selectedProjectId, projects });
}

export function saveStore(storage: Pick<Storage, 'setItem'>, projects: Project[], selectedProjectId: string | null): void {
  storage.setItem(STORAGE_KEY, serializeStore(projects, selectedProjectId));
}

/** Removes only Spec2App Verify keys. */
export function resetStore(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): number {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => storage.removeItem(k));
  return keys.length;
}
