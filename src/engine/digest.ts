import type { AcceptanceTest } from '../domain/project';

/** Stable digest of the approved test set; used to detect any change to approved tests. */
export function testsDigest(tests: AcceptanceTest[]): string {
  const s = JSON.stringify(tests.map((t) => [t.id, t.title, t.requirementReference, t.precondition, t.action, t.expectedResult, t.verificationType, t.priority, t.approved]));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `t${h.toString(16)}`;
}
