import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";

import {
  CatalogError,
  parseCatalogCode,
  parseCatalogDecimal,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
  parseProductAggregate,
  parseProductLifecycle,
  parseProductVersion,
  parseVariantSelections,
  transitionCatalogLifecycle,
  type CatalogInstant,
  type CatalogReference,
  type ProductAggregate,
} from "../contracts/product.js";
import type {
  CatalogAuthorizationEvidence,
  CatalogOperationRecord,
  CatalogProductPorts,
} from "./ports/product-ports.js";

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new CatalogError("CATALOG_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      throw new CatalogError("CATALOG_INPUT_INVALID");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CatalogError("CATALOG_INPUT_INVALID");
  return value as number;
}
function failure(error: unknown): never {
  if (
    error instanceof CatalogError &&
    (error.code === "CATALOG_VERSION_CONFLICT" ||
      error.code === "CATALOG_IDEMPOTENCY_CONFLICT" ||
      error.code === "CATALOG_CODE_CONFLICT")
  )
    throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}
function authority(
  evidence: CatalogAuthorizationEvidence | null,
  action: CatalogOperationRecord["action"],
  at: CatalogInstant,
  productReference: CatalogReference | null,
): { brand: CatalogReference; actor: CatalogReference; audit: AppendAuditRecordInput } {
  if (evidence === null) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  try {
    exact(evidence, ["tenantContext", "permission", "audit"]);
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    const expectedAction = `CATALOG_PRODUCT_${action.toUpperCase()}`;
    if (
      context.scopeKind !== "Brand" ||
      actor === null ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.scopeKind !== "Brand" ||
      evidence.permission.action !== "catalog.product.manage" ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== expectedAction ||
      audit.targetType !== "CatalogProduct" ||
      audit.targetId !== (productReference ?? audit.targetId) ||
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
  ports: CatalogProductPorts,
  action: CatalogOperationRecord["action"],
  operationReference: CatalogReference,
  productReference: CatalogReference | null,
  observedAt: CatalogInstant,
) {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, productReference, observedAt })
    .catch(failure);
  return authority(evidence, action, observedAt, productReference);
}
async function replay(
  ports: CatalogProductPorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.repository.resolveOperation(operationReference).catch(failure);
  if (prior === null) return null;
  let priorReference: CatalogReference;
  let priorIntent: ReturnType<typeof parseCatalogHash>;
  let aggregate: ProductAggregate;
  try {
    const raw = exact(prior, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    if (
      raw.action !== "Create" &&
      raw.action !== "ReplaceDraft" &&
      raw.action !== "ChangeLifecycle"
    )
      throw new Error("invalid operation");
    priorReference = parseCatalogReference(raw.operationReference);
    priorIntent = parseCatalogHash(raw.operationIntentHash);
    aggregate = parseProductAggregate(raw.aggregate);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (priorReference !== operationReference)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  if (!ports.references.equals(priorIntent, intent))
    throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
  return Object.freeze({
    status: "AlreadyApplied" as const,
    aggregate,
  });
}
function operationInput(value: unknown) {
  const raw = exact(value, ["operationReference", "requestedAt"]);
  return {
    operationReference: parseCatalogReference(raw.operationReference),
    requestedAt: parseCatalogInstant(raw.requestedAt),
  };
}
function record(
  action: CatalogOperationRecord["action"],
  operationReference: CatalogReference,
  operationIntentHash: ReturnType<typeof parseCatalogHash>,
  aggregate: ProductAggregate,
): CatalogOperationRecord {
  return Object.freeze({ action, operationReference, operationIntentHash, aggregate });
}
function verifiedRecord(
  value: unknown,
  expected: CatalogOperationRecord,
  ports: CatalogProductPorts,
): CatalogOperationRecord {
  const raw = exact(value, ["action", "operationReference", "operationIntentHash", "aggregate"]);
  const aggregate = parseProductAggregate(raw.aggregate);
  if (
    raw.action !== expected.action ||
    parseCatalogReference(raw.operationReference) !== expected.operationReference ||
    !ports.references.equals(
      parseCatalogHash(raw.operationIntentHash),
      expected.operationIntentHash,
    ) ||
    aggregate.productReference !== expected.aggregate.productReference ||
    aggregate.brandReference !== expected.aggregate.brandReference ||
    aggregate.aggregateVersion !== expected.aggregate.aggregateVersion ||
    aggregate.updatedAt !== expected.aggregate.updatedAt
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({
    action: expected.action,
    operationReference: expected.operationReference,
    operationIntentHash: expected.operationIntentHash,
    aggregate,
  });
}

export function createCatalogProductService(ports: CatalogProductPorts) {
  return Object.freeze({
    async create(value: unknown) {
      const raw = exact(value, [
        "internalCode",
        "productType",
        "defaultLocale",
        "localizedNames",
        "taxClassificationReference",
        "skus",
        "operationReference",
        "requestedAt",
      ]);
      const op = operationInput({
        operationReference: raw.operationReference,
        requestedAt: raw.requestedAt,
      });
      const code = parseCatalogCode(raw.internalCode);
      if (raw.productType !== "PreparedFood" && raw.productType !== "NonAlcoholicBeverage")
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const defaultLocale = parseCatalogLocale(raw.defaultLocale);
      const localizedNames = parseLocalizedNames(raw.localizedNames, defaultLocale);
      const taxClassificationReference =
        raw.taxClassificationReference === null
          ? null
          : parseCatalogReference(raw.taxClassificationReference);
      if (!Array.isArray(raw.skus)) throw new CatalogError("CATALOG_INPUT_INVALID");
      const skuInputs = raw.skus.map((candidate) => {
        const input = exact(candidate, [
          "skuCode",
          "localizedNames",
          "variantSelections",
          "unitOfSale",
          "unitQuantity",
        ]);
        return Object.freeze({
          skuCode: parseCatalogCode(input.skuCode),
          localizedNames: parseLocalizedNames(input.localizedNames, defaultLocale),
          variantSelections: parseVariantSelections(input.variantSelections),
          unitOfSale: parseCatalogCode(input.unitOfSale),
          unitQuantity: parseCatalogDecimal(input.unitQuantity),
        });
      });
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `Create:${JSON.stringify({
            internalCode: code,
            productType: raw.productType,
            defaultLocale,
            localizedNames,
            taxClassificationReference,
            skus: skuInputs,
            requestedAt: op.requestedAt,
          })}`,
        ),
      );
      const prior = await replay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const productReference = parseCatalogReference(ports.references.generate("Product"));
      const auth = await authorize(
        ports,
        "Create",
        op.operationReference,
        productReference,
        op.requestedAt,
      );
      const versionReference = parseCatalogReference(ports.references.generate("ProductVersion"));
      const skus = skuInputs.map((input) => {
        return {
          skuReference: parseCatalogReference(ports.references.generate("Sku")),
          productReference,
          brandReference: auth.brand,
          skuCode: input.skuCode,
          lifecycle: "Draft",
          localizedNames: input.localizedNames,
          variantSelections: input.variantSelections,
          unitOfSale: input.unitOfSale,
          unitQuantity: input.unitQuantity,
          createdAt: op.requestedAt,
          createdByActorReference: auth.actor,
        };
      });
      const aggregate = parseProductAggregate({
        productReference,
        brandReference: auth.brand,
        internalCode: code,
        productType: raw.productType,
        lifecycle: "Draft",
        aggregateVersion: 1,
        draft: {
          versionReference,
          baseVersionReference: null,
          status: "Draft",
          defaultLocale,
          localizedNames,
          taxClassificationReference,
          skus,
          createdAt: op.requestedAt,
          updatedAt: op.requestedAt,
        },
        createdAt: op.requestedAt,
        createdByActorReference: auth.actor,
        updatedAt: op.requestedAt,
      });
      const available = await ports.repository
        .codeAvailable({
          brandReference: auth.brand,
          productCode: aggregate.internalCode,
          skuCodes: aggregate.draft.skus.map((sku) => sku.skuCode),
          excludingProductReference: null,
        })
        .catch(failure);
      if (!available) throw new CatalogError("CATALOG_CODE_CONFLICT");
      const expectedRecord = record("Create", op.operationReference, intent, aggregate);
      const saved = await ports.repository
        .create({
          record: expectedRecord,
          audit: auth.audit,
        })
        .catch(failure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifiedRecord(saved, expectedRecord, ports).aggregate,
      });
    },

    async replaceDraft(value: unknown) {
      const raw = exact(value, [
        "productReference",
        "expectedAggregateVersion",
        "draft",
        "operationReference",
        "requestedAt",
      ]);
      const productReference = parseCatalogReference(raw.productReference);
      const expected = positive(raw.expectedAggregateVersion);
      const op = operationInput({
        operationReference: raw.operationReference,
        requestedAt: raw.requestedAt,
      });
      const draft = parseProductVersion(raw.draft);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `ReplaceDraft:${productReference}:${expected}:${JSON.stringify(draft)}`,
        ),
      );
      const prior = await replay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(productReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseProductAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ReplaceDraft",
        op.operationReference,
        productReference,
        op.requestedAt,
      );
      if (
        auth.brand !== current.brandReference ||
        draft.versionReference !== current.draft.versionReference ||
        draft.createdAt !== current.draft.createdAt ||
        draft.updatedAt !== op.requestedAt ||
        draft.skus.some(
          (sku) =>
            sku.productReference !== current.productReference ||
            sku.brandReference !== current.brandReference,
        )
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      for (const sku of draft.skus) {
        const existing = current.draft.skus.find(
          (candidate) => candidate.skuReference === sku.skuReference,
        );
        if (
          existing !== undefined &&
          (existing.skuCode !== sku.skuCode ||
            existing.createdAt !== sku.createdAt ||
            existing.createdByActorReference !== sku.createdByActorReference)
        )
          throw new CatalogError("CATALOG_INPUT_INVALID");
        if (
          existing === undefined &&
          current.draft.skus.some(
            (candidate) =>
              candidate.skuCode === sku.skuCode && candidate.skuReference !== sku.skuReference,
          )
        )
          throw new CatalogError("CATALOG_INPUT_INVALID");
      }
      const available = await ports.repository
        .codeAvailable({
          brandReference: auth.brand,
          productCode: current.internalCode,
          skuCodes: draft.skus.map((sku) => sku.skuCode),
          excludingProductReference: current.productReference,
        })
        .catch(failure);
      if (!available) throw new CatalogError("CATALOG_CODE_CONFLICT");
      const next = parseProductAggregate({
        ...current,
        draft,
        aggregateVersion: current.aggregateVersion + 1,
        updatedAt: op.requestedAt,
      });
      const expectedRecord = record("ReplaceDraft", op.operationReference, intent, next);
      const saved = await ports.repository
        .commit({
          record: expectedRecord,
          expectedAggregateVersion: expected,
          audit: auth.audit,
        })
        .catch(failure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifiedRecord(saved, expectedRecord, ports).aggregate,
      });
    },

    async changeLifecycle(value: unknown) {
      const raw = exact(value, [
        "productReference",
        "skuReference",
        "targetLifecycle",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const productReference = parseCatalogReference(raw.productReference);
      const skuReference =
        raw.skuReference === null ? null : parseCatalogReference(raw.skuReference);
      const expected = positive(raw.expectedAggregateVersion);
      const op = operationInput({
        operationReference: raw.operationReference,
        requestedAt: raw.requestedAt,
      });
      const target = parseProductLifecycle(raw.targetLifecycle);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `Lifecycle:${productReference}:${skuReference ?? "Product"}:${target}:${expected}`,
        ),
      );
      const prior = await replay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.repository.load(productReference).catch(failure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseProductAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "ChangeLifecycle",
        op.operationReference,
        productReference,
        op.requestedAt,
      );
      if (auth.brand !== current.brandReference)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const next =
        skuReference === null
          ? parseProductAggregate({
              ...current,
              lifecycle: transitionCatalogLifecycle(current.lifecycle, target),
              aggregateVersion: current.aggregateVersion + 1,
              updatedAt: op.requestedAt,
            })
          : parseProductAggregate({
              ...current,
              aggregateVersion: current.aggregateVersion + 1,
              updatedAt: op.requestedAt,
              draft: {
                ...current.draft,
                updatedAt: op.requestedAt,
                skus: current.draft.skus.map((sku) =>
                  sku.skuReference === skuReference
                    ? { ...sku, lifecycle: transitionCatalogLifecycle(sku.lifecycle, target) }
                    : sku,
                ),
              },
            });
      if (
        skuReference !== null &&
        !current.draft.skus.some((sku) => sku.skuReference === skuReference)
      )
        throw new CatalogError("CATALOG_UNAVAILABLE");
      const expectedRecord = record("ChangeLifecycle", op.operationReference, intent, next);
      const saved = await ports.repository
        .commit({
          record: expectedRecord,
          expectedAggregateVersion: expected,
          audit: auth.audit,
        })
        .catch(failure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifiedRecord(saved, expectedRecord, ports).aggregate,
      });
    },
  });
}
