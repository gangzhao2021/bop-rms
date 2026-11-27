import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogInstant as instant,
  parseCatalogCode,
} from "./catalog-product-command-values.js";
import { ProductPublicationClientError } from "./product-publication-command-client.js";
import { productPublicationValidationCheckCodes } from "./product-publication-validation-report-client-v2.js";
export { ProductPublicationClientError } from "./product-publication-command-client.js";
const maximumRequestBytes = 8192,
  maximumResponseBytes = 65536;
const invalid = (): never => {
  throw new ProductPublicationClientError("Invalid");
};
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    return invalid();
  return value as number;
}
function hash(value: unknown) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : invalid();
}
function codes(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return invalid();
  const result = value.map((code: unknown) => {
    if (
      typeof code !== "string" ||
      code === "HardErrorsCleared" ||
      !productPublicationValidationCheckCodes.includes(
        code as (typeof productPublicationValidationCheckCodes)[number],
      )
    )
      return invalid();
    return code as (typeof productPublicationValidationCheckCodes)[number];
  });
  if (new Set(result).size !== result.length) return invalid();
  return Object.freeze(result.sort());
}
/** Exact browser intent only. Actor, tenant, brand and purpose are server-derived. */
export function parseProductPublicationWarningAcknowledgementCommand(value: unknown) {
  try {
    const r = record(copyProductCommandValue(value), [
      "profile",
      "action",
      "operationReference",
      "productReference",
      "versionReference",
      "expectedProductAggregateVersion",
      "reportOperationReference",
      "reportDigest",
      "warningBindingDigest",
      "warningCodes",
      "reasonCode",
      "occurredAt",
    ]);
    if (
      r.profile !== "CatalogProductPublicationWarningAcknowledgementCommandV1" ||
      r.action !== "AcknowledgeProductPublicationWarnings"
    )
      return invalid();
    const reasonCode = parseCatalogCode(r.reasonCode);
    if (reasonCode !== r.reasonCode) return invalid();
    const command = Object.freeze({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1" as const,
      action: "AcknowledgeProductPublicationWarnings" as const,
      operationReference: ref(r.operationReference),
      productReference: ref(r.productReference),
      versionReference: ref(r.versionReference),
      expectedProductAggregateVersion: integer(r.expectedProductAggregateVersion),
      reportOperationReference: ref(r.reportOperationReference),
      reportDigest: hash(r.reportDigest),
      warningBindingDigest: hash(r.warningBindingDigest),
      warningCodes: codes(r.warningCodes),
      reasonCode,
      occurredAt: instant(r.occurredAt),
    });
    if (new TextEncoder().encode(JSON.stringify(command)).byteLength > maximumRequestBytes)
      return invalid();
    return command;
  } catch {
    return invalid();
  }
}
export type ProductPublicationWarningAcknowledgementCommand = ReturnType<
  typeof parseProductPublicationWarningAcknowledgementCommand
>;
function receipt(value: unknown, command: ProductPublicationWarningAcknowledgementCommand) {
  const r = record(copyProductCommandValue(value), [
    "profile",
    "status",
    "operationReference",
    "productReference",
    "versionReference",
    "aggregateVersion",
    "reportOperationReference",
    "reportDigest",
    "warningBindingDigest",
    "warningCodes",
    "reasonCode",
    "occurredAt",
    "recordedAt",
    "receiptDigest",
  ]);
  if (
    r.profile !== "CatalogProductPublicationWarningAcknowledgementResultV1" ||
    (r.status !== "Applied" && r.status !== "Replayed")
  )
    return invalid();
  const result = Object.freeze({
    profile: "CatalogProductPublicationWarningAcknowledgementResultV1" as const,
    status: r.status,
    operationReference: ref(r.operationReference),
    productReference: ref(r.productReference),
    versionReference: ref(r.versionReference),
    aggregateVersion: integer(r.aggregateVersion),
    reportOperationReference: ref(r.reportOperationReference),
    reportDigest: hash(r.reportDigest),
    warningBindingDigest: hash(r.warningBindingDigest),
    warningCodes: codes(r.warningCodes),
    reasonCode: parseCatalogCode(r.reasonCode),
    occurredAt: instant(r.occurredAt),
    recordedAt: instant(r.recordedAt),
    receiptDigest: hash(r.receiptDigest),
  });
  for (const key of [
    "operationReference",
    "productReference",
    "versionReference",
    "reportOperationReference",
    "reportDigest",
    "warningBindingDigest",
    "reasonCode",
    "occurredAt",
  ] as const)
    if (result[key] !== command[key] || r[key] !== result[key]) return invalid();
  if (
    result.aggregateVersion !== command.expectedProductAggregateVersion ||
    result.recordedAt < command.occurredAt ||
    JSON.stringify(result.warningCodes) !== JSON.stringify(command.warningCodes) ||
    JSON.stringify(r.warningCodes) !== JSON.stringify(result.warningCodes)
  )
    return invalid();
  return result;
}
export type ProductPublicationWarningAcknowledgementResult = ReturnType<typeof receipt>;
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
/** Independent confirmation transport; owning permission, report and current facts stay server-side.
 * Recovery preserves the exact original body even after later denial or a lost response. */
export function createProductPublicationWarningAcknowledgementClient(
  fetcher: typeof fetch = globalThis.fetch,
) {
  async function prepared(value: unknown, scopeValue: unknown, recovered: boolean) {
    const scopeSnapshot = copyProductCommandValue(scopeValue);
    const command = await parseProductPublicationWarningAcknowledgementCommand(value);
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
      ): Promise<ProductPublicationWarningAcknowledgementResult> {
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
            fetcher("/merchant/catalog/products/publication/warning-acknowledgements/v1", {
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
            else if (
              response.status === 400 &&
              code === "product_publication_warning_acknowledgement_invalid"
            )
              failure = "Invalid";
            else if (
              response.status === 409 &&
              code === "product_publication_warning_acknowledgement_conflict"
            )
              failure = "Conflict";
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
