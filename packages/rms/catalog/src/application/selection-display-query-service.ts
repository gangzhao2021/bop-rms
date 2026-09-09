import {
  CatalogError,
  parseCatalogCode,
  parseCatalogLocale,
  parseCatalogReference,
  type CatalogReference,
} from "../domain/product.js";
import {
  parsePublishedMenuProjection,
  type PublishedMenuProjection,
} from "../domain/published-menu-projection.js";

export interface CatalogSelectionDisplayPorts {
  loadVersionCandidates(input: {
    readonly brandReference: CatalogReference;
    readonly storeReference: CatalogReference;
    readonly menuVersionReference: CatalogReference;
  }): Promise<readonly PublishedMenuProjection[]>;
}

export type CatalogSelectionDisplayResult =
  | { readonly status: "NotFound" | "Unavailable" }
  | {
      readonly status: "Found";
      readonly menuVersionReference: CatalogReference;
      readonly productVersionReference: CatalogReference;
      readonly sellableReference: CatalogReference;
      readonly displayName: string;
      readonly options: readonly {
        readonly optionReference: CatalogReference;
        readonly displayName: string;
      }[];
    };

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalid();
  }
}
function values(value: unknown, maximum = 50): readonly unknown[] {
  if (!Array.isArray(value)) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (
    !Number.isSafeInteger(length) ||
    Number(length) < 0 ||
    Number(length) > maximum ||
    Reflect.ownKeys(value).length !== Number(length) + 1
  )
    return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < Number(length); index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result.push(descriptor.value);
  }
  return result;
}
function input(value: unknown) {
  const raw = closed(value, [
    "brandReference",
    "storeReference",
    "menuVersionReference",
    "productVersionReference",
    "sellableReference",
    "channelCode",
    "orderTypeCode",
    "ruleEvidence",
    "optionReferences",
    "locale",
  ]);
  const ruleEvidence = values(raw.ruleEvidence).map((value) => {
    const rule = closed(value, ["bindingReference", "optionSetVersionReference"]);
    return Object.freeze({
      bindingReference: parseCatalogReference(rule.bindingReference),
      optionSetVersionReference: parseCatalogReference(rule.optionSetVersionReference),
    });
  });
  const optionReferences = values(raw.optionReferences).map(parseCatalogReference);
  if (
    new Set(optionReferences).size !== optionReferences.length ||
    new Set(ruleEvidence.map((rule) => rule.bindingReference)).size !== ruleEvidence.length
  )
    return invalid();
  return Object.freeze({
    brandReference: parseCatalogReference(raw.brandReference),
    storeReference: parseCatalogReference(raw.storeReference),
    menuVersionReference: parseCatalogReference(raw.menuVersionReference),
    productVersionReference: parseCatalogReference(raw.productVersionReference),
    sellableReference: parseCatalogReference(raw.sellableReference),
    channelCode: parseCatalogCode(raw.channelCode),
    orderTypeCode: parseCatalogCode(raw.orderTypeCode),
    locale: parseCatalogLocale(raw.locale),
    ruleEvidence,
    optionReferences,
  });
}
function name(names: Readonly<Record<string, string>>, locale: string, fallback: string): string {
  const value = names[locale] ?? names[fallback];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200)
    throw new Error("display unavailable");
  return value;
}

export interface CatalogSelectionDisplayQuery {
  describe(value: unknown): Promise<CatalogSelectionDisplayResult>;
  describeMany(value: unknown): Promise<readonly CatalogSelectionDisplayResult[]>;
}

