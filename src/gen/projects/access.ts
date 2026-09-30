/**
 * Project ownership rules shared by the client container and its tests.
 *
 * The authoritative check runs on the server: every `/api/v1/entities/projects` route requires a
 * bearer token and its service layer filters by `user_id`, so a foreign id answers 404 instead of
 * returning data. These helpers are defence in depth for the browser: a record that is not owned by
 * the signed-in user is dropped instead of displayed, even if a response somehow contained it.
 */
export interface CloudProject {
  id: number;
  user_id: string;
  name: string;
  local_id: string | null;
  payload_json: string;
  created_local_at: string | null;
}

export function ownsProject(project: CloudProject | null | undefined, userId: string): boolean {
  if (!project || !userId) return false;
  return String(project.user_id) === String(userId);
}

export function scopeToOwner(projects: CloudProject[], userId: string): CloudProject[] {
  return (projects ?? []).filter((p) => ownsProject(p, userId));
}
