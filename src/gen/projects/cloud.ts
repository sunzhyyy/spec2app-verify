/**
 * Cloud project access.
 *
 * Reads and writes go to the Atoms Cloud entity API, which scopes every request to the caller's
 * bearer token. A signed-in user therefore only ever receives their own rows, and an id belonging
 * to somebody else answers 404 rather than returning data.
 */
import { createClient } from '@metagptx/web-sdk';
import { ownsProject, scopeToOwner, type CloudProject } from './access';

const ENTITY = 'projects';
export const PAGE_LIMIT = 200;

export interface ProjectsApi {
  query(params: Record<string, unknown>): Promise<unknown>;
  get(params: Record<string, unknown>): Promise<unknown>;
  create(params: Record<string, unknown>): Promise<unknown>;
  update(params: Record<string, unknown>): Promise<unknown>;
  delete(params: Record<string, unknown>): Promise<unknown>;
}

let cached: ProjectsApi | null = null;

/** Resolved lazily so importing this module never requires a configured SDK client. */
export const projectsApi = (): ProjectsApi => {
  if (!cached) cached = (createClient() as unknown as { entities: Record<string, ProjectsApi> }).entities[ENTITY];
  return cached;
};

const itemsOf = (response: unknown): CloudProject[] => {
  const body = (response as { data?: unknown })?.data ?? response;
  const items = (body as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as CloudProject[]) : [];
};

const itemOf = (response: unknown): CloudProject | null => {
  const body = (response as { data?: unknown })?.data ?? response;
  return body && typeof body === 'object' && 'id' in (body as object) ? (body as CloudProject) : null;
};

export interface ProjectPayload {
  name: string;
  local_id: string;
  payload_json: string;
  created_local_at: string;
}

export interface ProjectTransport {
  readonly userId: string;
  list(): Promise<CloudProject[]>;
  get(id: number): Promise<CloudProject | null>;
  create(payload: ProjectPayload): Promise<CloudProject | null>;
  update(id: number, payload: Partial<ProjectPayload>): Promise<CloudProject | null>;
  remove(id: number): Promise<boolean>;
}

/**
 * Returns a transport bound to one signed-in user. `user_id` is never sent from the browser: the
 * server derives it from the token, so a client cannot create or claim a row for somebody else.
 */
export function createCloudTransport(userId: string, api: ProjectsApi = projectsApi()): ProjectTransport {
  const owned = (project: CloudProject | null) => (ownsProject(project, userId) ? project : null);
  return {
    userId,
    async list() {
      return scopeToOwner(itemsOf(await api.query({ sort: '-updated_at', limit: PAGE_LIMIT })), userId);
    },
    async get(id) {
      try {
        return owned(itemOf(await api.get({ id })));
      } catch {
        return null;
      }
    },
    async create(payload) {
      return owned(itemOf(await api.create({ data: payload })));
    },
    async update(id, payload) {
      try {
        return owned(itemOf(await api.update({ id, data: payload })));
      } catch {
        return null;
      }
    },
    async remove(id) {
      try {
        await api.delete({ id });
        return true;
      } catch {
        return false;
      }
    },
  };
}
