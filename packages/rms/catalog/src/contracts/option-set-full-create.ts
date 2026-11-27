import { canonicalizeRfc8785 } from "@bop/audit";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function record(v: unknown, keys: readonly string[]) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k)))
    return fail();
  return r;
}
function list(v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length > 100) return fail();
  return v;
}
function code(v: unknown) {
  const parsed = parseCatalogCode(v);
  if (v !== parsed) return fail();
  return parsed;
}
const draftKeys = [
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
] as const;
const optionKeys = [
  "stableCode",
  "lifecycle",
  "localizedNames",
  "localizedDescriptions",
  "sortOrder",
  "defaultEligible",
  "triggeredOptionSetReference",
  "conflictOptionCodes",
] as const;
const detailKeys = [
  "stableCode",
  "quantityRule",
  "media",
  "pricingRule",
  "consumption",
  "triggeredOptionSetVersionReference",
] as const;
/** Detached bounded authoring template. Complete semantic validation runs against
 * actual server allocations below; this is not a current source/authorization. */
export function parseFullOptionSetCreateCommand(value: unknown) {
  const copied = copyCategoryPersistenceValue(value);
  if (new TextEncoder().encode(canonicalizeRfc8785(copied)).byteLength > 1_048_576) return fail();
  const r = record(copied, [
      "internalCode",
      "draft",
      "additionalContent",
      "operationReference",
      "occurredAt",
      "reasonCode",
    ]),
    draft = record(r.draft, draftKeys),
    additional = record(r.additionalContent, [
      "profile",
      "optionDetails",
      "conditionalRules",
      "conflictRules",
      "scopeSet",
      "effectivePeriod",
    ]),
    options = list(draft.options).map((v) => {
      const o = record(v, optionKeys);
      return {
        ...o,
        sortOrder: o.sortOrder,
        stableCode: code(o.stableCode),
        conflictOptionCodes: list(o.conflictOptionCodes).map(code),
      };
    });
  if (new Set(options.map((o) => o.stableCode)).size !== options.length) return fail();
  const codes = new Set(options.map((o) => o.stableCode));
  const local = (v: unknown) => {
    const result = list(v).map(code);
    if (new Set(result).size !== result.length || result.some((c) => !codes.has(c))) return fail();
    return result.sort();
  };
  const optionDetails = list(additional.optionDetails).map((v) => {
    const d = record(v, detailKeys);
    return { ...d, stableCode: code(d.stableCode) };
  });
  if (
    optionDetails.length !== options.length ||
    new Set(optionDetails.map((d) => d.stableCode)).size !== options.length ||
    optionDetails.some((d) => !codes.has(d.stableCode))
  )
    return fail();
  const conditionalRules = list(additional.conditionalRules).map((v) => {
    const c = record(v, ["ruleReference", "whenAllSelectedCodes", "requiredOptionCodes"]);
    return {
      ruleReference: parseCatalogReference(c.ruleReference),
      whenAllSelectedCodes: local(c.whenAllSelectedCodes),
      requiredOptionCodes: local(c.requiredOptionCodes),
    };
  });
  const conflictRules = list(additional.conflictRules).map((v) => {
    const c = record(v, ["ruleReference", "forbiddenTogetherCodes"]);
    return {
      ruleReference: parseCatalogReference(c.ruleReference),
      forbiddenTogetherCodes: local(c.forbiddenTogetherCodes),
    };
  });
  return {
    internalCode: code(r.internalCode),
    draft: {
      ...draft,
      options: options
        .map((o) => ({ ...o, conflictOptionCodes: local(o.conflictOptionCodes) }))
        .sort((a, b) => a.stableCode.localeCompare(b.stableCode, "en")),
    },
    additionalContent: {
      ...additional,
      optionDetails: optionDetails.sort((a, b) => a.stableCode.localeCompare(b.stableCode, "en")),
      conditionalRules: conditionalRules.sort((a, b) =>
        a.ruleReference.localeCompare(b.ruleReference),
      ),
      conflictRules: conflictRules.sort((a, b) => a.ruleReference.localeCompare(b.ruleReference)),
    },
    operationReference: parseCatalogReference(r.operationReference),
    occurredAt: parseCatalogInstant(r.occurredAt),
    reasonCode: code(r.reasonCode),
  };
}
export interface FullOptionSetCreateAllocations {
  readonly optionSetReference: string;
  readonly versionReference: string;
  readonly options: readonly { readonly stableCode: string; readonly optionReference: string }[];
}
/** Allocate on the server for a fresh operation; replay supplies ONLY identities
 * from its validated original full result. No client persistent identity accepted. */
export function materializeFullOptionSetCreation(
  value: unknown,
  server: {
    readonly brandReference: string;
    readonly actorReference: string;
    readonly allocations: FullOptionSetCreateAllocations;
  },
) {
  const command = parseFullOptionSetCreateCommand(value),
    brand = parseCatalogReference(server.brandReference),
    actor = parseCatalogReference(server.actorReference),
    allocations = record(copyCategoryPersistenceValue(server.allocations), [
      "optionSetReference",
      "versionReference",
      "options",
    ]),
    set = parseCatalogReference(allocations.optionSetReference),
    version = parseCatalogReference(allocations.versionReference),
    entries = list(allocations.options).map((v) => {
      const o = record(v, ["stableCode", "optionReference"]);
      return [code(o.stableCode), parseCatalogReference(o.optionReference)] as const;
    }),
    identities = new Map<string, string>(entries);
  if (
    entries.length !== command.draft.options.length ||
    identities.size !== entries.length ||
    new Set([set, version, ...entries.map((e) => e[1])]).size !== entries.length + 2
  )
    return fail();
  const resolve = (c: string) => {
    const ref = identities.get(c);
    if (!ref) return fail();
    return ref;
  };
  const source = {
    optionSetReference: set,
    brandReference: brand,
    internalCode: command.internalCode,
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: command.occurredAt,
    createdByActorReference: actor,
    updatedAt: command.occurredAt,
    draft: {
      ...command.draft,
      versionReference: version,
      status: "Draft",
      createdAt: command.occurredAt,
      updatedAt: command.occurredAt,
      options: command.draft.options
        .map(({ conflictOptionCodes, ...o }) => ({
          ...o,
          optionReference: resolve(o.stableCode),
          optionSetReference: set,
          brandReference: brand,
          conflictOptionReferences: conflictOptionCodes.map(resolve).sort(),
          createdAt: command.occurredAt,
          createdByActorReference: actor,
        }))
        .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number)),
    },
  };
  const additional = {
    ...command.additionalContent,
    optionDetails: command.additionalContent.optionDetails.map(({ stableCode, ...d }) => ({
      ...d,
      optionReference: resolve(stableCode),
    })),
    conditionalRules: command.additionalContent.conditionalRules.map((c) => ({
      ruleReference: c.ruleReference,
      whenAllSelected: c.whenAllSelectedCodes.map(resolve).sort(),
      requiredOptionReferences: c.requiredOptionCodes.map(resolve).sort(),
    })),
    conflictRules: command.additionalContent.conflictRules.map((c) => ({
      ruleReference: c.ruleReference,
      forbiddenTogether: c.forbiddenTogetherCodes.map(resolve).sort(),
    })),
  };
  return parseCatalogOptionSetEditorContent(source, additional);
}
