export class ReconciliationFollowUpClientError extends Error {
  constructor(readonly kind: "Conflict" | "Denied" | "Invalid" | "Unknown") {
    super("RECONCILIATION_FOLLOW_UP_" + kind.toUpperCase());
    this.name = "ReconciliationFollowUpClientError";
  }
}
const fail = (): never => {
  throw new ReconciliationFollowUpClientError("Unknown");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function object(value: unknown, keys: string[]) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) return fail();
    result[key] = d.value;
  }
  return result;
}
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}

export interface FollowUpView {
  version: number;
  followUpStatus: "Open" | "Acknowledged" | "Assigned";
  acknowledged: boolean;
  assigned: boolean;
  updatedAt: string;
}
export interface FollowUpCommand {
  exceptionReference: string;
  action: "Acknowledge" | "Assign" | "AssignSelf";
  assigneeReference: string | null;
  expectedVersion: number;
  operationReference: string;
}
const version = (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v >= Number.MAX_SAFE_INTEGER)
    return fail();
  return v;
};
const reference = (v: unknown) => {
  if (typeof v !== "string" || !ref.test(v)) return fail();
  return v;
};
export function parseFollowUpView(value: unknown): FollowUpView {
  const x = object(value, ["version", "followUpStatus", "acknowledged", "assigned", "updatedAt"]);
  if (
    !["Open", "Acknowledged", "Assigned"].includes(String(x.followUpStatus)) ||
    typeof x.acknowledged !== "boolean" ||
    typeof x.assigned !== "boolean" ||
    (x.followUpStatus === "Open" && (x.acknowledged || x.assigned)) ||
    (x.followUpStatus === "Acknowledged" && (!x.acknowledged || x.assigned)) ||
    (x.followUpStatus === "Assigned" && !x.assigned)
  )
    return fail();
  return Object.freeze({
    version: version(x.version),
    followUpStatus: x.followUpStatus as FollowUpView["followUpStatus"],
    acknowledged: x.acknowledged,
    assigned: x.assigned,
    updatedAt: instant(x.updatedAt),
  });
}
export interface CaptureEvidenceSummary {
  amountMinor: string;
  currencyCode: "CAD";
  environment: "Test" | "Live";
  occurredAt: string;
  observedAt: string;
  recordedReason: "ProviderCaptureWithoutInternalOperation";
}
function parseCaptureEvidence(value: unknown): CaptureEvidenceSummary | null {
  const envelope = object(value, ["evidence"]);
  if (envelope.evidence === null) return null;
  const x = object(envelope.evidence, [
    "amountMinor",
    "currencyCode",
    "environment",
    "occurredAt",
    "observedAt",
    "recordedReason",
  ]);
  if (
    typeof x.amountMinor !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(x.amountMinor) ||
    BigInt(x.amountMinor) > 9223372036854775807n ||
    x.currencyCode !== "CAD" ||
    (x.environment !== "Test" && x.environment !== "Live") ||
    x.recordedReason !== "ProviderCaptureWithoutInternalOperation"
  )
    return fail();
  const occurredAt = instant(x.occurredAt),
    observedAt = instant(x.observedAt);
  if (occurredAt > observedAt) return fail();
  return Object.freeze({
    amountMinor: x.amountMinor,
    currencyCode: "CAD",
    environment: x.environment,
    occurredAt,
    observedAt,
    recordedReason: x.recordedReason,
  });
}
export function createReconciliationFollowUpClient(fetcher: typeof fetch = fetch) {
  async function post(
    query: boolean | "evidence" | "assignees",
    payload: string,
    csrf: string,
    signal?: AbortSignal,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf) || signal?.aborted) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetcher(
        "/merchant/operations/order-exceptions/follow-up" +
          (typeof query === "string" ? "-" + query : query ? "-query" : ""),
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": csrf,
          },
          body: payload,
          signal: controller.signal,
        },
      );
      if (
        response.headers.get("cache-control") !== "no-store" ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      )
        return fail();
      const text = await response.text();
      if (controller.signal.aborted || text.length > (query === "assignees" ? 8192 : 2048))
        return fail();
      const value: unknown = JSON.parse(text);
      if (response.status !== (query ? 200 : 202)) {
        const error = object(value, ["error"]);
        if (
          !query &&
          response.status === 409 &&
          error.error === "reconciliation_follow_up_conflict"
        )
          throw new ReconciliationFollowUpClientError("Conflict");
        if (response.status === 403 && error.error === "request_denied")
          throw new ReconciliationFollowUpClientError("Denied");
        if (!query && response.status === 400 && error.error === "reconciliation_follow_up_invalid")
          throw new ReconciliationFollowUpClientError("Invalid");
        return fail();
      }
      return value;
    } catch (error) {
      if (error instanceof ReconciliationFollowUpClientError) throw error;
      return fail();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({
    assignees: async (
      exceptionReference: string,
      afterActorReference: string | null,
      csrf: string,
      signal?: AbortSignal,
    ) => {
      const x = object(
        await post(
          "assignees",
          JSON.stringify({
            exceptionReference: reference(exceptionReference),
            afterActorReference:
              afterActorReference === null ? null : reference(afterActorReference),
          }),
          csrf,
          signal,
        ),
        ["items", "nextAfterActorReference"],
      );
      if (!Array.isArray(x.items) || x.items.length > 25) return fail();
      const seen = new Set<string>();
      const items = x.items.map((value: unknown) => {
        const item = object(value, ["actorReference", "label"]),
          actorReference = reference(item.actorReference);
        if (
          seen.has(actorReference) ||
          typeof item.label !== "string" ||
          !/^([^\p{Cc}\p{Cf}]){1,80}$/u.test(item.label) ||
          item.label.trim() !== item.label ||
          item.label.includes("@")
        )
          return fail();
        seen.add(actorReference);
        return Object.freeze({ reference: actorReference, label: item.label });
      });
      return Object.freeze({
        items: Object.freeze(items),
        nextAfterActorReference:
          x.nextAfterActorReference === null ? null : reference(x.nextAfterActorReference),
      });
    },
    evidence: async (exceptionReference: string, csrf: string, signal?: AbortSignal) =>
      parseCaptureEvidence(
        await post(
          "evidence",
          JSON.stringify({ exceptionReference: reference(exceptionReference) }),
          csrf,
          signal,
        ),
      ),
    query: async (exceptionReference: string, csrf: string, signal?: AbortSignal) =>
      parseFollowUpView(
        await post(
          true,
          JSON.stringify({ exceptionReference: reference(exceptionReference) }),
          csrf,
          signal,
        ),
      ),
    prepare(value: FollowUpCommand) {
      const x = object(value, [
        "exceptionReference",
        "action",
        "assigneeReference",
        "expectedVersion",
        "operationReference",
      ]);
      if (x.action !== "Acknowledge" && x.action !== "Assign" && x.action !== "AssignSelf")
        return fail();
      if ((x.action !== "Assign") !== (x.assigneeReference === null)) return fail();
      const command = Object.freeze({
          exceptionReference: reference(x.exceptionReference),
          action: x.action,
          assigneeReference: x.assigneeReference === null ? null : reference(x.assigneeReference),
          expectedVersion: version(x.expectedVersion),
          operationReference: reference(x.operationReference),
        }),
        payload = JSON.stringify(command);
      return Object.freeze({
        execute: async (csrf: string, signal?: AbortSignal) => {
          const result = object(await post(false, payload, csrf, signal), [
            "status",
            "replayed",
            "version",
            "followUpStatus",
            "updatedAt",
          ]);
          if (
            result.status !== "FollowUpRecorded" ||
            typeof result.replayed !== "boolean" ||
            version(result.version) !== command.expectedVersion + 1 ||
            !["Acknowledged", "Assigned"].includes(String(result.followUpStatus)) ||
            (command.action !== "Acknowledge" && result.followUpStatus !== "Assigned")
          )
            return fail();
          return Object.freeze({
            replayed: result.replayed,
            version: Number(result.version),
            followUpStatus: result.followUpStatus as "Acknowledged" | "Assigned",
            updatedAt: instant(result.updatedAt),
          });
        },
      });
    },
  });
}
