import {
  productCommandRecord as record,
  copyProductCommandValue,
  parseCatalogReference,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";

export const storeCapabilityChoices = Object.freeze(
  [
    {
      key: "catalog.cat_product_create",
      control: "catalog.product.create",
      label: "Create products",
    },
    {
      key: "catalog.cat_product_detail",
      control: "catalog.product.detail",
      label: "View product details",
    },
    {
      key: "catalog.cat_product_edit",
      control: "catalog.product.edit",
      label: "Edit and publish products",
    },
    {
      key: "organization.store_capability",
      control: "organization.store.capability",
      label: "Manage Store capabilities",
    },
  ].map((choice) => Object.freeze(choice)),
);
export interface StoreCapabilityScope {
  readonly brandReference?: string;
  readonly storeReference: string;
}
export interface StoreCapabilityObservation extends StoreCapabilityScope {
  readonly brandReference: string;
  readonly capabilityKey: string;
  readonly controlKey: string;
  readonly backendExecution: "Allow" | "Deny";
  readonly frontendVisibility: "Show" | "Hide";
  readonly reason: "Enabled" | "Disabled" | "Unavailable";
  readonly source: "BrandOverride" | "StoreOverride" | null;
  readonly controlReference: string | null;
  readonly controlVersion: number | null;
  readonly observedAt: string;
}
export class StoreCapabilityClientError extends Error {
  constructor(readonly code: "Denied" | "Unavailable" | "Stale" | "ScopeChanged") {
    super("Store capability could not be loaded");
    this.name = "StoreCapabilityClientError";
  }
}
const fail = (code: StoreCapabilityClientError["code"] = "Unavailable"): never => {
  throw new StoreCapabilityClientError(code);
};
function scope(value: unknown): StoreCapabilityScope {
  const r = record(copyProductCommandValue(value), ["storeReference"], ["brandReference"]);
  return Object.freeze({
    ...(Object.hasOwn(r, "brandReference")
      ? { brandReference: parseCatalogReference(r.brandReference) }
      : {}),
    storeReference: parseCatalogReference(r.storeReference),
  });
}
export function parseStoreCapabilityObservation(
  value: unknown,
  expected: StoreCapabilityScope,
  key: string,
  now: number,
): StoreCapabilityObservation {
  try {
    const s = scope(expected),
      choice = storeCapabilityChoices.find((row) => row.key === key);
    if (!choice || !Number.isFinite(now)) return fail();
    const r = record(copyProductCommandValue(value), [
      "capabilityKey",
      "controlKey",
      "brandReference",
      "storeReference",
      "backendExecution",
      "frontendVisibility",
      "reason",
      "source",
      "controlReference",
      "controlVersion",
      "observedAt",
    ]);
    const brandReference = parseCatalogReference(r.brandReference);
    if (
      (s.brandReference !== undefined && brandReference !== s.brandReference) ||
      r.storeReference !== s.storeReference
    )
      return fail("ScopeChanged");
    if (
      r.capabilityKey !== key ||
      r.controlKey !== choice.control ||
      !["Enabled", "Disabled", "Unavailable"].includes(String(r.reason))
    )
      return fail();
    const enabled = r.reason === "Enabled";
    if (
      r.backendExecution !== (enabled ? "Allow" : "Deny") ||
      r.frontendVisibility !== (enabled ? "Show" : "Hide") ||
      ![null, "StoreOverride", "BrandOverride"].includes(r.source as null | string)
    )
      return fail();
    const controlReference =
      r.controlReference === null ? null : parseCatalogReference(r.controlReference);
    if (
      (controlReference === null) !== (r.controlVersion === null) ||
      (controlReference === null) !== (r.source === null) ||
      (r.reason !== "Unavailable" && controlReference === null) ||
      (r.controlVersion !== null &&
        (!Number.isSafeInteger(r.controlVersion) || (r.controlVersion as number) < 1))
    )
      return fail();
    const observedAt = parseCatalogInstant(r.observedAt);
    if (Date.parse(observedAt) > now || now - Date.parse(observedAt) > 5000) return fail("Stale");
    return Object.freeze({
      ...s,
      brandReference,
      capabilityKey: key,
      controlKey: choice.control,
      backendExecution: enabled ? "Allow" : "Deny",
      frontendVisibility: enabled ? "Show" : "Hide",
      reason: r.reason as StoreCapabilityObservation["reason"],
      source: r.source as StoreCapabilityObservation["source"],
      controlReference,
      controlVersion: r.controlVersion as number | null,
      observedAt,
    });
  } catch (error) {
    if (error instanceof StoreCapabilityClientError) throw error;
    return fail();
  }
}
/** Private in-memory observation: bounded, no cache/storage/query-string identities.
 * A frontend observation never grants permission to a later backend command. */
export function createStoreCapabilityClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async load(
      input: { scope: StoreCapabilityScope; capabilityKey: string; csrf: string },
      signal: AbortSignal,
    ): Promise<StoreCapabilityObservation> {
      const expected = scope(input.scope),
        key = input.capabilityKey;
      if (
        !storeCapabilityChoices.some((row) => row.key === key) ||
        typeof input.csrf !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/u.test(input.csrf)
      )
        return fail();
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(abort, 15000);
      const guard = <T>(promise: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const interrupted = () =>
            reject(
              signal.aborted
                ? new DOMException("Capability read cancelled", "AbortError")
                : new StoreCapabilityClientError("Unavailable"),
            );
          if (controller.signal.aborted) {
            void promise.catch(() => undefined);
            interrupted();
            return;
          }
          controller.signal.addEventListener("abort", interrupted, { once: true });
          promise
            .then(resolve, reject)
            .finally(() => controller.signal.removeEventListener("abort", interrupted))
            .catch(() => undefined);
        });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        finished = false;
      try {
        const response = await guard(
          fetcher("/merchant/store-capability", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "x-bop-csrf": input.csrf,
            },
            body: JSON.stringify({ capabilityKey: key }),
          }),
        );
        if (
          response.redirected ||
          response.headers.get("cache-control") !== "no-store" ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !response.body
        )
          return fail();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > 8192))
          return fail();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0,
          body = "";
        while (true) {
          const chunk = await guard(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8192) return fail();
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        finished = true;
        if (length !== null && Number(length) !== bytes) return fail();
        const value: unknown = JSON.parse(body);
        if (!response.ok) {
          const r = record(value, ["error"]);
          if ((response.status === 401 || response.status === 403) && r.error === "request_denied")
            return fail("Denied");
          return fail();
        }
        if (response.status !== 200 || controller.signal.aborted) return fail();
        return parseStoreCapabilityObservation(value, expected, key, now());
      } catch (error) {
        if (signal.aborted) throw new DOMException("Capability read cancelled", "AbortError");
        if (error instanceof StoreCapabilityClientError) throw error;
        return fail();
      } finally {
        if (reader) {
          if (!finished) void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        controller.abort();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  });
}
export type StoreCapabilityClient = ReturnType<typeof createStoreCapabilityClient>;
