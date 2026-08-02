import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";

import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
  type CatalogInstant,
  type CatalogReference,
} from "../domain/product.js";
import { parseOptionSetAggregate, parseOptionSetDraft } from "../domain/option-set.js";
import type { OptionSetOperationRecord, OptionSetPorts } from "./ports/option-set-ports.js";

function invalid(): never {
  throw new CatalogError("CATALOG_INPUT_INVALID");
}
function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const own = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid();
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    return invalid();
  }
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
function failure(error: unknown): never {
  if (
    error instanceof CatalogError &&
    ["CATALOG_VERSION_CONFLICT", "CATALOG_IDEMPOTENCY_CONFLICT", "CATALOG_CODE_CONFLICT"].includes(
      error.code,
    )
  )
    throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}
function authority(
  evidence: Awaited<ReturnType<OptionSetPorts["authorization"]["authorize"]>>,
  action: OptionSetOperationRecord["action"],
  reference: CatalogReference,
  at: CatalogInstant,
): { brand: CatalogReference; actor: CatalogReference; audit: AppendAuditRecordInput } {
  if (evidence === null) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  try {
    exact(evidence, ["tenantContext", "permission", "audit"]);
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.scopeKind !== "Brand" ||
      evidence.permission.action !== "catalog.option_set.manage" ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `CATALOG_OPTION_SET_${action.toUpperCase()}` ||
      audit.targetType !== "CatalogOptionSet" ||
      audit.targetId !== reference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      brand: parseCatalogReference(context.brand.brandReference),
      actor: parseCatalogReference(actor),
      audit,
    };
  } catch {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  }
}
async function authorize(
  ports: OptionSetPorts,
  action: OptionSetOperationRecord["action"],
  operationReference: CatalogReference,
  optionSetReference: CatalogReference,
  at: CatalogInstant,
) {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, optionSetReference, observedAt: at })
    .catch(failure);
  return authority(evidence, action, optionSetReference, at);
}
async function replay(
  ports: OptionSetPorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior === null) return null;
  try {
    const raw = exact(prior, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    if (
      !["Create", "ReplaceDraft", "Archive"].includes(String(raw.action)) ||
      parseCatalogReference(raw.operationReference) !== operationReference
    )
      throw new Error("bad record");
    if (!ports.references.equals(parseCatalogHash(raw.operationIntentHash), intent))
      throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "AlreadyApplied" as const,
      aggregate: parseOptionSetAggregate(raw.aggregate),
    });
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
function verify(
  saved: OptionSetOperationRecord,
  expected: OptionSetOperationRecord,
  ports: OptionSetPorts,
) {
  try {
    const aggregate = parseOptionSetAggregate(saved.aggregate);
    if (
      saved.action !== expected.action ||
      saved.operationReference !== expected.operationReference ||
      !ports.references.equals(saved.operationIntentHash, expected.operationIntentHash) ||
      aggregate.optionSetReference !== expected.aggregate.optionSetReference ||
      aggregate.aggregateVersion !== expected.aggregate.aggregateVersion
    )
      throw new Error("bad result");
    return aggregate;
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
async function validateTriggers(
  ports: OptionSetPorts,
  aggregate: ReturnType<typeof parseOptionSetAggregate>,
) {
  const triggeredOptionSetReferences = [
    ...new Set(
      aggregate.draft.options.flatMap((option) =>
        option.triggeredOptionSetReference === null ? [] : [option.triggeredOptionSetReference],
      ),
    ),
  ];
  const valid = await ports.facts
    .validateTriggerGraph({
      brandReference: aggregate.brandReference,
      optionSetReference: aggregate.optionSetReference,
      triggeredOptionSetReferences,
    })
    .catch(failure);
  if (!valid) throw new CatalogError("CATALOG_UNAVAILABLE");
}

export function createOptionSetService(ports: OptionSetPorts) {
  return Object.freeze({
    async create(value: unknown) {
      const raw = exact(value, [
        "internalCode",
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
        "operationReference",
        "requestedAt",
      ]);
      if (!Array.isArray(raw.options)) return invalid();
      const operationReference = parseCatalogReference(raw.operationReference);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const normalized = {
        internalCode: parseCatalogCode(raw.internalCode),
        defaultLocale: parseCatalogLocale(raw.defaultLocale),
        localizedNames: parseLocalizedNames(raw.localizedNames, raw.defaultLocale),
        localizedDescriptions: raw.localizedDescriptions,
        displayStyle: raw.displayStyle,
        minimumSelection: raw.minimumSelection,
        maximumSelection: raw.maximumSelection,
        allowRepeatedOption: raw.allowRepeatedOption,
        perOptionMaximumQuantity: raw.perOptionMaximumQuantity,
        maximumTotalQuantity: raw.maximumTotalQuantity,
        options: raw.options,
      };
      const intent = parseCatalogHash(
        ports.references.hashIntent(`Create:${JSON.stringify(normalized)}:${requestedAt}`),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const optionSetReference = parseCatalogReference(ports.references.generate("OptionSet"));
      const auth = await authorize(
        ports,
        "Create",
        operationReference,
        optionSetReference,
        requestedAt,
      );
      const versionReference = parseCatalogReference(ports.references.generate("OptionSetVersion"));
      const aggregate = parseOptionSetAggregate({
        optionSetReference,
        brandReference: auth.brand,
        internalCode: normalized.internalCode,
        lifecycle: "Draft",
        aggregateVersion: 1,
        draft: {
          versionReference,
          status: "Draft",
          defaultLocale: normalized.defaultLocale,
          localizedNames: normalized.localizedNames,
          localizedDescriptions: normalized.localizedDescriptions,
          displayStyle: normalized.displayStyle,
          minimumSelection: normalized.minimumSelection,
          maximumSelection: normalized.maximumSelection,
          allowRepeatedOption: normalized.allowRepeatedOption,
          perOptionMaximumQuantity: normalized.perOptionMaximumQuantity,
          maximumTotalQuantity: normalized.maximumTotalQuantity,
          options: normalized.options.map((candidate) => {
            const option = exact(candidate, [
              "stableCode",
              "lifecycle",
              "localizedNames",
              "localizedDescriptions",
              "sortOrder",
              "defaultEligible",
              "triggeredOptionSetReference",
              "conflictOptionReferences",
            ]);
            return {
              ...option,
              optionReference: parseCatalogReference(ports.references.generate("Option")),
              optionSetReference,
              brandReference: auth.brand,
              createdAt: requestedAt,
              createdByActorReference: auth.actor,
            };
          }),
          createdAt: requestedAt,
          updatedAt: requestedAt,
        },
        createdAt: requestedAt,
        createdByActorReference: auth.actor,
        updatedAt: requestedAt,
      });
      if (
        !(await ports.repository
          .codeAvailable({
            brandReference: auth.brand,
            internalCode: aggregate.internalCode,
            excludingOptionSetReference: null,
          })
          .catch(failure))
      )
        throw new CatalogError("CATALOG_CODE_CONFLICT");
      await validateTriggers(ports, aggregate);
      const record = Object.freeze({
        action: "Create" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate,
      });
      const saved = await ports.repository.create({ record, audit: auth.audit }).catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
    async replaceDraft(value: unknown) {
      const raw = exact(value, [
        "optionSetReference",
        "expectedAggregateVersion",
        "draft",
        "operationReference",
        "requestedAt",
      ]);
      const optionSetReference = parseCatalogReference(raw.optionSetReference);
      const expected = positive(raw.expectedAggregateVersion);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const operationReference = parseCatalogReference(raw.operationReference);
      const draft = parseOptionSetDraft(raw.draft);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `ReplaceDraft:${optionSetReference}:${expected}:${JSON.stringify(draft)}`,
        ),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(optionSetReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseOptionSetAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ReplaceDraft",
        operationReference,
        optionSetReference,
        requestedAt,
      );
      if (
        auth.brand !== current.brandReference ||
        draft.versionReference !== current.draft.versionReference ||
        draft.createdAt !== current.draft.createdAt ||
        draft.updatedAt !== requestedAt
      )
        return invalid();
      for (const option of draft.options) {
        const priorOption = current.draft.options.find(
          (candidate) => candidate.optionReference === option.optionReference,
        );
        if (
          priorOption !== undefined &&
          (priorOption.stableCode !== option.stableCode ||
            priorOption.createdAt !== option.createdAt ||
            priorOption.createdByActorReference !== option.createdByActorReference)
        )
          return invalid();
        if (priorOption === undefined && option.createdAt !== requestedAt) return invalid();
      }
      if (
        current.draft.options.some(
          (option) =>
            !draft.options.some(
              (candidate) => candidate.optionReference === option.optionReference,
            ),
        )
      )
        return invalid();
      const aggregate = parseOptionSetAggregate({
        ...current,
        aggregateVersion: current.aggregateVersion + 1,
        draft,
        updatedAt: requestedAt,
      });
      await validateTriggers(ports, aggregate);
      const record = Object.freeze({
        action: "ReplaceDraft" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate,
      });
      const saved = await ports.repository
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
    async archive(value: unknown) {
      const raw = exact(value, [
        "optionSetReference",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const optionSetReference = parseCatalogReference(raw.optionSetReference);
      const expected = positive(raw.expectedAggregateVersion);
      const requestedAt = parseCatalogInstant(raw.requestedAt);
      const operationReference = parseCatalogReference(raw.operationReference);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`Archive:${optionSetReference}:${expected}`),
      );
      const prior = await replay(ports, operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(optionSetReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseOptionSetAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Archive",
        operationReference,
        optionSetReference,
        requestedAt,
      );
      if (auth.brand !== current.brandReference || current.lifecycle === "Archived")
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      const aggregate = parseOptionSetAggregate({
        ...current,
        lifecycle: "Archived",
        aggregateVersion: current.aggregateVersion + 1,
        updatedAt: requestedAt,
      });
      const record = Object.freeze({
        action: "Archive" as const,
        operationReference,
        operationIntentHash: intent,
        aggregate,
      });
      const saved = await ports.repository
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(failure);
      return Object.freeze({ status: "Applied" as const, aggregate: verify(saved, record, ports) });
    },
  });
}
