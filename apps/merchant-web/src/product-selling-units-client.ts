import {
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogCode,
  parseCatalogLocale,
  parseLocalizedNames,
  parseCatalogInstant,
} from "./catalog-product-command-values.js";
export interface ProductSellingUnit {
  readonly unitReference: string;
  readonly code: string;
  readonly semanticDefinition: string;
  readonly quantityDecimalPlaces: number;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly lifecycle: "Active" | "Inactive" | "Retired";
}
export interface ProductSellingUnitsView {
  readonly profile: "CatalogProductSellingUnitRegistryViewV1";
  readonly brandReference: string;
  readonly storeReference: string;
  readonly presence: "Absent" | "Present";
  readonly registryVersion: number;
  readonly defaultLocale: string | null;
  readonly units: readonly ProductSellingUnit[];
  readonly assignedHistory: readonly {
    readonly unitCode: string;
    readonly currentSkuCount: number;
    readonly historicalAssignmentCount: number;
    readonly quantities: readonly string[];
  }[];
  readonly historyDigest: string;
  readonly definitionsDigest: string | null;
  readonly inspectionDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface ProductSellingUnitsRegistration {
  readonly action: "Create" | "ReplaceDraft";
  readonly operationReference: string;
  readonly expectedRegistryVersion: number;
  readonly defaultLocale: string;
  readonly units: readonly (Omit<ProductSellingUnit, "unitReference"> & {
    readonly unitReference: string | null;
  })[];
  readonly bootstrapConfirmation?: {
    readonly historyDigest: string;
    readonly confirmations: readonly {
      readonly unitCode: string;
      readonly semanticDefinition: string;
      readonly confirmed: true;
    }[];
  };
}
export class ProductSellingUnitsError extends Error {
  constructor(
    readonly code:
      "Invalid" | "Denied" | "Disabled" | "Conflict" | "Unavailable" | "Stale" | "OutcomeUnknown",
  ) {
    super("Selling unit request could not be confirmed");
  }
}
const fail = (code: ProductSellingUnitsError["code"] = "Invalid"): never => {
  throw new ProductSellingUnitsError(code);
};
const integer = (value: unknown, maximum = 2147483647) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return fail();
  return value as number;
};
const hash = (value: unknown): string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail();
function unit(value: unknown, locale: string, nullable = false) {
  const r = record(value, [
    "unitReference",
    "code",
    "semanticDefinition",
    "quantityDecimalPlaces",
    "localizedNames",
    "lifecycle",
  ]);
  if (
    typeof r.semanticDefinition !== "string" ||
    !r.semanticDefinition ||
    r.semanticDefinition.length > 240 ||
    r.semanticDefinition.trim() !== r.semanticDefinition ||
    /[<>]|\s{2}/u.test(r.semanticDefinition) ||
    [...r.semanticDefinition].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    !["Active", "Inactive", "Retired"].includes(String(r.lifecycle))
  )
    return fail();
  return Object.freeze({
    unitReference: nullable && r.unitReference === null ? null : ref(r.unitReference),
    code: parseCatalogCode(r.code),
    semanticDefinition: r.semanticDefinition,
    quantityDecimalPlaces: integer(r.quantityDecimalPlaces, 6),
    localizedNames: parseLocalizedNames(r.localizedNames, locale),
    lifecycle: r.lifecycle as ProductSellingUnit["lifecycle"],
  });
}
export function sellingUnitQuantityValid(quantity: string, precision: number) {
  if (
    !Number.isSafeInteger(precision) ||
    precision < 0 ||
    precision > 6 ||
    !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/u.test(quantity) ||
    !/[1-9]/u.test(quantity)
  )
    return false;
  return (quantity.split(".")[1]?.length ?? 0) <= precision;
}
export function createProductSellingUnitsClient(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const transport = fetcher,
    currentTime = now;
  async function post(
    mode: "inspect" | "register",
    body: unknown,
    scope: { readonly brandReference: string; readonly storeReference: string },
    csrf: string,
    signal?: AbortSignal,
  ) {
    const selected = Object.freeze({
      brandReference: ref(scope.brandReference),
      storeReference: ref(scope.storeReference),
    });
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) return fail();
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const interrupted = () => rejectAbort?.(new ProductSellingUnitsError("Unavailable"));
    controller.signal.addEventListener("abort", interrupted, { once: true });
    const timer = setTimeout(abort, 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (controller.signal.aborted) return fail("Unavailable");
      const response = await Promise.race([
        transport(`/merchant/catalog/products/selling-units/${mode}`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-bop-csrf": csrf,
            "x-bop-catalog-scope": btoa(JSON.stringify(selected))
              .replace(/\+/gu, "-")
              .replace(/\//gu, "_")
              .replace(/=+$/u, ""),
          },
          body: JSON.stringify(body),
        }),
        aborted,
      ]);
      if (response.status === 403 || response.status === 401) return fail("Denied");
      if (response.status === 400) return fail("Invalid");
      if (
        (!response.ok && response.status !== 409) ||
        response.redirected ||
        !response.headers.get("content-type")?.startsWith("application/json") ||
        !response.headers.get("cache-control")?.includes("no-store") ||
        !response.body
      )
        return fail("Unavailable");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) break;
        length += next.value.byteLength;
        if (length > (response.status === 409 ? 1024 : 1048576)) return fail("Unavailable");
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (response.status === 409) {
        const error = record(result, ["error"]);
        return fail(
          typeof error.error === "string" && error.error.includes("feature_disabled")
            ? "Disabled"
            : "Conflict",
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", interrupted);
      if (reader) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  return Object.freeze({
    async inspect(
      action: "Create" | "ReplaceDraft",
      scope: { readonly brandReference: string; readonly storeReference: string },
      csrf: string,
      signal?: AbortSignal,
    ): Promise<ProductSellingUnitsView> {
      try {
        if (action !== "Create" && action !== "ReplaceDraft") return fail();
        const selected = Object.freeze({
          brandReference: ref(scope.brandReference),
          storeReference: ref(scope.storeReference),
        });
        const r = record(
          copyProductCommandValue(await post("inspect", { action }, selected, csrf, signal)),
          [
            "profile",
            "brandReference",
            "storeReference",
            "presence",
            "registryVersion",
            "defaultLocale",
            "units",
            "assignedHistory",
            "historyDigest",
            "definitionsDigest",
            "inspectionDigest",
            "observedAt",
            "validUntil",
          ],
        );
        const registryVersion = integer(r.registryVersion),
          observedAt = parseCatalogInstant(r.observedAt),
          validUntil = parseCatalogInstant(r.validUntil);
        if (
          r.profile !== "CatalogProductSellingUnitRegistryViewV1" ||
          r.brandReference !== selected.brandReference ||
          r.storeReference !== selected.storeReference ||
          !["Absent", "Present"].includes(String(r.presence)) ||
          (r.presence === "Absent") !== (registryVersion === 0) ||
          !Array.isArray(r.units) ||
          r.units.length > 1000 ||
          !Array.isArray(r.assignedHistory) ||
          r.assignedHistory.length > 1000 ||
          Date.parse(validUntil) - Date.parse(observedAt) !== 5000
        )
          return fail("Unavailable");
        const locale = r.defaultLocale === null ? null : parseCatalogLocale(r.defaultLocale);
        if (
          r.presence === "Absent"
            ? locale !== null || r.units.length !== 0 || r.definitionsDigest !== null
            : locale === null || r.definitionsDigest === null
        )
          return fail("Unavailable");
        const units = r.units.map((value) => unit(value, locale ?? "")) as ProductSellingUnit[];
        if (
          new Set(units.map((value) => value.code)).size !== units.length ||
          new Set(units.map((value) => value.unitReference)).size !== units.length
        )
          return fail("Unavailable");
        const assignedHistory = r.assignedHistory.map((value) => {
          const h = record(value, [
            "unitCode",
            "currentSkuCount",
            "historicalAssignmentCount",
            "quantities",
          ]);
          if (
            !Array.isArray(h.quantities) ||
            h.quantities.length > 1000 ||
            h.quantities.some((q) => typeof q !== "string" || !sellingUnitQuantityValid(q, 6))
          )
            return fail("Unavailable");
          return Object.freeze({
            unitCode: parseCatalogCode(h.unitCode),
            currentSkuCount: integer(h.currentSkuCount),
            historicalAssignmentCount: integer(h.historicalAssignmentCount),
            quantities: Object.freeze(h.quantities as string[]),
          });
        });
        if (currentTime() < Date.parse(observedAt) || currentTime() >= Date.parse(validUntil))
          return fail("Stale");
        return Object.freeze({
          profile: "CatalogProductSellingUnitRegistryViewV1",
          brandReference: ref(r.brandReference),
          storeReference: ref(r.storeReference),
          presence: r.presence as "Absent" | "Present",
          registryVersion,
          defaultLocale: locale,
          units: Object.freeze(units),
          assignedHistory: Object.freeze(assignedHistory),
          historyDigest: hash(r.historyDigest),
          definitionsDigest: r.definitionsDigest === null ? null : hash(r.definitionsDigest),
          inspectionDigest: hash(r.inspectionDigest),
          observedAt,
          validUntil,
        });
      } catch (error) {
        if (error instanceof ProductSellingUnitsError) throw error;
        return fail("Unavailable");
      }
    },
    prepare(
      value: ProductSellingUnitsRegistration,
      scopeValue: { readonly brandReference: string; readonly storeReference: string },
    ) {
      let body: ProductSellingUnitsRegistration;
      try {
        const copied = copyProductCommandValue(value),
          withConfirmation = Object.hasOwn(copied as object, "bootstrapConfirmation"),
          r = record(copied, [
            "action",
            "operationReference",
            "expectedRegistryVersion",
            "defaultLocale",
            "units",
            ...(withConfirmation ? ["bootstrapConfirmation"] : []),
          ]);
        if (
          (r.action !== "Create" && r.action !== "ReplaceDraft") ||
          !Array.isArray(r.units) ||
          r.units.length < 1 ||
          r.units.length > 1000
        )
          return fail();
        const defaultLocale = parseCatalogLocale(r.defaultLocale),
          units = Object.freeze(r.units.map((value) => unit(value, defaultLocale, true)));
        if (new Set(units.map((value) => value.code)).size !== units.length) return fail();
        let confirmation: ProductSellingUnitsRegistration["bootstrapConfirmation"];
        if (withConfirmation) {
          const c = record(r.bootstrapConfirmation, ["historyDigest", "confirmations"]);
          if (
            !Array.isArray(c.confirmations) ||
            c.confirmations.length < 1 ||
            c.confirmations.length > 1000
          )
            return fail();
          confirmation = Object.freeze({
            historyDigest: hash(c.historyDigest),
            confirmations: Object.freeze(
              c.confirmations.map((value) => {
                const row = record(value, ["unitCode", "semanticDefinition", "confirmed"]),
                  match = units.find((unit) => unit.code === row.unitCode);
                if (
                  !match ||
                  row.confirmed !== true ||
                  row.semanticDefinition !== match.semanticDefinition
                )
                  return fail();
                return Object.freeze({
                  unitCode: match.code,
                  semanticDefinition: match.semanticDefinition,
                  confirmed: true as const,
                });
              }),
            ),
          });
        }
        body = Object.freeze({
          action: r.action,
          operationReference: ref(r.operationReference),
          expectedRegistryVersion: integer(r.expectedRegistryVersion, 2147483646),
          defaultLocale,
          units,
          ...(confirmation ? { bootstrapConfirmation: confirmation } : {}),
        });
      } catch (error) {
        if (error instanceof ProductSellingUnitsError) throw error;
        return fail();
      }
      const scope = Object.freeze({
        brandReference: ref(scopeValue.brandReference),
        storeReference: ref(scopeValue.storeReference),
      });
      let unknown = false;
      return Object.freeze({
        command: body,
        scope,
        async execute(csrf: string, signal?: AbortSignal) {
          try {
            const r = record(
              copyProductCommandValue(await post("register", body, scope, csrf, signal)),
              ["profile", "status", "operationReference", "registryVersion", "snapshotDigest"],
            );
            if (
              r.profile !== "CatalogProductSellingUnitRegistryResultV1" ||
              !["Applied", "Replayed"].includes(String(r.status)) ||
              r.operationReference !== body.operationReference ||
              r.registryVersion !== body.expectedRegistryVersion + 1
            )
              return fail("Unavailable");
            return Object.freeze({
              status: r.status as "Applied" | "Replayed",
              operationReference: body.operationReference,
              registryVersion: integer(r.registryVersion),
              snapshotDigest: hash(r.snapshotDigest),
            });
          } catch (error) {
            if (
              unknown ||
              !(error instanceof ProductSellingUnitsError) ||
              error.code === "Unavailable"
            ) {
              unknown = true;
              return fail("OutcomeUnknown");
            }
            throw error;
          }
        },
      });
    },
  });
}
