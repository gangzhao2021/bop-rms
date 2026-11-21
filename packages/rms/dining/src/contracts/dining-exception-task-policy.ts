import { exactObject, parsePositiveDiningVersion, DiningClosingError } from "./dining-closing.js";
import { parseDiningReference, parseDiningInstant } from "./dining-session.js";

/** Explicit server routing configuration; never accepts browser-selected Queue/SLA.
 * This evidence assigns work, and does not prove queue membership or financial finality. */
export function resolveDiningExceptionTaskPolicy(
  value: unknown,
  request: {
    brandReference: string;
    storeReference: string;
    requestedAt: string;
    observedAt: string;
  },
) {
  try {
    const raw = exactObject(value, [
      "policyReference",
      "version",
      "brandReference",
      "storeReference",
      "managerQueueReference",
      "escalationPolicyReference",
      "dueAfterMilliseconds",
      "effectiveFrom",
      "effectiveUntil",
    ]);
    const policy = Object.freeze({
      policyReference: parseDiningReference(raw.policyReference),
      version: parsePositiveDiningVersion(raw.version),
      brandReference: parseDiningReference(raw.brandReference),
      storeReference: parseDiningReference(raw.storeReference),
      managerQueueReference: parseDiningReference(raw.managerQueueReference),
      escalationPolicyReference: parseDiningReference(raw.escalationPolicyReference),
      dueAfterMilliseconds: raw.dueAfterMilliseconds,
      effectiveFrom: parseDiningInstant(raw.effectiveFrom),
      effectiveUntil: parseDiningInstant(raw.effectiveUntil),
    });
    const brand = parseDiningReference(request.brandReference),
      store = parseDiningReference(request.storeReference),
      requestedAt = parseDiningInstant(request.requestedAt),
      observedAt = parseDiningInstant(request.observedAt);
    if (
      policy.brandReference !== brand ||
      policy.storeReference !== store ||
      !Number.isSafeInteger(policy.dueAfterMilliseconds) ||
      (policy.dueAfterMilliseconds as number) <= 0 ||
      policy.effectiveFrom >= policy.effectiveUntil ||
      requestedAt < policy.effectiveFrom ||
      requestedAt > observedAt ||
      observedAt >= policy.effectiveUntil
    )
      throw new Error();
    const dueEpoch = Date.parse(requestedAt) + (policy.dueAfterMilliseconds as number);
    if (!Number.isSafeInteger(dueEpoch)) throw new Error();
    const dueAt = parseDiningInstant(new Date(dueEpoch).toISOString());
    return Object.freeze({
      ...policy,
      dueAfterMilliseconds: policy.dueAfterMilliseconds as number,
      dueAt,
    });
  } catch {
    throw new DiningClosingError("DINING_CLOSING_TASK_REQUIRED");
  }
}
