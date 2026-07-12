type ChangedPathSnapshot = Readonly<{ runId: string; paths: readonly string[] }>;

export type CollisionAuditRecord = Readonly<{
  runA: string;
  runB: string;
  blocking: false;
  overlapCount: number;
  observedAt: number;
}>;
export function changedPathCollision(
  a: ChangedPathSnapshot,
  b: ChangedPathSnapshot,
  observedAt: number,
): CollisionAuditRecord {
  const right = new Set(b.paths);
  let overlapCount = 0;
  for (const path of new Set(a.paths)) if (right.has(path)) overlapCount += 1;
  return { runA: a.runId, runB: b.runId, blocking: false, overlapCount, observedAt };
}
