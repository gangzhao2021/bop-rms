import {
  productCommandRecord as record,
  parseCatalogReference as reference,
} from "./catalog-product-command-values.js";
import { serviceOperationReference } from "./service-control-client.js";
import type { MerchantBrandScope } from "./merchant-brand-workspace.js";
export class BrandLifecycleClientError extends Error {
  constructor(
    readonly code:
      | "Invalid"
      | "Denied"
      | "Conflict"
      | "RequestConflict"
      | "Unavailable"
      | "OutcomeUnknown"
      | "ScopeChanged",
    readonly original?: BrandLifecycleOriginal,
  ) {
    super("Brand lifecycle outcome could not be confirmed");
    this.name = "BrandLifecycleClientError";
  }
}
const fail = (code: BrandLifecycleClientError["code"] = "Invalid"): never => {
  throw new BrandLifecycleClientError(code);
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    if (error instanceof BrandLifecycleClientError) throw error;
    return fail();
  }
};
export type BrandLifecycleAction = "ActivateBrand" | "ArchiveBrand";
export interface BrandLifecycleOriginal extends MerchantBrandScope {
  readonly profile: "BrandLifecycleOriginalV1";
  readonly purposeCode: "BRAND_ADMINISTRATION";
  readonly action: BrandLifecycleAction;
  readonly operationReference: string;
  readonly expectedBrandVersion: number;
}
export interface BrandLifecycleReceipt {
  readonly profile: "MerchantBrandLifecycleReceiptV1";
  readonly actorReference: string;
  readonly brandReference: string;
  readonly action: BrandLifecycleAction;
  readonly operationReference: string;
  readonly expectedBrandVersion: number;
  readonly status: "Applied" | "AlreadyApplied";
  readonly lifecycle: "Active" | "Archived";
  readonly version: number;
  readonly occurredAt: string;
}
export function parseBrandLifecycleScope(value: unknown): MerchantBrandScope {
  return safe(() => {
    const r = record(value, ["tenantReference", "brandReference", "actorReference"]),
      brand = reference(r.brandReference);
    if (r.tenantReference !== brand) return fail("ScopeChanged");
    return Object.freeze({
      tenantReference: brand,
      brandReference: brand,
      actorReference: reference(r.actorReference),
    });
  });
}
export function parseBrandLifecycleOriginal(value: unknown): BrandLifecycleOriginal {
  return safe(() => {
    const r = record(value, [
        "profile",
        "tenantReference",
        "brandReference",
        "actorReference",
        "purposeCode",
        "action",
        "operationReference",
        "expectedBrandVersion",
      ]),
      scope = parseBrandLifecycleScope({
        tenantReference: r.tenantReference,
        brandReference: r.brandReference,
        actorReference: r.actorReference,
      });
    if (
      r.profile !== "BrandLifecycleOriginalV1" ||
      r.purposeCode !== "BRAND_ADMINISTRATION" ||
      (r.action !== "ActivateBrand" && r.action !== "ArchiveBrand") ||
      !Number.isInteger(r.expectedBrandVersion) ||
      Number(r.expectedBrandVersion) < 1 ||
      Number(r.expectedBrandVersion) > 2147483646
    )
      return fail();
    return Object.freeze({
      profile: "BrandLifecycleOriginalV1",
      ...scope,
      purposeCode: "BRAND_ADMINISTRATION",
      action: r.action,
      operationReference: reference(r.operationReference),
      expectedBrandVersion: Number(r.expectedBrandVersion),
    });
  });
}
export function parseBrandLifecycleReceipt(
  value: unknown,
  originalInput: BrandLifecycleOriginal,
  now = Date.now(),
): BrandLifecycleReceipt {
  return safe(() => {
    const original = parseBrandLifecycleOriginal(originalInput),
      r = record(value, [
        "profile",
        "actorReference",
        "brandReference",
        "action",
        "operationReference",
        "expectedBrandVersion",
        "status",
        "lifecycle",
        "version",
        "occurredAt",
      ]);
    if (
      r.profile !== "MerchantBrandLifecycleReceiptV1" ||
      r.actorReference !== original.actorReference ||
      r.brandReference !== original.brandReference ||
      r.action !== original.action ||
      r.operationReference !== original.operationReference ||
      r.expectedBrandVersion !== original.expectedBrandVersion ||
      (r.status !== "Applied" && r.status !== "AlreadyApplied") ||
      r.lifecycle !== (original.action === "ActivateBrand" ? "Active" : "Archived") ||
      r.version !== original.expectedBrandVersion + 1
    )
      return fail();
    if (
      typeof r.occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(r.occurredAt) ||
      r.occurredAt.startsWith("0000") ||
      !Number.isFinite(Date.parse(r.occurredAt)) ||
      new Date(r.occurredAt).toISOString() !== r.occurredAt ||
      !Number.isFinite(now) ||
      Date.parse(r.occurredAt) > now
    )
      return fail();
    return Object.freeze({
      profile: "MerchantBrandLifecycleReceiptV1",
      actorReference: original.actorReference,
      brandReference: original.brandReference,
      action: original.action,
      operationReference: original.operationReference,
      expectedBrandVersion: original.expectedBrandVersion,
      status: r.status,
      lifecycle: r.lifecycle as "Active" | "Archived",
      version: Number(r.version),
      occurredAt: r.occurredAt,
    });
  });
}
export function createMerchantBrandLifecycleClient(request: typeof fetch = globalThis.fetch) {
  let epoch = 0;
  const controllers = new Set<AbortController>();
  return Object.freeze({
    prepare(
      scope: MerchantBrandScope,
      action: BrandLifecycleAction,
      expectedBrandVersion: number,
      operationReference = serviceOperationReference(),
    ) {
      return parseBrandLifecycleOriginal({
        profile: "BrandLifecycleOriginalV1",
        ...parseBrandLifecycleScope(scope),
        purposeCode: "BRAND_ADMINISTRATION",
        action,
        operationReference,
        expectedBrandVersion,
      });
    },
    async execute(
      value: BrandLifecycleOriginal,
      scope: MerchantBrandScope,
      controls: { csrf: string; signal?: AbortSignal },
    ): Promise<BrandLifecycleReceipt> {
      const original = parseBrandLifecycleOriginal(value),
        selected = parseBrandLifecycleScope(scope),
        generation = epoch,
        c = new AbortController(),
        signal = controls.signal;
      if (
        original.actorReference !== selected.actorReference ||
        original.brandReference !== selected.brandReference
      )
        return fail("ScopeChanged");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(controls.csrf)) return fail();
      const check = () => {
        if (epoch !== generation || signal?.aborted) return fail("ScopeChanged");
      };
      check();
      const abort = () => c.abort();
      signal?.addEventListener("abort", abort, { once: true });
      controllers.add(c);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            const response = await request("/merchant/organization/brands/lifecycle", {
              method: "POST",
              credentials: "same-origin",
              mode: "same-origin",
              redirect: "error",
              cache: "no-store",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": controls.csrf,
              },
              body: JSON.stringify({
                brandReference: original.brandReference,
                action: original.action,
                expectedBrandVersion: original.expectedBrandVersion,
                operationReference: original.operationReference,
              }),
              signal: c.signal,
            });
            check();
            if (response.status === 401 || response.status === 403) return fail("Denied");
            if (response.status === 400) return fail("Invalid");
            const requestConflict = response.status === 409;
            if (!response.ok && !requestConflict) return fail("Unavailable");
            if (
              response.headers.get("cache-control") !== "no-store" ||
              !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
                response.headers.get("content-type") ?? "",
              ) ||
              !response.body
            )
              return fail("OutcomeUnknown");
            const reader = response.body.getReader(),
              decoder = new TextDecoder("utf-8", { fatal: true });
            let bytes = 0,
              body = "";
            const cancel = () => {
              void reader.cancel().catch(() => undefined);
            };
            c.signal.addEventListener("abort", cancel, { once: true });
            try {
              for (;;) {
                check();
                if (c.signal.aborted) return fail("OutcomeUnknown");
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 16384) return fail("OutcomeUnknown");
                body += decoder.decode(part.value, { stream: true });
              }
              body += decoder.decode();
            } finally {
              cancel();
              reader.releaseLock();
              c.signal.removeEventListener("abort", cancel);
            }
            check();
            if (requestConflict) {
              let error: Record<string, unknown>;
              try {
                error = record(JSON.parse(body), ["error"]);
              } catch {
                return fail("OutcomeUnknown");
              }
              if (error.error !== "brand_lifecycle_conflict") return fail("Unavailable");
              throw new BrandLifecycleClientError("RequestConflict", original);
            }
            try {
              return parseBrandLifecycleReceipt(JSON.parse(body), original);
            } catch {
              return fail("OutcomeUnknown");
            }
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              c.abort();
              reject(new BrandLifecycleClientError("OutcomeUnknown"));
            }, 15000);
          }),
        ]);
        check();
        return result;
      } catch (error) {
        check();
        if (error instanceof BrandLifecycleClientError) throw error;
        return fail("OutcomeUnknown");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controllers.delete(c);
      }
    },
    invalidate() {
      epoch++;
      for (const c of controllers) c.abort();
      controllers.clear();
    },
  });
}
export type MerchantBrandLifecycleClient = ReturnType<typeof createMerchantBrandLifecycleClient>;
