import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode as code,
} from "./catalog-product-command-values.js";
export const productPublicationUserActions = [
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
] as const;
export type ProductPublicationUserAction = (typeof productPublicationUserActions)[number];
export class ProductPublicationClientError extends Error {
  constructor(
    readonly code:
      "Invalid" | "Denied" | "Conflict" | "FeatureDisabled" | "Unavailable" | "OutcomeUnknown",
    readonly attemptCode?: "Invalid" | "Denied" | "Conflict" | "FeatureDisabled",
  ) {
    super("Product publication action could not be confirmed");
    this.name = "ProductPublicationClientError";
  }
}
const invalid = (): never => {
  throw new ProductPublicationClientError("Invalid");
};
const maximumRequestBytes = 8192,
  maximumResponseBytes = 65536;
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
function integer(value: unknown, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 2147483647)
    return invalid();
  return value as number;
}
function hash(value: unknown) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return invalid();
  return value as T;
}
function codes(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const result = value.map(code).sort();
  if (new Set(result).size !== result.length) return invalid();
  return Object.freeze(result);
}
function boundary(value: unknown, timeZone: string) {
  const r = record(value, ["instant", "localDateTime", "utcOffsetMinutes"]);
  const at = instant(r.instant),
    local = r.localDateTime;
  if (
    typeof local !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/u.test(local) ||
    !Number.isInteger(r.utcOffsetMinutes) ||
    Number(r.utcOffsetMinutes) < -840 ||
    Number(r.utcOffsetMinutes) > 840
  )
    return invalid();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  const rendered = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
  const localInstant = Date.parse(local + "Z");
  if (
    rendered !== local ||
    !Number.isFinite(localInstant) ||
    new Date(localInstant).toISOString().slice(0, -1) !== local ||
    (localInstant - Date.parse(at)) / 60000 !== r.utcOffsetMinutes
  )
    return invalid();
  return Object.freeze({
    instant: at,
    localDateTime: local,
    utcOffsetMinutes: r.utcOffsetMinutes as number,
  });
}
export function parseProductPublicationPeriod(value: unknown) {
  const r = record(value, ["timeZone", "effectiveFrom", "effectiveUntil"]);
  if (typeof r.timeZone !== "string" || r.timeZone.length < 1 || r.timeZone.length > 100)
    return invalid();
  const effectiveFrom = boundary(r.effectiveFrom, r.timeZone),
    effectiveUntil = r.effectiveUntil === null ? null : boundary(r.effectiveUntil, r.timeZone);
  if (effectiveUntil && effectiveUntil.instant <= effectiveFrom.instant) return invalid();
  return Object.freeze({ timeZone: r.timeZone, effectiveFrom, effectiveUntil });
}
export function parseProductPublicationScopes(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) return invalid();
  const result = value.map((v) => {
    const r = record(v, ["level", "reference", "channelCodes", "orderTypeCodes"]);
    const level = choice(r.level, [
      "Store",
      "StoreGroup",
      "Region",
      "Channel",
      "OrderType",
      "Brand",
    ] as const);
    const reference =
      level === "Brand"
        ? r.reference === null
          ? null
          : invalid()
        : level === "Channel" || level === "OrderType"
          ? code(r.reference)
          : ref(r.reference);
    const channelCodes = codes(r.channelCodes),
      orderTypeCodes = codes(r.orderTypeCodes);
    if (
      (level === "Channel" &&
        channelCodes.length > 0 &&
        (channelCodes.length !== 1 || channelCodes[0] !== reference)) ||
      (level === "OrderType" &&
        orderTypeCodes.length > 0 &&
        (orderTypeCodes.length !== 1 || orderTypeCodes[0] !== reference))
    )
      return invalid();
    return Object.freeze({ level, reference, channelCodes, orderTypeCodes });
  });
  // Canonical sorting matches owning RFC8785 for this fixed ASCII-key shape.
  const key = (s: (typeof result)[number]) =>
    JSON.stringify({
      channelCodes: s.channelCodes,
      level: s.level,
      orderTypeCodes: s.orderTypeCodes,
      reference: s.reference,
    });
  if (new Set(result.map(key)).size !== result.length) return invalid();
  return Object.freeze(result.sort((a, b) => key(a).localeCompare(key(b), "en")));
}
export function parseProductPublicationUserCommand(value: unknown) {
  try {
    const r = record(copyProductCommandValue(value), [
      "operationReference",
      "productReference",
      "versionReference",
      "expectedProductAggregateVersion",
      "expectedPublicationVersion",
      "action",
      "contentDigest",
      "configurationDigest",
      "scopeSet",
      "effectivePeriod",
      "scheduleReference",
      "replacementVersionReference",
      "successorDraftVersionReference",
      "occurredAt",
      "reasonCode",
    ]);
    const action = choice(r.action, productPublicationUserActions),
      scheduleReference = nullableRef(r.scheduleReference),
      versionReference = ref(r.versionReference),
      successorDraftVersionReference = nullableRef(r.successorDraftVersionReference);
    const scheduled = ["SchedulePublish", "ReschedulePublish", "CancelScheduledPublish"].includes(
      action,
    );
    if (
      scheduled !== (scheduleReference !== null) ||
      r.replacementVersionReference !== null ||
      (action === "Publish") !== (successorDraftVersionReference !== null) ||
      successorDraftVersionReference === versionReference
    )
      return invalid();
    return Object.freeze({
      operationReference: ref(r.operationReference),
      productReference: ref(r.productReference),
      versionReference,
      expectedProductAggregateVersion: integer(r.expectedProductAggregateVersion, 1),
      expectedPublicationVersion: integer(r.expectedPublicationVersion),
      action,
      contentDigest: hash(r.contentDigest),
      configurationDigest: hash(r.configurationDigest),
      scopeSet: parseProductPublicationScopes(r.scopeSet),
      effectivePeriod: parseProductPublicationPeriod(r.effectivePeriod),
      scheduleReference,
      replacementVersionReference: null,
      successorDraftVersionReference,
      occurredAt: instant(r.occurredAt),
      reasonCode: code(r.reasonCode),
    });
  } catch {
    return invalid();
  }
}
export type ProductPublicationUserCommand = ReturnType<typeof parseProductPublicationUserCommand>;
const stateForAction = {
  Validate: "Draft",
  SubmitReview: "InReview",
  Approve: "Approved",
  Reject: "Draft",
  Publish: "Published",
  SchedulePublish: "Scheduled",
  ReschedulePublish: "Scheduled",
  CancelScheduledPublish: "Draft",
} as const;
function receipt(value: unknown, command: ProductPublicationUserCommand) {
  const r = record(value, [
    "status",
    "operationReference",
    "productReference",
    "versionReference",
    "aggregateVersion",
    "publicationVersion",
    "state",
    "scheduleVersion",
    "effectiveFrom",
    "successorDraftVersionReference",
  ]);
  const result = Object.freeze({
    status: choice(r.status, ["Applied", "Replayed"] as const),
    operationReference: ref(r.operationReference),
    productReference: ref(r.productReference),
    versionReference: ref(r.versionReference),
    aggregateVersion: integer(r.aggregateVersion, 1),
    publicationVersion: integer(r.publicationVersion, 1),
    state: choice(r.state, ["Draft", "InReview", "Approved", "Scheduled", "Published"] as const),
    scheduleVersion: integer(r.scheduleVersion),
    effectiveFrom: instant(r.effectiveFrom),
    successorDraftVersionReference: nullableRef(r.successorDraftVersionReference),
  });
  if (
    result.operationReference !== command.operationReference ||
    result.productReference !== command.productReference ||
    result.versionReference !== command.versionReference ||
    result.aggregateVersion !== command.expectedProductAggregateVersion + 1 ||
    result.publicationVersion !== command.expectedPublicationVersion + 1 ||
    result.state !== stateForAction[command.action] ||
    result.effectiveFrom !== command.effectivePeriod.effectiveFrom.instant ||
    result.successorDraftVersionReference !== command.successorDraftVersionReference ||
    (command.scheduleReference !== null && result.scheduleVersion < 1)
  )
    return invalid();
  return result;
}
export type ProductPublicationCommandReceipt = ReturnType<typeof receipt>;
async function read(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumResponseBytes) return invalid();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
/** Wire transport only. No current source/policy/validation/approval authority.
 * Explicit same prepared request retry; native owning System activation stays server-only. */
