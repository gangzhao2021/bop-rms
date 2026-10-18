import { canonicalizeRfc8785 } from "@bop/audit";
import { CatalogError, parseCatalogReference } from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseFullOptionSetCreateCommand,
  materializeFullOptionSetCreation,
} from "./option-set-full-create.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key)))
    return fail();
  return r;
}
function full(value: unknown) {
  const r = closed(copyCategoryPersistenceValue(value), [
    "profile",
    "sourceAggregate",
    "optionDetails",
    "conditionalRules",
    "conflictRules",
    "scopeSet",
    "effectivePeriod",
  ]);
  const { sourceAggregate, ...details } = r;
  return parseCatalogOptionSetEditorContent(sourceAggregate, details);
}
export function parseFullOptionSetEditCommand(value: unknown) {
  const copied = copyCategoryPersistenceValue(value);
  if (new TextEncoder().encode(canonicalizeRfc8785(copied)).byteLength > 1_048_576) return fail();
  const r = closed(copied, [
    "optionSetReference",
    "expectedAggregateVersion",
    "draft",
    "additionalContent",
    "archiveOptionReferences",
    "operationReference",
    "occurredAt",
    "reasonCode",
  ]);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    (r.expectedAggregateVersion as number) < 1 ||
    (r.expectedAggregateVersion as number) >= 2147483647 ||
    !Array.isArray(r.archiveOptionReferences) ||
    r.archiveOptionReferences.length > 100
  )
    return fail();
  const draft = closed(r.draft, [
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
  ]);
  if (!Array.isArray(draft.options) || draft.options.length > 100) return fail();
  const identities = new Map<
    string,
    { readonly kind: "New" } | { readonly kind: "Existing"; readonly optionReference: string }
  >();
  const options = draft.options.map((value) => {
    const o = closed(value, [
      "identity",
      "stableCode",
      "lifecycle",
      "localizedNames",
      "localizedDescriptions",
      "sortOrder",
      "defaultEligible",
      "triggeredOptionSetReference",
      "conflictOptionCodes",
    ]);
    if (typeof o.stableCode !== "string" || identities.has(o.stableCode)) return fail();
    const identity = closed(
      o.identity,
      (o.identity as { kind?: unknown } | null)?.kind === "New"
        ? ["kind"]
        : ["kind", "optionReference"],
    );
    if (identity.kind !== "New" && identity.kind !== "Existing") return fail();
    identities.set(
      o.stableCode,
      identity.kind === "New"
        ? Object.freeze({ kind: "New" })
        : Object.freeze({
            kind: "Existing",
            optionReference: parseCatalogReference(identity.optionReference),
          }),
    );
    const { identity: ignored, ...template } = o;
    void ignored;
    return template;
  });
  const template = parseFullOptionSetCreateCommand({
    internalCode: "EDIT_TEMPLATE",
    draft: { ...draft, options },
    additionalContent: r.additionalContent,
    operationReference: r.operationReference,
    occurredAt: r.occurredAt,
    reasonCode: r.reasonCode,
  });
  const archiveOptionReferences = r.archiveOptionReferences.map(parseCatalogReference).sort();
  const existing = [...identities.values()].flatMap((identity) =>
    identity.kind === "Existing" ? [identity.optionReference] : [],
  );
  if (
    new Set([...existing, ...archiveOptionReferences]).size !==
      existing.length + archiveOptionReferences.length ||
    template.draft.options.length + archiveOptionReferences.length > 100
  )
    return fail();
  return Object.freeze({
    optionSetReference: parseCatalogReference(r.optionSetReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
    draft: {
      ...template.draft,
      options: template.draft.options.map((option) => {
        const identity = identities.get(option.stableCode);
        if (!identity) return fail();
        return { ...option, identity };
      }),
    },
    additionalContent: template.additionalContent,
    archiveOptionReferences,
    operationReference: template.operationReference,
    occurredAt: template.occurredAt,
    reasonCode: template.reasonCode,
  });
}
export type FullOptionSetEditCommand = ReturnType<typeof parseFullOptionSetEditCommand>;
/** Only server allocations for New templates. Existing creation metadata and all
 * archived details are recovered from the owning original full baseline. */
