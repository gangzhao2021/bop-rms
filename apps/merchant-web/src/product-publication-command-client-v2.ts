import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
} from "./catalog-product-command-values.js";
import {
  parseProductPublicationUserCommand,
  ProductPublicationClientError,
} from "./product-publication-command-client.js";
export { ProductPublicationClientError } from "./product-publication-command-client.js";
const invalid = (): never => {
  throw new ProductPublicationClientError("Invalid");
};
const maximumRequestBytes = 8192,
  maximumResponseBytes = 65536;
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
function integer(value: unknown, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2147483647)
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
export function canonicalPublicationValue(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalPublicationValue).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalPublicationValue((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function publicationValueDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalPublicationValue(value)),
  );
  return (
    "sha256:" + Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
/** Closed recorded intent. Its digest proves integrity, never authorization. */
export async function parseProductPublicationReplacementIntent(value: unknown) {
  const safe = copyProductCommandValue(value);
  const mode = record(
    safe,
    (safe as { mode?: unknown })?.mode === "None"
      ? ["profile", "mode", "digest"]
      : [
          "profile",
          "mode",
          "previousVersionReference",
          "previousPublicationOperationReference",
          "expectedPreviousPublicationVersion",
          "previousIntentDigest",
          "previousScopeDigest",
          "previousPeriodDigest",
          "previousSelectorIndex",
          "previousSelectorDigest",
          "digest",
        ],
  );
  const { digest, ...body } = mode;
  if (hash(digest) !== (await publicationValueDigest(body))) return invalid();
  if (mode.mode === "None") {
    if (mode.profile !== "CatalogProductNoReplacementIntentV1") return invalid();
    return Object.freeze({
      profile: "CatalogProductNoReplacementIntentV1" as const,
      mode: "None" as const,
      digest: hash(digest),
    });
  }
  if (
    mode.profile !== "CatalogProductExactStoreSelectorReplacementV1" ||
    mode.mode !== "PermanentSelectorRetirement"
  )
    return invalid();
  const index = integer(mode.previousSelectorIndex);
  if (index > 999) return invalid();
  return Object.freeze({
    profile: "CatalogProductExactStoreSelectorReplacementV1" as const,
    mode: "PermanentSelectorRetirement" as const,
    previousVersionReference: ref(mode.previousVersionReference),
    previousPublicationOperationReference: ref(mode.previousPublicationOperationReference),
    expectedPreviousPublicationVersion: integer(mode.expectedPreviousPublicationVersion, 1),
    previousIntentDigest: hash(mode.previousIntentDigest),
    previousScopeDigest: hash(mode.previousScopeDigest),
    previousPeriodDigest: hash(mode.previousPeriodDigest),
    previousSelectorIndex: index,
    previousSelectorDigest: hash(mode.previousSelectorDigest),
    digest: hash(digest),
  });
}
export type ProductPublicationReplacementIntent = Awaited<
  ReturnType<typeof parseProductPublicationReplacementIntent>
>;
const commandKeys = [
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
] as const;
export async function parseProductPublicationUserCommandV2(value: unknown) {
  try {
    const raw = record(copyProductCommandValue(value), [
      ...commandKeys,
      "profile",
      "replacementIntent",
      "replacementIntentDigest",
    ]);
    if (raw.profile !== "CatalogProductPublicationCommandV2") return invalid();
    // Explicit V2 entry: only the fixed common body reaches the unchanged V1 value parser.
    const body = parseProductPublicationUserCommand(
      Object.fromEntries(commandKeys.map((key) => [key, raw[key]])),
    );
    const replacementIntent = await parseProductPublicationReplacementIntent(raw.replacementIntent);
    if (raw.replacementIntentDigest !== replacementIntent.digest) return invalid();
    if (
      replacementIntent.mode === "PermanentSelectorRetirement" &&
      (body.versionReference === replacementIntent.previousVersionReference ||
        body.operationReference === replacementIntent.previousPublicationOperationReference ||
        body.successorDraftVersionReference === replacementIntent.previousVersionReference ||
        body.scopeSet.length !== 1 ||
        body.scopeSet[0]?.level !== "Store" ||
        (await publicationValueDigest(body.scopeSet[0])) !==
          replacementIntent.previousSelectorDigest)
    )
      return invalid();
    return Object.freeze({
      ...body,
      profile: "CatalogProductPublicationCommandV2" as const,
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
  } catch {
    return invalid();
  }
}
export type ProductPublicationUserCommandV2 = Awaited<
  ReturnType<typeof parseProductPublicationUserCommandV2>
>;
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
function receipt(value: unknown, command: ProductPublicationUserCommandV2) {
  const r = record(value, [
    "profile",
    "replacementIntentDigest",
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
  if (
    r.profile !== "CatalogProductPublicationCommandResultV2" ||
    r.replacementIntentDigest !== command.replacementIntentDigest
  )
    return invalid();
  const result = Object.freeze({
    profile: "CatalogProductPublicationCommandResultV2" as const,
    replacementIntentDigest: command.replacementIntentDigest,
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
export type ProductPublicationCommandReceiptV2 = ReturnType<typeof receipt>;
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
export function createProductPublicationCommandClientV2(fetcher: typeof fetch = globalThis.fetch) {
  async function prepared(value: unknown, scopeValue: unknown, recovered: boolean) {
    const scopeSnapshot = copyProductCommandValue(scopeValue);
    const command = await parseProductPublicationUserCommandV2(value);
    let selected;
    try {
      const r = record(scopeSnapshot, ["brandReference", "storeReference"]);
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
      async execute(
        csrf: string,
        signal?: AbortSignal,
      ): Promise<ProductPublicationCommandReceiptV2> {
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
            fetcher("/merchant/catalog/products/publication/v2", {
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
