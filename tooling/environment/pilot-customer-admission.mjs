import { readFile, lstat, realpath } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import {
  createGuestSessionRequestAdmission,
  createGuestSessionAbuseKeys,
} from "../../packages/bop/identity/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";

/** Local trusted configuration, sharing API connection ownership with its caller. */
export async function createCustomerRequestAdmission(
  { database, scope, now = () => new Date().toISOString() },
  { file },
) {
  if (!isPilotRuntime({ test: true, unset: "development" }))
    throw new Error("LOCAL_GUEST_ADMISSION_UNAVAILABLE");
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
  const secret = Buffer.from(raw, "hex");
  const keys = createGuestSessionAbuseKeys(secret);
  secret.fill(0);
  return createGuestSessionRequestAdmission({
    scope,
    now,
    keys,
    budget: {
      consume: (input) =>
        createAbuseBudgetConsumer({
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
        }).consume(input.keyHash),
    },
  });
}
