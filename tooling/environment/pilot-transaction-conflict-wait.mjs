import { setTimeout } from "node:timers";
/**
 * WP-2423 (v15 2026-10-28 finding c): a background reader rides out a short administrative write
 * instead of failing its cycle. The daily settlement's store-publication proof locks the
 * Publishing history table in SHARE mode; a menu listing (Submit, Approve, Publish) writes that
 * table and holds ROW EXCLUSIVE until it commits, which can outlast the 2 s lock timeout. The
 * whole transaction is rerun (nothing of a failed attempt was committed; settlement runs carry
 * stable references), with growing waits, about 15 s in all before the cycle reports a failure.
 */
const conflictStates = new Set(["55P03", "40001", "40P01"]);
export function isTransactionConflict(error) {
  const code =
    error !== null && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")?.value
      : undefined;
  return code === "TENANT_DATABASE_TRANSACTION_CONFLICT" || conflictStates.has(code);
}
export function withTransactionConflictWait(
  transactions,
  {
    attempts = 6,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw Error("TRANSACTION_CONFLICT_WAIT_INVALID");
  return Object.freeze({
    ...transactions,
    async run(work) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await transactions.run(work);
        } catch (error) {
          if (!isTransactionConflict(error) || attempt >= attempts) throw error;
          await sleep(Math.round(200 * 2 ** (attempt - 1) * (0.5 + random())));
        }
      }
    },
  });
}