export function createProductPublicationCommandClient(fetcher: typeof fetch = globalThis.fetch) {
  function prepared(value: unknown, scopeValue: unknown, recovered: boolean) {
    const command = parseProductPublicationUserCommand(value);
    let selected;
    try {
      const r = record(copyProductCommandValue(scopeValue), ["brandReference", "storeReference"]);
      selected = Object.freeze({
        brandReference: ref(r.brandReference),
        storeReference: ref(r.storeReference),
      });
    } catch {
      return invalid();
    }
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > maximumRequestBytes) return invalid();
    const scopeHeader = btoa(JSON.stringify(selected))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    let uncertain = recovered;
    const definitive = new WeakSet<object>();
    const unknown = (attemptCode?: ProductPublicationClientError["attemptCode"]): never => {
      uncertain = true;
      throw new ProductPublicationClientError("OutcomeUnknown", attemptCode);
    };
    return Object.freeze({
      command,
      scope: selected,
      async execute(csrf: string, signal?: AbortSignal): Promise<ProductPublicationCommandReceipt> {
        if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) {
          if (uncertain) return unknown("Invalid");
          return invalid();
        }
        if (signal?.aborted) {
          if (uncertain) return unknown();
          throw new ProductPublicationClientError("Unavailable");
        }
        const controller = new AbortController();
        let rejectAbort: ((error: unknown) => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        const abort = () => {
          controller.abort();
          rejectAbort?.(new ProductPublicationClientError("OutcomeUnknown"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 15000);
        try {
          const response = await Promise.race([
            fetcher("/merchant/catalog/products/publication", {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: controller.signal,
              body,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": csrf,
                "X-BOP-Catalog-Scope": scopeHeader,
              },
            }),
            aborted,
          ]);
          if (
            controller.signal.aborted ||
            response.headers.get("cache-control") !== "no-store" ||
            !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
          )
            return unknown();
          const raw = await Promise.race([read(response, controller.signal), aborted]);
          if (controller.signal.aborted) return unknown();
          if (response.status !== 200) {
            const code = record(raw, ["error"]).error;
            let failure: ProductPublicationClientError["attemptCode"];
            if ((response.status === 401 || response.status === 403) && code === "request_denied")
              failure = "Denied";
            else if (response.status === 400 && code === "product_publication_invalid")
              failure = "Invalid";
            else if (response.status === 409 && code === "product_publication_conflict")
              failure = "Conflict";
            else if (response.status === 409 && code === "product_publication_feature_disabled")
              failure = "FeatureDisabled";
            else return unknown();
            const error = new ProductPublicationClientError(failure);
            definitive.add(error);
            throw error;
          }
          const parsed = receipt(raw, command);
          uncertain = false;
          return parsed;
        } catch (error) {
          if (error instanceof ProductPublicationClientError && definitive.has(error)) {
            if (uncertain)
              return unknown(error.code as ProductPublicationClientError["attemptCode"]);
            throw error;
          }
          return unknown();
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          controller.abort();
        }
      },
    });
  }
  return Object.freeze({
    prepare(value: unknown, scopeValue: unknown) {
      return prepared(value, scopeValue, false);
    },
    /** Restored pending intent is conservatively uncertain, never source authority. */
    recover(value: unknown, scopeValue: unknown) {
      return prepared(value, scopeValue, true);
    },
  });
}
