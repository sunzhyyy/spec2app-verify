import { Button } from '@/components/ui/button';
import type { Project } from '@/domain/project';
import { REPAIR_LIMITS } from '@/domain/project';
import type { ActionResult } from '@/engine/actions';
import { applyRepair, cancelRepair, DETERMINISTIC_REPAIR_LABEL, pendingAttempt, proposeRepair, repairEligibility, reverifyRepair } from '@/engine/repair';

/** Deliberate review flow: propose → review → apply as new candidate → targeted reverification. */
export default function RepairPanel({ project, apply, now }: { project: Project; apply: (r: ActionResult) => void; now: () => string }) {
  const e = repairEligibility(project);
  const pr = project.pendingRepair;
  const waiting = pendingAttempt(project);
  return (
    <div className="space-y-2 rounded border border-dashed p-3 text-sm" aria-label="Bounded repair">
      <p className="font-medium">Bounded repair – {DETERMINISTIC_REPAIR_LABEL}</p>
      <p>
        Attempts used: {project.repairAttemptCount} of {REPAIR_LIMITS.maxRepairAttempts} · AI-assisted calls: {project.aiAssistedCallCount} of {REPAIR_LIMITS.maxAiAssistedCalls} · Stable: {project.stableVersionId ?? 'none'}
      </p>
      <p className="text-muted-foreground">{waiting ? `Repair applied to ${waiting.candidateVersionId}; reverification required.` : e.reason}</p>
      {waiting && <Button onClick={() => apply(reverifyRepair(project, now()))}>Run repair reverification</Button>}
      {!waiting && !pr && <Button variant="secondary" disabled={!e.eligible} onClick={() => apply(proposeRepair(project, now()))}>Propose repair</Button>}
      {pr && (
        <div className="space-y-1 rounded border p-2 text-xs">
          <p><b>Proposal {pr.repairId}</b> for {pr.sourceVersionId} (risk {pr.regressionRisk})</p>
          <p>Failing: {[...pr.failedTestIds, ...pr.blockedTestIds].join(', ')}</p>
          <p>Cause: {pr.diagnosedCause}</p>
          <p>Paths to change: {pr.affectedDefinitionPaths.join(', ')}</p>
          <p>Expected: {pr.expectedImprovement}</p>
          <p>Approved tests are preserved unchanged ({pr.preservedRequirements.length}).</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={() => apply(applyRepair(project, now()))}>Apply as new candidate</Button>
            <Button size="sm" variant="outline" className="!bg-transparent" onClick={() => apply(cancelRepair(project, now()))}>Discard</Button>
          </div>
        </div>
      )}
      {project.repairAttempts.length > 0 && (
        <ul className="text-xs">
          {project.repairAttempts.map((a) => (
            <li key={a.repairId}>• Attempt {a.attemptNumber}: {a.sourceVersionId} → {a.candidateVersionId}, {a.outcome}, failed {a.failedCountBefore} → {a.failedCountAfter ?? '?'}{a.stopReason ? ` – ${a.stopReason}` : ''}</li>
          ))}
        </ul>
      )}
      {project.repairRejections.length > 0 && <p className="text-xs text-destructive">Last rejected proposal: {project.repairRejections.at(-1)!.reason}</p>}
    </div>
  );
}
