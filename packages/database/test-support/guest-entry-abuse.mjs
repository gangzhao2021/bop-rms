import { randomBytes } from "node:crypto";
import {
  createGuestSessionRequestAdmission,
  createGuestSessionAbuseKeys,
} from "../../bop/identity/src/index.ts";
import { createAbuseBudgetConsumer } from "../src/abuse-budget.ts";

/** Real request budget; ephemeral test pepper only. Connections autocommit
 * independently of the Entry transaction, never rolling back denied attempts.
 */
export async function createEntryAbuseAdmission({ admin, role, acquire, scope, now }) {
  await admin.query("GRANT USAGE ON SCHEMA security TO " + role);
  await admin.query(
    "GRANT EXECUTE ON FUNCTION security.consume_abuse_budget(text,bytea,timestamptz,integer,integer,timestamptz) TO " +
      role,
  );
  return createGuestSessionRequestAdmission({
    scope,
    now,
    keys: createGuestSessionAbuseKeys(randomBytes(32)),
    budget: {
      consume: (input) =>
        createAbuseBudgetConsumer({
          bucketClass: "GUEST_SESSION",
          windowSeconds: input.windowSeconds,
          limitCount: input.limitCount,
          now: () => input.observedAt,
          query: async (sql, values) => {
            const connection = await acquire();
            try {
              return await connection.query(sql, values);
            } finally {
              await connection.release();
            }
          },
        }).consume(input.keyHash),
    },
  });
}
