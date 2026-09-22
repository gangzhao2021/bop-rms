import process from "node:process";
import { parsePaymentReconciliationRunInput } from "../../packages/rms/payment/src/index.ts";
/** One dedicated connection owns one Store/run lease; never return a locked client to the pool. */
export function createInternalReconciliationLease({ database, run: rawRun, active }) {
  const run = parsePaymentReconciliationRunInput(rawRun),
    jobName = "payment-reconciliation:v1";
  const fail = () => {
    throw Error("RECONCILIATION_EXECUTION_LEASE_UNAVAILABLE");
  };
  const allowed = () => process.env.NODE_ENV === "development" && active() === true;
  if (!allowed()) return fail();
  const key = "PaymentReconciliationExecution:" + run.brandReference + ":" + run.storeReference;
  let client = null,
    pid = null,
    attempted = false,
    held = false,
    lost = false,
    closed = false;
  const onError = () => {
    lost = true;
    held = false;
  };
  const dispose = async () => {
    closed = true;
    held = false;
    const current = client;
    client = null;
    if (current) {
      current.removeListener("error", onError);
      current.release(true);
    }
  };
  const exact = (input, keys) =>
    input &&
    Object.keys(input).length === keys.length &&
    keys.every(
      (k) =>
        input[k] === { runReference: run.runReference, scheduledAt: run.scheduledAt, jobName }[k],
    );
  return Object.freeze({
    async claim(input) {
      if (
        !exact(input, ["runReference", "jobName", "scheduledAt"]) ||
        !allowed() ||
        closed ||
        attempted
      )
        return false;
      attempted = true;
      try {
        client = await database.acquire();
        client.on("error", onError);
        if (closed || !allowed()) return fail();
        const result = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired,pg_backend_pid() AS pid",
          [key],
        );
        if (
          result.rows.length !== 1 ||
          typeof result.rows[0].acquired !== "boolean" ||
          !Number.isSafeInteger(result.rows[0].pid) ||
          result.rows[0].pid < 1
        )
          return fail();
        if (!result.rows[0].acquired) {
          await dispose();
          return false;
        }
        pid = result.rows[0].pid;
        held = true;
        if (lost || closed || !allowed()) return fail();
        return true;
      } catch {
        await dispose();
        return fail();
      }
    },
    async assertHeld() {
      if (!held || lost || closed || !allowed() || !client) return fail();
      try {
        const result = await client.query("SELECT pg_backend_pid() AS pid");
        if (result.rows.length !== 1 || result.rows[0].pid !== pid || lost || closed || !allowed())
          return fail();
        return true;
      } catch {
        lost = true;
        held = false;
        return fail();
      }
    },
    async release(input) {
      if (!exact(input, ["runReference", "jobName"])) return fail();
      await dispose();
    },
    dispose,
  });
}
