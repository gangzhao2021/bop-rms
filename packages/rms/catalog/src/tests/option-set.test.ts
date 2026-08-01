import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";

import { createOptionSetService } from "../application/option-set-service.js";
import type {
  OptionSetOperationRecord,
  OptionSetPorts,
} from "../application/ports/option-set-ports.js";
import { parseProductOptionBinding } from "../domain/product.js";
import {
  parseOptionSetAggregate,
  validateProductOptionBinding,
  type OptionSetAggregate,
} from "../domain/option-set.js";

const id = (n: number) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  actor: id(1),
  brand: id(2),
  set: id(3),
  version: id(4),
  milk: id(5),
  oat: id(6),
  operation: id(7),
  audit: id(8),
  correlation: id(9),
  policy: id(10),
  product: id(11),
  sku: id(12),
  binding: id(13),
} as const;
const at = "2026-08-01T14:00:00.000Z";
function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, "0").repeat(8);
}
function context() {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "CATALOG",
      displayName: "Catalog Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
function audit(action: OptionSetOperationRecord["action"]) {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    actor: { type: "User" as const, reference: ids.actor },
    actionCode: `CATALOG_OPTION_SET_${action.toUpperCase()}`,
    targetType: "CatalogOptionSet",
    targetId: ids.set,
    beforeSummary: {},
    afterSummary: {},
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}
function createInput() {
  return {
    internalCode: " milk_choice ",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Milk choice" },
    localizedDescriptions: {},
    displayStyle: "SingleChoice",
    minimumSelection: 1,
    maximumSelection: 1,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 1,
    options: [
      {
        stableCode: "whole",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Whole milk" },
        localizedDescriptions: {},
        sortOrder: 0,
        defaultEligible: true,
        triggeredOptionSetReference: null,
        conflictOptionReferences: [],
      },
      {
        stableCode: "oat",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Oat milk" },
        localizedDescriptions: {},
        sortOrder: 1,
        defaultEligible: true,
        triggeredOptionSetReference: null,
        conflictOptionReferences: [],
      },
    ],
    operationReference: ids.operation,
    requestedAt: at,
  };
}
function fixture(options: { denied?: boolean; invalidGraph?: boolean } = {}) {
  let aggregate: OptionSetAggregate | null = null;
  const operations = new Map<string, OptionSetOperationRecord>();
  const generated = [ids.set, ids.version, ids.milk, ids.oat];
  const ports: OptionSetPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantContext: context(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "catalog.option_set.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: audit(input.action),
        } as never;
      },
    },
    references: {
      generate: () => generated.shift() ?? id(99),
      hashIntent: (value) => digest(value) as never,
      equals: (left, right) => left === right,
    },
    facts: {
      async validateTriggerGraph() {
        return !options.invalidGraph;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        return aggregate?.optionSetReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return true;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async commit(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return { service: createOptionSetService(ports), current: () => aggregate };
}

describe("Option Set / Option / Product Binding minimum model", () => {
  it("creates one Brand-scoped Draft Option Set and replays the same operation", async () => {
    const state = fixture();
    await expect(state.service.create(createInput())).resolves.toMatchObject({
      status: "Applied",
      aggregate: {
        optionSetReference: ids.set,
        internalCode: "MILK_CHOICE",
        lifecycle: "Draft",
        draft: {
          status: "Draft",
          options: [
            { optionReference: ids.milk, stableCode: "WHOLE" },
            { optionReference: ids.oat, stableCode: "OAT" },
          ],
        },
      },
    });
    await expect(state.service.create(createInput())).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
  });

  it("fails closed on denied authority, changed replay and invalid trigger graph", async () => {
    await expect(fixture({ denied: true }).service.create(createInput())).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    await expect(
      fixture({ invalidGraph: true }).service.create(createInput()),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
    const state = fixture();
    await state.service.create(createInput());
    await expect(
      state.service.create({ ...createInput(), internalCode: "OTHER" }),
    ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  });

  it("enforces satisfiable selection bounds and stable Option identities", () => {
    const state = fixture();
    expect(() =>
      parseOptionSetAggregate({
        optionSetReference: ids.set,
        brandReference: ids.brand,
        internalCode: "MILK",
        lifecycle: "Draft",
        aggregateVersion: 1,
        draft: {
          versionReference: ids.version,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Milk" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 3,
          maximumSelection: 2,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 2,
          options: [],
          createdAt: at,
          updatedAt: at,
        },
        createdAt: at,
        createdByActorReference: ids.actor,
        updatedAt: at,
      }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(state.current()).toBeNull();
  });

  it("validates Product-owned Binding defaults, hard-limit overrides and SKU scope", async () => {
    const state = fixture();
    const created = await state.service.create(createInput());
    const binding = parseProductOptionBinding({
      bindingReference: ids.binding,
      optionSetReference: ids.set,
      optionSetVersionReference: ids.version,
      purpose: "MILK",
      sortOrder: 0,
      enabledOptionReferences: [ids.milk, ids.oat],
      defaultSelections: [{ optionReference: ids.milk, quantity: 1 }],
      minimumSelectionOverride: 1,
      maximumSelectionOverride: 1,
      includedSkuReferences: [ids.sku],
      excludedSkuReferences: [],
      channelCodes: ["DINE_IN"],
      storeOverrideAllowed: false,
    });
    expect(() => validateProductOptionBinding(binding, created.aggregate)).not.toThrow();
    expect(() =>
      validateProductOptionBinding({ ...binding, maximumSelectionOverride: 2 }, created.aggregate),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(() =>
      parseProductOptionBinding({ ...binding, excludedSkuReferences: [ids.sku] }),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    expect(() =>
      validateProductOptionBinding(
        { ...binding, enabledOptionReferences: [], defaultSelections: [] },
        created.aggregate,
      ),
    ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });

  it("rejects self-trigger, dangling conflicts, duplicate codes and markup", () => {
    const base = createInput();
    for (const options of [
      [{ ...base.options[0], triggeredOptionSetReference: ids.set }, base.options[1]],
      [{ ...base.options[0], conflictOptionReferences: [id(90)] }, base.options[1]],
      [base.options[0], { ...base.options[1], stableCode: "whole" }],
      [{ ...base.options[0], localizedNames: { "en-CA": "<b>Milk</b>" } }, base.options[1]],
    ]) {
      expect(() =>
        parseOptionSetAggregate({
          optionSetReference: ids.set,
          brandReference: ids.brand,
          internalCode: "MILK",
          lifecycle: "Draft",
          aggregateVersion: 1,
          draft: {
            versionReference: ids.version,
            status: "Draft",
            defaultLocale: "en-CA",
            localizedNames: { "en-CA": "Milk" },
            localizedDescriptions: {},
            displayStyle: "SingleChoice",
            minimumSelection: 1,
            maximumSelection: 1,
            allowRepeatedOption: false,
            perOptionMaximumQuantity: 1,
            maximumTotalQuantity: 1,
            options: options.map((option, index) => ({
              ...option,
              optionReference: index === 0 ? ids.milk : ids.oat,
              optionSetReference: ids.set,
              brandReference: ids.brand,
              createdAt: at,
              createdByActorReference: ids.actor,
            })),
            createdAt: at,
            updatedAt: at,
          },
          createdAt: at,
          createdByActorReference: ids.actor,
          updatedAt: at,
        }),
      ).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
    }
  });
});
