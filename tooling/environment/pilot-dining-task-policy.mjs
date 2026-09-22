import process from "node:process";
import { resolveDiningExceptionTaskPolicy } from "../../packages/rms/dining/src/index.ts";
/** Optional explicit InternalTest routing; absence keeps settled-only closing. */
export function resolveInternalDiningTaskPolicy({ queue, scope, observedAt }) {
  const fail = () => {
    throw Error("INTERNAL_DINING_TASK_POLICY_UNAVAILABLE");
  };
  if (queue.exceptionTaskPolicy === undefined) return undefined;
  try {
    if (
      process.env.NODE_ENV !== "development" ||
      queue.environment !== "InternalTest" ||
      ["tenantReference", "brandReference", "storeReference"].some(
        (key) => queue[key] !== scope[key],
      ) ||
      typeof queue.effectiveFrom !== "string" ||
      typeof queue.effectiveUntil !== "string" ||
      observedAt < queue.effectiveFrom ||
      observedAt >= queue.effectiveUntil
    )
      return fail();
    const resolved = resolveDiningExceptionTaskPolicy(queue.exceptionTaskPolicy, {
      ...scope,
      requestedAt: observedAt,
      observedAt,
    });
    if (
      resolved.managerQueueReference !== queue.queueReference ||
      resolved.effectiveFrom < queue.effectiveFrom ||
      resolved.effectiveUntil > queue.effectiveUntil
    )
      return fail();
    const policy = { ...resolved };
    delete policy.dueAt;
    return Object.freeze(policy);
  } catch {
    return fail();
  }
}
