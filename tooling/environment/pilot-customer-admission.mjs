import { readFile, lstat, realpath } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  createGuestSessionRequestAdmission,
  createGuestSessionAbuseKeys,
  guestTableWaitPolicy,
} from "../../packages/bop/identity/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** Local trusted configuration, sharing API connection ownership with its caller. */
export async function createCustomerRequestAdmission(
  { database, scope, now = () => new Date().toISOString() },
  { file, loadSecret = () => readLocalPepper(file) },
) {
  if (!isPilotRuntime({ test: true, unset: "development" }))
    throw new Error("LOCAL_GUEST_ADMISSION_UNAVAILABLE");
  const secret = await loadSecret();
  if (!(secret instanceof Buffer) || secret.length !== 32)
    throw new Error("LOCAL_GUEST_ADMISSION_UNAVAILABLE");
  const keys = createGuestSessionAbuseKeys(secret);
  const waitKeys = createGuestSessionAbuseKeys(secret, "table-wait");
  secret.fill(0);
  const budget = { consume: (input) => consumeBudget(database, input) };
  const entry = createGuestSessionRequestAdmission({ scope, now, keys, budget });
  // WP-2423 (guest-waits-and-refund-lock): "is the table open now?" checks, their own budget.
  const tableWait = createGuestSessionRequestAdmission({
    scope,
    now,
    keys: waitKeys,
    budget,
    policy: guestTableWaitPolicy,
  });
  return Object.freeze({ consume: entry.consume, tableWait });
}
/** InternalTest: the generated local pepper file (0600, own, not a link). */
async function readLocalPepper(file) {
  const state = await lstat(file);
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    (state.mode & 0o777) !== 0o600 ||
    state.uid !== process.getuid() ||
    (await realpath(file)) !== file
  )
    throw new Error("LOCAL_GUEST_ADMISSION_UNAVAILABLE");
  const raw = await readFile(file, "utf8");
  if (!/^[a-f0-9]{64}$/u.test(raw)) throw new Error("LOCAL_GUEST_ADMISSION_UNAVAILABLE");
  return Buffer.from(raw, "hex");
}
function consumeBudget(database, input) {
  return createAbuseBudgetConsumer({
    bucketClass: "GUEST_SESSION",
    windowSeconds: input.windowSeconds,
    limitCount: input.limitCount,
    now: () => input.observedAt,
    query: async (sql, values) => {
      const connection = await database.acquire();
      try {
        return await connection.query(sql, [...values]);
      } finally {
        connection.release();
      }
    },
  }).consume(input.keyHash);
}