export function materializeFullOptionSetEdit(
  value: unknown,
  baselineValue: unknown,
  server: {
    readonly actorReference: string;
    readonly newOptions: readonly {
      readonly stableCode: string;
      readonly optionReference: string;
    }[];
  },
) {
  const command = parseFullOptionSetEditCommand(value),
    baseline = full(baselineValue),
    current = baseline.content.sourceAggregate,
    actor = parseCatalogReference(server.actorReference);
  if (
    current.optionSetReference !== command.optionSetReference ||
    current.aggregateVersion !== command.expectedAggregateVersion ||
    current.lifecycle !== "Draft" ||
    current.updatedAt > command.occurredAt
  )
    return fail();
  const old = new Map(
    current.draft.options.map((option) => [String(option.optionReference), option]),
  );
  const archived = command.archiveOptionReferences.map((reference) => {
    const option = old.get(reference);
    if (!option) return fail();
    return option;
  });
  const existing = command.draft.options.flatMap((option) => {
    if (option.identity.kind === "New") return [];
    const previous = old.get(option.identity.optionReference);
    if (!previous || previous.stableCode !== option.stableCode) return fail();
    return [previous];
  });
  if (existing.length + archived.length !== old.size) return fail();
  const allocations = copyCategoryPersistenceValue(server.newOptions);
  if (!Array.isArray(allocations)) return fail();
  const allocated = allocations.map((value) => {
    const r = closed(value, ["stableCode", "optionReference"]);
    if (typeof r.stableCode !== "string") return fail();
    return { stableCode: r.stableCode, optionReference: parseCatalogReference(r.optionReference) };
  });
  const newCodes = command.draft.options
    .filter((option) => option.identity.kind === "New")
    .map((option) => option.stableCode);
  if (
    allocated.length !== newCodes.length ||
    new Set(allocated.map((option) => option.stableCode)).size !== allocated.length ||
    allocated.some((option) => !new Set<string>(newCodes).has(option.stableCode)) ||
    new Set([
      ...old.keys(),
      current.optionSetReference,
      current.draft.versionReference,
      ...allocated.map((option) => option.optionReference),
    ]).size !==
      old.size + allocated.length + 2
  )
    return fail();
  const codeFor = (reference: string) => {
    const option = old.get(reference);
    if (!option) return fail();
    return option.stableCode;
  };
  let order = Math.max(-1, ...command.draft.options.map((option) => Number(option.sortOrder))) + 1;
  const archivedTemplates = archived.map((option) => {
    if (!Number.isSafeInteger(order) || order > 2147483647) return fail();
    return {
      stableCode: option.stableCode,
      lifecycle: "Archived",
      localizedNames: option.localizedNames,
      localizedDescriptions: option.localizedDescriptions,
      sortOrder: order++,
      defaultEligible: false,
      triggeredOptionSetReference: option.triggeredOptionSetReference,
      conflictOptionCodes: option.conflictOptionReferences.map(codeFor),
    };
  });
  const archivedDetails = archived.map((option) => {
    const detail = baseline.content.optionDetails.find(
      (detail) => detail.optionReference === option.optionReference,
    );
    if (!detail) return fail();
    const { optionReference, ...fields } = detail;
    void optionReference;
    return { ...fields, stableCode: option.stableCode };
  });
  const identities = [...existing, ...archived]
    .map((option) => ({
      stableCode: String(option.stableCode),
      optionReference: String(option.optionReference),
    }))
    .concat(allocated);
  const prepared = materializeFullOptionSetCreation(
    {
      internalCode: current.internalCode,
      draft: {
        ...command.draft,
        options: [
          ...command.draft.options.map(({ identity, ...option }) => {
            void identity;
            return option;
          }),
          ...archivedTemplates,
        ],
      },
      additionalContent: {
        ...command.additionalContent,
        optionDetails: [...command.additionalContent.optionDetails, ...archivedDetails],
      },
      operationReference: command.operationReference,
      occurredAt: command.occurredAt,
      reasonCode: command.reasonCode,
    },
    {
      brandReference: current.brandReference,
      actorReference: actor,
      allocations: {
        optionSetReference: current.optionSetReference,
        versionReference: current.draft.versionReference,
        options: identities,
      },
    },
  );
  const draft = {
    ...prepared.content.sourceAggregate.draft,
    createdAt: current.draft.createdAt,
    options: prepared.content.sourceAggregate.draft.options.map((option) => {
      const previous = old.get(option.optionReference);
      return previous
        ? {
            ...option,
            createdAt: previous.createdAt,
            createdByActorReference: previous.createdByActorReference,
          }
        : option;
    }),
  };
  const { sourceAggregate, ...additional } = prepared.content;
  void sourceAggregate;
  if (
    draft.options.some(
      (option) =>
        (option.lifecycle === "Inactive" || option.lifecycle === "Archived") &&
        option.defaultEligible,
    )
  )
    return fail();
  const result = parseCatalogOptionSetEditorContent(
    {
      ...current,
      aggregateVersion: command.expectedAggregateVersion + 1,
      updatedAt: command.occurredAt,
      draft,
    },
    additional,
  );
  if (new TextEncoder().encode(canonicalizeRfc8785(result.content)).byteLength > 1_048_576)
    return fail();
  return result;
}