// Owner-internal historical presentation only; never a sale, price or allergen decision.
export function createCatalogSelectionDisplayQuery(
  ports: CatalogSelectionDisplayPorts,
): CatalogSelectionDisplayQuery {
  return Object.freeze({
    async describeMany(value: unknown) {
      let requests: readonly ReturnType<typeof input>[];
      try {
        requests = values(value, 100).map(input);
      } catch {
        return invalid();
      }
      const cache = new Map<string, Promise<readonly PublishedMenuProjection[]>>();
      const local = createCatalogSelectionDisplayQuery({
        loadVersionCandidates(request) {
          const key = JSON.stringify(request);
          let pending = cache.get(key);
          if (pending === undefined) {
            pending = Promise.resolve().then(() => ports.loadVersionCandidates(request));
            cache.set(key, pending);
          }
          return pending;
        },
      });
      const results: CatalogSelectionDisplayResult[] = [];
      for (const request of requests) results.push(await local.describe(request));
      return Object.freeze(results);
    },
    async describe(value: unknown): Promise<CatalogSelectionDisplayResult> {
      let request: ReturnType<typeof input>;
      try {
        request = input(value);
      } catch {
        return invalid();
      }
      try {
        const candidates = await ports.loadVersionCandidates({
          brandReference: request.brandReference,
          storeReference: request.storeReference,
          menuVersionReference: request.menuVersionReference,
        });
        if (!Array.isArray(candidates)) throw new Error("display unavailable");
        let found: Extract<CatalogSelectionDisplayResult, { status: "Found" }> | null = null;
        for (const candidate of candidates) {
          const projection = parsePublishedMenuProjection(candidate);
          const snapshot = projection.snapshot;
          if (
            snapshot.brandReference !== request.brandReference ||
            snapshot.menuVersionReference !== request.menuVersionReference ||
            !snapshot.storeReferences.includes(request.storeReference) ||
            projection.sourceEventReference !== projection.sourceCheckpoint
          )
            throw new Error("display unavailable");
          if (
            !snapshot.channelCodes.includes(request.channelCode) ||
            !snapshot.orderTypeCodes.includes(request.orderTypeCode)
          )
            continue;
          for (const sellable of snapshot.sections.flatMap((section) => section.sellables)) {
            if (
              sellable.sellableReference !== request.sellableReference ||
              sellable.productVersionReference !== request.productVersionReference
            )
              continue;
            if (
              !request.ruleEvidence.every((evidence) =>
                sellable.optionRules.some(
                  (rule) =>
                    rule.bindingReference === evidence.bindingReference &&
                    rule.optionSetVersionReference === evidence.optionSetVersionReference,
                ),
              )
            )
              continue;
            const activeRules = sellable.optionRules.filter((rule) =>
              request.ruleEvidence.some(
                (evidence) =>
                  evidence.bindingReference === rule.bindingReference &&
                  evidence.optionSetVersionReference === rule.optionSetVersionReference,
              ),
            );
            if (activeRules.length !== request.ruleEvidence.length)
              throw new Error("ambiguous active rule");
            const options: { optionReference: CatalogReference; displayName: string }[] = [];
            for (const reference of request.optionReferences) {
              const matches = activeRules.flatMap((rule) =>
                rule.enabledOptionReferences.includes(reference)
                  ? rule.options.filter((option) => option.optionReference === reference)
                  : [],
              );
              if (matches.length === 0) break;
              if (matches.length !== 1) throw new Error("ambiguous active option");
              const names = matches.map((option) =>
                name(option.localizedNames, request.locale, snapshot.defaultLocale),
              );
              if (new Set(names).size !== 1) throw new Error("display unavailable");
              options.push(
                Object.freeze({ optionReference: reference, displayName: names[0] as string }),
              );
            }
            if (options.length !== request.optionReferences.length) continue;
            const result = Object.freeze({
              status: "Found" as const,
              menuVersionReference: request.menuVersionReference,
              productVersionReference: request.productVersionReference,
              sellableReference: request.sellableReference,
              displayName: name(sellable.localizedNames, request.locale, snapshot.defaultLocale),
              options: Object.freeze(options),
            });
            if (found !== null && JSON.stringify(found) !== JSON.stringify(result))
              throw new Error("display unavailable");
            found = result;
          }
        }
        return found ?? Object.freeze({ status: "NotFound" });
      } catch {
        return Object.freeze({ status: "Unavailable" });
      }
    },
  });
}
