import { snapshotReadBegin, snapshotReadStatement } from "../src/snapshot-read.ts";

/**
 * WP-2423: the application runner's snapshot read (`runSnapshot`) for an acceptance fixture's own
 * restricted-role runner: the same BEGIN and the same statement rules (fences and table locks
 * answered locally, trailing row locks dropped), so polled merchant reads run here exactly as in
 * the pilot.
 */
export const snapshotBegin = snapshotReadBegin;
export function snapshotQuery(query) {
  return (sql, values) => {
    const planned = snapshotReadStatement(sql);
    return planned.kind === "Answer" ? Promise.resolve(planned.result) : query(planned.sql, values);
  };
}
