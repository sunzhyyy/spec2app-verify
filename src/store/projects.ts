import { z } from 'zod';
import { ProjectSchema, type Project } from '../domain/project';

export const STORAGE_KEY = 's2av:v1:projects';

const StoreSchema = z.object({
  schemaVersion: z.literal(1),
  selectedId: z.string().nullable(),
  projects: z.array(z.unknown()),
});

export interface LoadedStore {
  projects: Project[];
  selectedId: string | null;
  dropped: number;
}

/** Hook for future format changes; only schemaVersion 1 exists today. */
function migrate(raw: unknown): unknown {
  return raw;
}

export function loadStore(storage: Pick<Storage, 'getItem'>): LoadedStore {
  const empty: LoadedStore = { projects: [], selectedId: null, dropped: 0 };
  const text = storage.getItem(STORAGE_KEY);
  if (!text) return empty;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...empty, dropped: 1 };
  }
  const parsed = StoreSchema.safeParse(migrate(json));
  if (!parsed.success) return { ...empty, dropped: 1 };
  const projects: Project[] = [];
  for (const p of parsed.data.projects) {
    const r = ProjectSchema.safeParse(p);
    if (r.success) projects.push(r.data);
  }
  const selectedId = projects.some((p) => p.id === parsed.data.selectedId) ? parsed.data.selectedId : (projects[0]?.id ?? null);
  return { projects, selectedId, dropped: parsed.data.projects.length - projects.length };
}

export function saveStore(storage: Pick<Storage, 'setItem'>, projects: Project[], selectedId: string | null): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, selectedId, projects }));
}
