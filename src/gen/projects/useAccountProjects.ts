/**
 * Server-backed projects for the signed-in user.
 *
 * The browser workspace stays the working copy, so the generator keeps working offline. On sign-in
 * the account's projects are loaded and any project that only exists on this browser is imported
 * once; afterwards every project edit is mirrored to the account. All server calls carry the
 * session token, and the server derives the owner from that token, so one account can never read or
 * modify another account's rows.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { markImportPromptAsked, type SignedInUser } from '../auth/session';
import { saveWorkspace, type Workspace } from '../store';
import { createCloudTransport } from './cloud';
import { localIdOf, mergeWorkspaces, projectPayload, workspaceFromCloud } from './sync';

interface Options {
  user: SignedInUser | null;
  ws: Workspace;
  commit: (fn: (w: Workspace) => Workspace) => void;
  onNotice: (message: string | null) => void;
}

/** Signature of a project's mutable state, including app state saved by the generated page. */
function signatureOf(ws: Workspace, projectId: string): string {
  let stamp = ws.projects.find((p) => p.id === projectId)?.updatedAt ?? '';
  for (const [key, entry] of Object.entries(ws.appState)) {
    if (key.startsWith(`${projectId}:`) && entry.savedAt > stamp) stamp = entry.savedAt;
  }
  return stamp;
}

export function useAccountProjects({ user, ws, commit, onNotice }: Options) {
  const userId = user?.id ?? null;
  const transport = useMemo(() => (userId ? createCloudTransport(userId) : null), [userId]);
  const rowIds = useRef(new Map<string, number>());
  const synced = useRef(new Map<string, string>());
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const [syncing, setSyncing] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!transport) return;
    let active = true;
    setSyncing(true);
    void (async () => {
      try {
        const rows = await transport.list();
        if (!active) return;
        const cloud = workspaceFromCloud(rows);
        const cloudIds = new Set(rows.map((row) => localIdOf(row)).filter((id): id is string => Boolean(id)));
        rowIds.current = new Map(rows.map((row) => [localIdOf(row) ?? `row-${row.id}`, row.id]));

        const local = wsRef.current;
        let imported = 0;
        for (const project of local.projects) {
          if (cloudIds.has(project.id)) continue;
          const payload = projectPayload(local, project.id);
          if (!payload) continue;
          const row = await transport.create(payload);
          if (row) {
            rowIds.current.set(project.id, row.id);
            imported += 1;
          }
        }
        if (!active) return;

        const merged = cloud.projects.length > 0 ? mergeWorkspaces(cloud, local) : local;
        commit(() => merged);
        const error = saveWorkspace(merged);
        if (error) onNotice(error);
        else if (imported > 0) onNotice(`Imported ${imported} project${imported === 1 ? '' : 's'} from this browser into your account.`);
        markImportPromptAsked();
        for (const project of merged.projects) synced.current.set(project.id, signatureOf(merged, project.id));
        setReady(true);
      } catch {
        if (!active) return;
        onNotice('Your projects could not be loaded from your account. Projects in this browser are unchanged.');
        setReady(true);
      } finally {
        if (active) setSyncing(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [transport, commit, onNotice]);

  useEffect(() => {
    if (!transport || !ready) return;
    const pending = ws.projects.filter((project) => synced.current.get(project.id) !== signatureOf(ws, project.id));
    const liveIds = new Set(ws.projects.map((project) => project.id));
    const removed = [...rowIds.current.keys()].filter((id) => !liveIds.has(id));
    if (pending.length === 0 && removed.length === 0) return;

    void (async () => {
      try {
        for (const project of pending) {
          const payload = projectPayload(ws, project.id);
          if (!payload) continue;
          const rowId = rowIds.current.get(project.id);
          const saved = rowId ? await transport.update(rowId, payload) : await transport.create(payload);
          if (saved) rowIds.current.set(project.id, saved.id);
          synced.current.set(project.id, signatureOf(ws, project.id));
        }
        for (const id of removed) {
          const rowId = rowIds.current.get(id);
          if (rowId) await transport.remove(rowId);
          rowIds.current.delete(id);
          synced.current.delete(id);
        }
      } catch {
        onNotice('A change could not be saved to your account. The local copy is safe; edit the project again to retry.');
      }
    })();
  }, [transport, ready, ws, onNotice]);

  return { syncing };
}
