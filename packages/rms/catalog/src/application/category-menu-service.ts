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
} from "../contracts/product.js";
import {
  parseCategoryAggregate,
  parseMenuAggregate,
  parseMenuDraft,
  transitionCategoryLifecycle,
  validateCategoryMove,
  validateMenuBase,
  type MenuAggregate,
} from "../domain/category-menu.js";
import type {
  CategoryMenuAuthorizationEvidence,
  CategoryMenuPorts,
  CategoryOperationAction,
  CategoryOperationRecord,
  MenuOperationAction,
  MenuOperationRecord,
} from "./ports/category-menu-ports.js";

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
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
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
function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function references(value: unknown): readonly CatalogReference[] {
  if (!Array.isArray(value)) return invalid();
  const result = Object.freeze(value.map(parseCatalogReference));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function plainTextMap(value: unknown, maximum: number): Readonly<Record<string, string>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return invalid();
    parseCatalogLocale(key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.trim().length < 1 ||
      descriptor.value.trim().length > maximum ||
      /[<>{}]|\[|\]|https?:\/\/|www\.|(?:^|\s)[#*_`]/iu.test(descriptor.value)
    )
      return invalid();
    result[key] = descriptor.value.trim().replace(/\s+/gu, " ");
  }
  return Object.freeze(result);
}
function dependencyFailure(error: unknown): never {
  if (
    error instanceof CatalogError &&
    (error.code === "CATALOG_VERSION_CONFLICT" ||
      error.code === "CATALOG_IDEMPOTENCY_CONFLICT" ||
      error.code === "CATALOG_CODE_CONFLICT")
  )
    throw error;
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
}
function operation(value: Readonly<Record<string, unknown>>) {
  return {
    operationReference: parseCatalogReference(value.operationReference),
    requestedAt: parseCatalogInstant(value.requestedAt),
  };
}
function authority(
  evidence: CategoryMenuAuthorizationEvidence | null,
  resource: "Category" | "Menu",
  action: CategoryOperationAction | MenuOperationAction,
  aggregateReference: CatalogReference,
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
      evidence.permission.action !== `catalog.${resource.toLowerCase()}.manage` ||
      audit.brandId !== String(context.brand.brandReference) ||
      audit.storeId !== undefined ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.actionCode !== `CATALOG_${resource.toUpperCase()}_${action.toUpperCase()}` ||
      audit.targetType !== `Catalog${resource}` ||
      audit.targetId !== aggregateReference ||
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
  ports: CategoryMenuPorts,
  resource: "Category" | "Menu",
  action: CategoryOperationAction | MenuOperationAction,
  operationReference: CatalogReference,
  aggregateReference: CatalogReference,
  observedAt: CatalogInstant,
) {
  const evidence = await ports.authorization
    .authorize({ resource, action, operationReference, aggregateReference, observedAt })
    .catch(dependencyFailure);
  return authority(evidence, resource, action, aggregateReference, observedAt);
}
async function categoryReplay(
  ports: CategoryMenuPorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.categories
    .resolveOperation(operationReference)
    .catch(dependencyFailure);
  if (prior === null) return null;
  let aggregate: ReturnType<typeof parseCategoryAggregate>;
  let priorReference: CatalogReference;
  let priorIntent: ReturnType<typeof parseCatalogHash>;
  try {
    const raw = exact(prior, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    if (raw.action !== "Create" && raw.action !== "Move" && raw.action !== "ChangeLifecycle")
      throw new Error("invalid action");
    priorReference = parseCatalogReference(raw.operationReference);
    priorIntent = parseCatalogHash(raw.operationIntentHash);
    aggregate = parseCategoryAggregate(raw.aggregate);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (priorReference !== operationReference)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  if (!ports.references.equals(priorIntent, intent))
    throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
  return Object.freeze({ status: "AlreadyApplied" as const, aggregate });
}
async function menuReplay(
  ports: CategoryMenuPorts,
  operationReference: CatalogReference,
  intent: ReturnType<typeof parseCatalogHash>,
) {
  const prior = await ports.menus.resolveOperation(operationReference).catch(dependencyFailure);
  if (prior === null) return null;
  let aggregate: MenuAggregate;
  let priorReference: CatalogReference;
  let priorIntent: ReturnType<typeof parseCatalogHash>;
  try {
    const raw = exact(prior, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    if (raw.action !== "Create" && raw.action !== "ReplaceDraft") throw new Error("invalid action");
    priorReference = parseCatalogReference(raw.operationReference);
    priorIntent = parseCatalogHash(raw.operationIntentHash);
    aggregate = parseMenuAggregate(raw.aggregate);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (priorReference !== operationReference)
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  if (!ports.references.equals(priorIntent, intent))
    throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
  return Object.freeze({ status: "AlreadyApplied" as const, aggregate });
}
function verifyCategory(
  saved: CategoryOperationRecord,
  expected: CategoryOperationRecord,
  ports: CategoryMenuPorts,
) {
  let raw: Readonly<Record<string, unknown>>;
  let aggregate: ReturnType<typeof parseCategoryAggregate>;
  let savedReference: CatalogReference;
  let savedIntent: ReturnType<typeof parseCatalogHash>;
  try {
    raw = exact(saved, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    aggregate = parseCategoryAggregate(raw.aggregate);
    savedReference = parseCatalogReference(raw.operationReference);
    savedIntent = parseCatalogHash(raw.operationIntentHash);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (
    raw.action !== expected.action ||
    savedReference !== expected.operationReference ||
    !ports.references.equals(savedIntent, expected.operationIntentHash) ||
    aggregate.categoryReference !== expected.aggregate.categoryReference ||
    aggregate.aggregateVersion !== expected.aggregate.aggregateVersion
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return aggregate;
}
function verifyMenu(
  saved: MenuOperationRecord,
  expected: MenuOperationRecord,
  ports: CategoryMenuPorts,
) {
  let raw: Readonly<Record<string, unknown>>;
  let aggregate: MenuAggregate;
  let savedReference: CatalogReference;
  let savedIntent: ReturnType<typeof parseCatalogHash>;
  try {
    raw = exact(saved, ["action", "operationReference", "operationIntentHash", "aggregate"]);
    aggregate = parseMenuAggregate(raw.aggregate);
    savedReference = parseCatalogReference(raw.operationReference);
    savedIntent = parseCatalogHash(raw.operationIntentHash);
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
  if (
    raw.action !== expected.action ||
    savedReference !== expected.operationReference ||
    !ports.references.equals(savedIntent, expected.operationIntentHash) ||
    aggregate.menuReference !== expected.aggregate.menuReference ||
    aggregate.aggregateVersion !== expected.aggregate.aggregateVersion
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  return aggregate;
}
async function validateStores(
  ports: CategoryMenuPorts,
  brandReference: CatalogReference,
  storeReferences: readonly CatalogReference[],
) {
  const valid = await ports.facts
    .validateStores({ brandReference, storeReferences })
    .catch(dependencyFailure);
  if (!valid) throw new CatalogError("CATALOG_UNAVAILABLE");
}
async function inspectBase(ports: CategoryMenuPorts, aggregate: MenuAggregate) {
  const view = await ports.menus
    .inspectBase({
      menuReference: aggregate.menuReference,
      brandReference: aggregate.brandReference,
      baseMenuReference: aggregate.draft.baseMenuReference,
    })
    .catch(dependencyFailure);
  validateMenuBase(
    aggregate,
    view.base === null ? null : parseMenuAggregate(view.base),
    view.menuIsBase,
  );
}
async function validateMenuFacts(ports: CategoryMenuPorts, aggregate: MenuAggregate) {
  await validateStores(ports, aggregate.brandReference, aggregate.draft.storeReferences);
  const categoryReferences = [
    ...new Set(aggregate.draft.sections.flatMap((section) => section.categoryReferences)),
  ];
  const sellableReferences = [
    ...new Set(
      aggregate.draft.sections.flatMap((section) =>
        section.placements.map((placement) => placement.sellableReference),
      ),
    ),
  ];
  const [categoriesValid, sellablesValid] = await Promise.all([
    ports.facts
      .validateCategories({ brandReference: aggregate.brandReference, categoryReferences })
      .catch(dependencyFailure),
    ports.facts
      .validateSellables({
        brandReference: aggregate.brandReference,
        sellableReferences,
        sellableType: "Sku",
      })
      .catch(dependencyFailure),
  ]);
  if (!categoriesValid || !sellablesValid) throw new CatalogError("CATALOG_UNAVAILABLE");
  await inspectBase(ports, aggregate);
}
function menuCreateDraft(value: unknown) {
  const raw = exact(value, [
    "defaultLocale",
    "localizedNames",
    "baseMenuReference",
    "storeReferences",
    "channelCodes",
    "orderTypeCodes",
    "sections",
  ]);
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  if (
    !Array.isArray(raw.sections) ||
    !Array.isArray(raw.channelCodes) ||
    !Array.isArray(raw.orderTypeCodes)
  )
    return invalid();
  return Object.freeze({
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    baseMenuReference:
      raw.baseMenuReference === null ? null : parseCatalogReference(raw.baseMenuReference),
    storeReferences: references(raw.storeReferences),
    channelCodes: Object.freeze(raw.channelCodes.map(parseCatalogCode)),
    orderTypeCodes: Object.freeze(raw.orderTypeCodes.map(parseCatalogCode)),
    sections: Object.freeze(
      raw.sections.map((candidate) => {
        const section = exact(candidate, [
          "internalCode",
          "localizedNames",
          "sortOrder",
          "categoryReferences",
          "placements",
        ]);
        if (!Array.isArray(section.placements)) return invalid();
        return Object.freeze({
          internalCode: parseCatalogCode(section.internalCode),
          localizedNames: parseLocalizedNames(section.localizedNames, defaultLocale),
          sortOrder: nonnegative(section.sortOrder),
          categoryReferences: references(section.categoryReferences),
          placements: Object.freeze(
            section.placements.map((candidatePlacement) => {
              const placement = exact(candidatePlacement, [
                "sellableReference",
                "sellableType",
                "presentationRole",
                "sortOrder",
                "pinned",
                "localizedNameOverrides",
              ]);
              if (
                placement.sellableType !== "Sku" ||
                (placement.presentationRole !== "Standard" &&
                  placement.presentationRole !== "Featured" &&
                  placement.presentationRole !== "Promotional" &&
                  placement.presentationRole !== "Sponsored" &&
                  placement.presentationRole !== "Hidden") ||
                typeof placement.pinned !== "boolean"
              )
                return invalid();
              return Object.freeze({
                sellableReference: parseCatalogReference(placement.sellableReference),
                sellableType: "Sku" as const,
                presentationRole: placement.presentationRole,
                sortOrder: nonnegative(placement.sortOrder),
                pinned: placement.pinned,
                localizedNameOverrides: plainTextMap(placement.localizedNameOverrides, 120),
              });
            }),
          ),
        });
      }),
    ),
  });
}

export function createCategoryMenuService(ports: CategoryMenuPorts) {
  return Object.freeze({
    async createCategory(value: unknown) {
      const raw = exact(value, [
        "internalCode",
        "defaultLocale",
        "localizedNames",
        "localizedDescriptions",
        "parentCategoryReference",
        "sortOrder",
        "storeReferences",
        "operationReference",
        "requestedAt",
      ]);
      const op = operation(raw);
      const content = Object.freeze({
        internalCode: parseCatalogCode(raw.internalCode),
        defaultLocale: parseCatalogLocale(raw.defaultLocale),
        localizedNames: raw.localizedNames,
        localizedDescriptions: plainTextMap(raw.localizedDescriptions, 500),
        parentCategoryReference:
          raw.parentCategoryReference === null
            ? null
            : parseCatalogReference(raw.parentCategoryReference),
        sortOrder: nonnegative(raw.sortOrder),
        storeReferences: references(raw.storeReferences),
      });
      parseLocalizedNames(content.localizedNames, content.defaultLocale);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`CategoryCreate:${JSON.stringify(content)}`),
      );
      const prior = await categoryReplay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const categoryReference = parseCatalogReference(ports.references.generate("Category"));
      const auth = await authorize(
        ports,
        "Category",
        "Create",
        op.operationReference,
        categoryReference,
        op.requestedAt,
      );
      const move = await ports.categories
        .inspectMove({
          categoryReference,
          brandReference: auth.brand,
          parentCategoryReference: content.parentCategoryReference,
          sortOrder: content.sortOrder,
        })
        .catch(dependencyFailure);
      const seed = parseCategoryAggregate({
        categoryReference,
        brandReference: auth.brand,
        internalCode: content.internalCode,
        lifecycle: "Draft",
        aggregateVersion: 1,
        defaultLocale: content.defaultLocale,
        localizedNames: content.localizedNames,
        localizedDescriptions: content.localizedDescriptions,
        parentCategoryReference: content.parentCategoryReference,
        level: move.parent === null ? 1 : move.parent.level + 1,
        sortOrder: content.sortOrder,
        storeReferences: content.storeReferences,
        createdAt: op.requestedAt,
        createdByActorReference: auth.actor,
        updatedAt: op.requestedAt,
      });
      const level = validateCategoryMove({
        category: seed,
        parent: move.parent,
        ancestorReferences: move.ancestorReferences,
        subtreeDepth: move.subtreeDepth,
      });
      if (!move.siblingSortAvailable || seed.level !== level)
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      await validateStores(ports, auth.brand, seed.storeReferences);
      const available = await ports.categories
        .codeAvailable({
          brandReference: auth.brand,
          internalCode: seed.internalCode,
          excludingCategoryReference: null,
        })
        .catch(dependencyFailure);
      if (!available) throw new CatalogError("CATALOG_CODE_CONFLICT");
      const record: CategoryOperationRecord = Object.freeze({
        action: "Create",
        operationReference: op.operationReference,
        operationIntentHash: intent,
        aggregate: seed,
      });
      const saved = await ports.categories
        .create({ record, audit: auth.audit })
        .catch(dependencyFailure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifyCategory(saved, record, ports),
      });
    },

    async moveCategory(value: unknown) {
      const raw = exact(value, [
        "categoryReference",
        "parentCategoryReference",
        "sortOrder",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const categoryReference = parseCatalogReference(raw.categoryReference);
      const parentCategoryReference =
        raw.parentCategoryReference === null
          ? null
          : parseCatalogReference(raw.parentCategoryReference);
      const sortOrder = nonnegative(raw.sortOrder);
      const expected = positive(raw.expectedAggregateVersion);
      const op = operation(raw);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `CategoryMove:${categoryReference}:${parentCategoryReference ?? "root"}:${sortOrder}:${expected}`,
        ),
      );
      const prior = await categoryReplay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.categories.load(categoryReference).catch(dependencyFailure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseCategoryAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Category",
        "Move",
        op.operationReference,
        categoryReference,
        op.requestedAt,
      );
      if (auth.brand !== current.brandReference)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const view = await ports.categories
        .inspectMove({
          categoryReference,
          brandReference: auth.brand,
          parentCategoryReference,
          sortOrder,
        })
        .catch(dependencyFailure);
      const level = validateCategoryMove({
        category: current,
        parent: view.parent,
        ancestorReferences: view.ancestorReferences,
        subtreeDepth: view.subtreeDepth,
      });
      if (!view.siblingSortAvailable || (view.subtreeDepth > 1 && level !== current.level))
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      const next = parseCategoryAggregate({
        ...current,
        parentCategoryReference,
        level,
        sortOrder,
        aggregateVersion: expected + 1,
        updatedAt: op.requestedAt,
      });
      const record: CategoryOperationRecord = Object.freeze({
        action: "Move",
        operationReference: op.operationReference,
        operationIntentHash: intent,
        aggregate: next,
      });
      const saved = await ports.categories
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(dependencyFailure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifyCategory(saved, record, ports),
      });
    },

    async changeCategoryLifecycle(value: unknown) {
      const raw = exact(value, [
        "categoryReference",
        "targetLifecycle",
        "expectedAggregateVersion",
        "operationReference",
        "requestedAt",
      ]);
      const categoryReference = parseCatalogReference(raw.categoryReference);
      if (
        raw.targetLifecycle !== "Draft" &&
        raw.targetLifecycle !== "Active" &&
        raw.targetLifecycle !== "Inactive" &&
        raw.targetLifecycle !== "Archived"
      )
        return invalid();
      const expected = positive(raw.expectedAggregateVersion);
      const op = operation(raw);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `CategoryLifecycle:${categoryReference}:${raw.targetLifecycle}:${expected}`,
        ),
      );
      const prior = await categoryReplay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.categories.load(categoryReference).catch(dependencyFailure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseCategoryAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Category",
        "ChangeLifecycle",
        op.operationReference,
        categoryReference,
        op.requestedAt,
      );
      if (auth.brand !== current.brandReference)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      const view = await ports.categories
        .inspectMove({
          categoryReference,
          brandReference: auth.brand,
          parentCategoryReference: current.parentCategoryReference,
          sortOrder: current.sortOrder,
        })
        .catch(dependencyFailure);
      if (
        raw.targetLifecycle === "Archived" &&
        current.lifecycle === "Active" &&
        view.hasActiveChildren
      )
        throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
      const next = parseCategoryAggregate({
        ...current,
        lifecycle: transitionCategoryLifecycle(current.lifecycle, raw.targetLifecycle),
        aggregateVersion: expected + 1,
        updatedAt: op.requestedAt,
      });
      const record: CategoryOperationRecord = Object.freeze({
        action: "ChangeLifecycle",
        operationReference: op.operationReference,
        operationIntentHash: intent,
        aggregate: next,
      });
      const saved = await ports.categories
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(dependencyFailure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifyCategory(saved, record, ports),
      });
    },

    async createMenu(value: unknown) {
      const raw = exact(value, ["internalCode", "draft", "operationReference", "requestedAt"]);
      const op = operation(raw);
      const code = parseCatalogCode(raw.internalCode);
      const draftInput = menuCreateDraft(raw.draft);
      const intent = parseCatalogHash(
        ports.references.hashIntent(`MenuCreate:${code}:${JSON.stringify(draftInput)}`),
      );
      const prior = await menuReplay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const menuReference = parseCatalogReference(ports.references.generate("Menu"));
      const auth = await authorize(
        ports,
        "Menu",
        "Create",
        op.operationReference,
        menuReference,
        op.requestedAt,
      );
      const defaultLocale = draftInput.defaultLocale;
      const sections = draftInput.sections.map((candidate) => {
        const sectionReference = parseCatalogReference(ports.references.generate("MenuSection"));
        return {
          sectionReference,
          menuReference,
          brandReference: auth.brand,
          internalCode: candidate.internalCode,
          localizedNames: candidate.localizedNames,
          sortOrder: candidate.sortOrder,
          categoryReferences: candidate.categoryReferences,
          placements: candidate.placements.map((placement) => {
            return {
              placementReference: parseCatalogReference(ports.references.generate("Placement")),
              menuReference,
              sectionReference,
              brandReference: auth.brand,
              sellableReference: placement.sellableReference,
              sellableType: placement.sellableType,
              presentationRole: placement.presentationRole,
              sortOrder: placement.sortOrder,
              pinned: placement.pinned,
              localizedNameOverrides: placement.localizedNameOverrides,
              createdAt: op.requestedAt,
              createdByActorReference: auth.actor,
            };
          }),
        };
      });
      const aggregate = parseMenuAggregate({
        menuReference,
        brandReference: auth.brand,
        internalCode: code,
        aggregateVersion: 1,
        draft: {
          versionReference: parseCatalogReference(ports.references.generate("MenuVersion")),
          status: "Draft",
          baseMenuReference: draftInput.baseMenuReference,
          defaultLocale,
          localizedNames: draftInput.localizedNames,
          storeReferences: draftInput.storeReferences,
          channelCodes: draftInput.channelCodes,
          orderTypeCodes: draftInput.orderTypeCodes,
          sections,
          createdAt: op.requestedAt,
          updatedAt: op.requestedAt,
        },
        createdAt: op.requestedAt,
        createdByActorReference: auth.actor,
        updatedAt: op.requestedAt,
      });
      await validateMenuFacts(ports, aggregate);
      const available = await ports.menus
        .codeAvailable({
          brandReference: auth.brand,
          internalCode: code,
          excludingMenuReference: null,
        })
        .catch(dependencyFailure);
      if (!available) throw new CatalogError("CATALOG_CODE_CONFLICT");
      const record: MenuOperationRecord = Object.freeze({
        action: "Create",
        operationReference: op.operationReference,
        operationIntentHash: intent,
        aggregate,
      });
      const saved = await ports.menus
        .create({ record, audit: auth.audit })
        .catch(dependencyFailure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifyMenu(saved, record, ports),
      });
    },

    async replaceMenuDraft(value: unknown) {
      const raw = exact(value, [
        "menuReference",
        "expectedAggregateVersion",
        "draft",
        "operationReference",
        "requestedAt",
      ]);
      const menuReference = parseCatalogReference(raw.menuReference);
      const expected = positive(raw.expectedAggregateVersion);
      const draft = parseMenuDraft(raw.draft);
      const op = operation(raw);
      const intent = parseCatalogHash(
        ports.references.hashIntent(
          `MenuReplaceDraft:${menuReference}:${expected}:${JSON.stringify(draft)}`,
        ),
      );
      const prior = await menuReplay(ports, op.operationReference, intent);
      if (prior !== null) return prior;
      const currentValue = await ports.menus.load(menuReference).catch(dependencyFailure);
      if (currentValue === null) throw new CatalogError("CATALOG_UNAVAILABLE");
      const current = parseMenuAggregate(currentValue);
      if (current.aggregateVersion !== expected) throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const auth = await authorize(
        ports,
        "Menu",
        "ReplaceDraft",
        op.operationReference,
        menuReference,
        op.requestedAt,
      );
      if (
        auth.brand !== current.brandReference ||
        draft.versionReference !== current.draft.versionReference ||
        draft.createdAt !== current.draft.createdAt ||
        draft.updatedAt !== op.requestedAt
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      for (const section of draft.sections) {
        const previous = current.draft.sections.find(
          (candidate) => candidate.sectionReference === section.sectionReference,
        );
        if (previous !== undefined && previous.internalCode !== section.internalCode)
          return invalid();
        for (const placement of section.placements) {
          const oldPlacement = current.draft.sections
            .flatMap((candidate) => candidate.placements)
            .find((candidate) => candidate.placementReference === placement.placementReference);
          if (
            oldPlacement !== undefined &&
            (oldPlacement.sectionReference !== placement.sectionReference ||
              oldPlacement.sellableReference !== placement.sellableReference ||
              oldPlacement.createdAt !== placement.createdAt ||
              oldPlacement.createdByActorReference !== placement.createdByActorReference)
          )
            return invalid();
        }
      }
      const next = parseMenuAggregate({
        ...current,
        draft,
        aggregateVersion: expected + 1,
        updatedAt: op.requestedAt,
      });
      await validateMenuFacts(ports, next);
      const record: MenuOperationRecord = Object.freeze({
        action: "ReplaceDraft",
        operationReference: op.operationReference,
        operationIntentHash: intent,
        aggregate: next,
      });
      const saved = await ports.menus
        .commit({ record, expectedAggregateVersion: expected, audit: auth.audit })
        .catch(dependencyFailure);
      return Object.freeze({
        status: "Applied" as const,
        aggregate: verifyMenu(saved, record, ports),
      });
    },
  });
}
