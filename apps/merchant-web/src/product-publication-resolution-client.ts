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
import {
  parseProductPublicationUserCommandV2,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
import { parseProductPublicationWarningAcknowledgementCommand } from "./product-publication-warning-acknowledgement-client.js";

export type ProductPublicationOriginalKind =
  "PublicationV1" | "PublicationV2" | "WarningAcknowledgementV1";
const fail = (): never => {
  throw new ProductPublicationClientError("Invalid");
};
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/u.test(v) ? v : fail();
function scope(value: unknown) {
  const r = record(copyProductCommandValue(value), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "productReference",
  ]);
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
    productReference: ref(r.productReference),
  });
}
async function original(kind: ProductPublicationOriginalKind, value: unknown) {
  if (kind === "PublicationV1") return parseProductPublicationUserCommand(value);
  if (kind === "PublicationV2") return parseProductPublicationUserCommandV2(value);
  if (kind === "WarningAcknowledgementV1")
    return parseProductPublicationWarningAcknowledgementCommand(value);
  return fail();
}
function result(value: unknown) {
  const r = record(copyProductCommandValue(value), [
    "profile",
    "outcome",
    "originalKind",
    "tenantReference",
    "brandReference",
    "storeReference",
    "productReference",
    "versionReference",
    "operationReference",
    "originalCommandDigest",
    "originalIntentDigest",
    "recordedAt",
    "resolutionDigest",
    "currentAggregateVersion",
  ]);
  if (
    r.profile !== "CatalogProductPublicationResolutionResultV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    !["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"].includes(
      String(r.originalKind),
    ) ||
    !Number.isSafeInteger(r.currentAggregateVersion) ||
    Number(r.currentAggregateVersion) < 1 ||
    Number(r.currentAggregateVersion) > 2147483647
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductPublicationResolutionResultV1" as const,
    outcome: r.outcome,
    originalKind: r.originalKind as ProductPublicationOriginalKind,
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    storeReference: ref(r.storeReference),
    productReference: ref(r.productReference),
    versionReference: ref(r.versionReference),
    operationReference: ref(r.operationReference),
    originalCommandDigest: hash(r.originalCommandDigest),
    originalIntentDigest: hash(r.originalIntentDigest),
    recordedAt: instant(r.recordedAt),
    resolutionDigest: hash(r.resolutionDigest),
    currentAggregateVersion: r.currentAggregateVersion as number,
  });
}
export type ProductPublicationResolutionResult = ReturnType<typeof result>;
async function read(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return fail();
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
      if (total > 16384) return fail();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
/** Resolve or permanently stop an original request on the server. A transport
 * failure, status code or locally computed digest never establishes its outcome. */
export function createProductPublicationResolutionClient(fetcher: typeof fetch = globalThis.fetch) {
  return Object.freeze({
    async resolve(
      input: {
        readonly originalKind: ProductPublicationOriginalKind;
        readonly originalCommand: unknown;
        readonly scope: unknown;
        readonly csrf: string;
      },
      signal?: AbortSignal,
    ): Promise<ProductPublicationResolutionResult> {
      const selected = scope(input.scope),
        kind = input.originalKind,
        csrf = input.csrf,
        snapshot = copyProductCommandValue(input.originalCommand),
        command = await original(kind, snapshot);
      if (
        command.productReference !== selected.productReference ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf)
      )
        return fail();
      const originalCommandDigest = await publicationValueDigest(command),
        body = JSON.stringify({
          profile: "CatalogProductPublicationResolutionCommandV1",
          originalKind: kind,
          originalCommand: command,
        });
      if (new TextEncoder().encode(body).byteLength > 16384) return fail();
      const scopeHeader = btoa(
        JSON.stringify({
          brandReference: selected.brandReference,
          storeReference: selected.storeReference,
        }),
      )
        .replace(/\+/gu, "-")
        .replace(/\//gu, "_")
        .replace(/=+$/u, "");
      const controller = new AbortController();
      let rejectAbort: ((error: unknown) => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const abort = () => {
        controller.abort();
        rejectAbort?.(new ProductPublicationClientError("OutcomeUnknown"));
      };
      if (signal?.aborted) throw new ProductPublicationClientError("OutcomeUnknown");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await Promise.race([
          fetcher("/merchant/catalog/products/publication/resolve/v1", {
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
          return fail();
        const raw = await Promise.race([read(response, controller.signal), aborted]);
        if (controller.signal.aborted || response.status !== 200) return fail();
        const parsed = result(raw);
        for (const key of [
          "tenantReference",
          "brandReference",
          "storeReference",
          "productReference",
        ] as const)
          if (parsed[key] !== selected[key]) return fail();
        if (
          parsed.originalKind !== kind ||
          parsed.operationReference !== command.operationReference ||
          parsed.versionReference !== command.versionReference ||
          parsed.originalCommandDigest !== originalCommandDigest
        )
          return fail();
        return parsed;
      } catch {
        throw new ProductPublicationClientError("OutcomeUnknown");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
}
