import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { tenantBrandConfigurationRequiredFields } from "@bop/tenant";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductPublicationCommandV2,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  productPublicationWriteFieldsV2,
  productPublicationWarningAcknowledgementFields,
  productEditorSnapshotFields,
  productPublicationValidationReportReadFields,
  productPublicationSourceFieldsV2,
  productPublicationQualificationHistoryFields,
  productWarningAcknowledgementQualificationHistoryFields,
  productPublicationReferenceHistoryFieldsV2,
  productWarningAcknowledgementReferenceHistoryFields,
  productPublicationMenuReferenceSourceFieldsV2,
  productWarningAcknowledgementMenuReferenceSourceFields,
  productPublicationBundleReferenceSourceFieldsV2,
  productWarningAcknowledgementBundleReferenceSourceFields,
  productPublicationAvailabilityReferenceSourceFieldsV2,
  productWarningAcknowledgementAvailabilityReferenceSourceFields,
  productPublicationFrozenFullOptionSetContentFields,
  contentRegistryFields,
  taxClassificationRegistryFields,
} from "@rms/catalog";
import {
  recipeProductPublicationReferenceSourceFieldsV2,
  recipeInventoryProductPublicationReferenceSourceFieldsV2,
} from "@rms/recipe";
import {
  inventoryConfigurationReferencePermissions,
  inventoryProductPublicationSkuMappingReferenceFieldsV2,
} from "@rms/inventory";
import {
  productPublicationConfigurationReferenceSourceFieldsV2,
  productPublicationPriceBookReferenceSourceFieldsV2,
  productPublicationOptionPriceReferenceSourceFieldsV2,
  productPublicationPromotionReferenceSourceFieldsV2,
} from "@rms/pricing";
import { expect, it, vi } from "vitest";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
import { createMerchantProductPublicationRuntimeAuthority } from "./merchant-product-publication-runtime-authority.js";
import type { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";

const id = (n: number) => `019a2421-0033-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
type FactoryHost = Parameters<typeof createMerchantProductPublicationRuntimeAuthority>[0];
interface LooseHolder {
  holdUntilTransactionCompletes(tx: FactoryHost["transaction"], value: never): Promise<unknown>;
}
// Native session/IAM behavior is covered by the current-authorization suite.
// This controlled port records exact native actions; all owner request parsers
// and this fixed field/purpose boundary execute for real.
function fixture(ack = false) {
  const base = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    replacementIntent = { ...base, digest: hash(base) },
    identity = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User" as const,
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      occurredAt: at,
      reasonCode: "SYNTHETIC_AUTHORIZATION",
    },
    command = ack
      ? parseCatalogProductPublicationWarningAcknowledgementCommand({
          ...identity,
          profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
          action: "AcknowledgeProductPublicationWarnings",
          reportOperationReference: id(10),
          reportDigest: hash("report"),
          warningBindingDigest: hash("warnings"),
          warningCodes: ["ChangeImpact"],
        })
      : parseProductPublicationCommandV2({
          ...identity,
          profile: "CatalogProductPublicationCommandV2",
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          action: "Validate",
          expectedPublicationVersion: 0,
          contentDigest: hash("content"),
          configurationDigest: hash("configuration"),
          replacementIntent,
          replacementIntentDigest: replacementIntent.digest,
          scopeSet: [
            { level: "Store", reference: id(8), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
          ],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
          scheduleReference: null,
          replacementVersionReference: null,
          successorDraftVersionReference: null,
        }),
    state = { now: at },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    guards: { async: () => Promise<void>; final: () => void }[] = [],
    authorizeActions = vi.fn<(actions: readonly string[]) => Promise<void>>(async () => undefined),
    currentAuthorization: ReturnType<typeof createMerchantProductCurrentAuthorization> = {
      assertCurrent: () => parseCatalogInstant(state.now),
      authorizeActions,
      async withCurrentStoreScope<T>(): Promise<T> {
        throw new Error("Screen belongs to command host");
      },
    },
    host = {
      transaction: tx,
      command,
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      storeReference: id(8),
      sessionReference: id(9),
      clock: { now: () => state.now },
      originalValidUntil: until,
      authorizeMediaAccess: vi.fn(async () => undefined),
      currentAuthorization,
      registerBeforeCommit: vi.fn(
        async (
          actual: FactoryHost["transaction"],
          async: () => Promise<void>,
          final: () => void,
        ) => {
          expect(actual).toBe(tx);
          guards.push({ async, final });
        },
      ),
    },
    authority = createMerchantProductPublicationRuntimeAuthority(host as FactoryHost),
    digest = hash(command),
    owner = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User" as const,
    },
    intent = {
      command,
      commandPurposeCode: command.purposeCode,
      originalIntentDigest: digest,
      requestObservedAt: at,
      requestValidUntil: until,
    },
    targetDigest = replacementIntent.digest,
    common = {
      ...owner,
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      originalIntentDigest: digest,
      replacementIntentDigest: targetDigest,
      aggregateSnapshotDigest: hash("aggregate"),
      currentPublicationDigest: ack ? hash("head") : null,
      observedAt: at,
      validUntil: until,
    },
    request = ack
      ? {
          profile: "CatalogProductWarningAcknowledgementReferenceRequestV1",
          command,
          originalIntentDigest: digest,
          replacementIntentDigest: targetDigest,
          aggregateSnapshotDigest: hash("aggregate"),
          currentPublicationDigest: hash("head"),
          publicationVersion: 1,
          contentDigest: hash("content"),
          configurationDigest: hash("configuration"),
          scopeDigest: hash("scope"),
          periodDigest: hash("period"),
          policyReference: id(20),
          policyVersion: 1,
          observedAt: at,
          validUntil: until,
        }
      : {
          profile: "CatalogProductPublicationReferenceRequestV2",
          command,
          originalIntentDigest: digest,
          replacementIntentDigest: targetDigest,
          aggregateSnapshotDigest: hash("aggregate"),
          currentPublicationDigest: null,
          observedAt: at,
          validUntil: until,
        },
    policy = {
      ...owner,
      command,
      purposeCode: command.purposeCode,
      originalIntentDigest: digest,
      replacementIntentDigest: targetDigest,
      policyReference: id(20),
      policyVersion: 1,
      requiredFields: currentProductPolicyFields,
      observedAt: at,
      validUntil: until,
    },
    brand = {
      command,
      actorKind: "User" as const,
      purposeCode: command.purposeCode,
      originalIntentDigest: digest,
      replacementIntentDigest: targetDigest,
      request: {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference: id(21),
        expectedBrandVersion: 1,
        originalIntentDigest: digest,
        observedAt: at,
        validUntil: until,
      },
      requiredFields: tenantBrandConfigurationRequiredFields,
    };
  const call = (holder: LooseHolder, packet: unknown) =>
    holder.holdUntilTransactionCompletes(tx, packet as never);
  const finish = async () => {
    for (const g of guards) await g.async();
    for (const g of guards) g.final();
  };
  return {
    authority,
    host,
    tx,
    guards,
    state,
    authorizeActions,
    command,
    owner,
    intent,
    targetDigest,
    common,
    request,
    policy,
    brand,
    call,
    finish,
  };
}

it.each([false, true])(
  "uses actual command purpose and native read grants for Brand and policy (Ack=%s)",
  async (ack) => {
    const f = fixture(ack),
      result = Object.freeze({ marker: "same result" });
    expect(f.authorizeActions).not.toHaveBeenCalled();
    expect(
      await f.authority.contentPolicy.brandAuthority.withCurrentContentRead(
        f.tx,
        f.brand as never,
        async () => result,
      ),
    ).toBe(result);
    await f.call(f.authority.contentPolicy.policyAuthority, f.policy);
    await f.finish();
    expect(
      f.authorizeActions.mock.calls.every(
        ([actions]) =>
          actions.includes("catalog.manage") && actions.includes("catalog.product.read"),
      ),
    ).toBe(true);
    expect(f.guards).toHaveLength(1);
    expect(f.tx.query).not.toHaveBeenCalled();
  },
);

it("requires the real host authorization and captures configured ports and original command before awaits", async () => {
  const f = fixture();
  expect(() =>
    createMerchantProductPublicationRuntimeAuthority({
      ...f.host,
      currentAuthorization: undefined,
    } as unknown as FactoryHost),
  ).toThrow(expect.objectContaining(unavailable));
  const changed = vi.fn(async () => {
    throw new Error("mutated port");
  });
  f.host.currentAuthorization.authorizeActions = changed;
  f.host.clock.now = () => until;
  await f.call(f.authority.contentPolicy.policyAuthority, f.policy);
  expect(changed).not.toHaveBeenCalled();
  await f.finish();
});

it.each(["unknownField", "purpose", "actor", "command", "target", "future", "extended", "wrongTx"])(
  "rejects %s and poisons a swallowed rejection through the final host guard",
  async (mode) => {
    const f = fixture(),
      packet: Record<string, unknown> = { ...f.policy };
    if (mode === "unknownField")
      packet.requiredFields = [...currentProductPolicyFields, "customerHealth"];
    if (mode === "purpose") packet.purposeCode = "CATALOG_PRODUCT_DRAFT_REPLACE";
    if (mode === "actor") packet.actorReference = id(30);
    if (mode === "command") packet.command = { ...f.command, operationReference: id(30) };
    if (mode === "target") packet.replacementIntentDigest = hash("other target");
    if (mode === "future") packet.observedAt = "2026-10-04T12:00:01.000Z";
    if (mode === "extended") packet.validUntil = "2026-10-04T12:00:06.000Z";
    await expect(
      f.authority.contentPolicy.policyAuthority.holdUntilTransactionCompletes(
        mode === "wrongTx" ? { query: f.tx.query } : f.tx,
        packet as never,
      ),
    ).rejects.toHaveProperty("code", unavailable.code);
    await expect(f.finish()).rejects.toHaveProperty("code", unavailable.code);
    expect(f.authorizeActions).not.toHaveBeenCalled();
  },
);

it("rejects accessor packets without invoking getters", async () => {
  const f = fixture(),
    getter = vi.fn(),
    packet = { ...f.policy };
  Object.defineProperty(packet, "policyReference", { enumerable: true, get: getter });
  await expect(f.call(f.authority.contentPolicy.policyAuthority, packet)).rejects.toHaveProperty(
    "code",
    unavailable.code,
  );
  expect(getter).not.toHaveBeenCalled();
  await expect(f.finish()).rejects.toHaveProperty("code", unavailable.code);
});

it("retains captured Brand data during the callback and reauthorizes before returning", async () => {
  const f = fixture(),
    packet = structuredClone(f.brand);
  await f.authority.contentPolicy.brandAuthority.withCurrentContentRead(
    f.tx,
    packet as never,
    async () => {
      packet.request.actorReference = id(30);
      return "same";
    },
  );
  expect(f.authorizeActions).toHaveBeenCalledTimes(2);
  await f.finish();
});

it("denial after the consumer and caught nested reentry both poison the outer transaction", async () => {
  const f = fixture();
  await expect(
    f.authority.contentPolicy.brandAuthority.withCurrentContentRead(
      f.tx,
      f.brand as never,
      async () => {
        f.authorizeActions.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
        return "tentative";
      },
    ),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  await expect(f.finish()).rejects.toHaveProperty("code", unavailable.code);
  const g = fixture();
  await expect(
    g.authority.contentPolicy.brandAuthority.withCurrentContentRead(
      g.tx,
      g.brand as never,
      async () => {
        await g.authority.contentPolicy.brandAuthority
          .withCurrentContentRead(g.tx, g.brand as never, async () => undefined)
          .catch(() => undefined);
      },
    ),
  ).rejects.toHaveProperty("code", unavailable.code);
  await expect(g.finish()).rejects.toHaveProperty("code", unavailable.code);
});

it.each(["expiry", "query", "permission"])(
  "rechecks %s before COMMIT without renewing the original deadline",
  async (mode) => {
    const f = fixture();
    await f.call(f.authority.contentPolicy.policyAuthority, {
      ...f.policy,
      validUntil: "2026-10-04T12:00:01.000Z",
    });
    if (mode === "expiry") f.state.now = "2026-10-04T12:00:01.000Z";
    if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    if (mode === "permission")
      f.authorizeActions.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(f.finish()).rejects.toHaveProperty(
      "code",
      mode === "permission" ? "CATALOG_PERMISSION_DENIED" : unavailable.code,
    );
  },
);

it("catches an original lease consumed after async guards, and refuses an unawaited held consumer", async () => {
  const f = fixture();
  await f.call(f.authority.contentPolicy.policyAuthority, f.policy);
  for (const g of f.guards) await g.async();
  f.state.now = until;
  expect(() => f.guards[0]?.final()).toThrow(expect.objectContaining(unavailable));
  const h = fixture();
  let release: (() => void) | undefined;
  const inside = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    const work = h.authority.contentPolicy.brandAuthority.withCurrentContentRead(
      h.tx,
      h.brand as never,
      async () => {
        resolve();
        await inside;
      },
    );
    void work.catch(() => undefined);
  });
  await started;
  await expect(h.finish()).rejects.toHaveProperty("code", unavailable.code);
  release?.();
});

it.each([false, true])(
  "uses history/registry/Option exact action profiles without lifecycle projection (Ack=%s)",
  async (ack) => {
    const f = fixture(ack);
    await f.call(f.authority.scope.historyAuthority, {
      ...f.owner,
      ...f.intent,
      replacementIntentDigest: f.targetDigest,
      productReference: id(5),
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
      permission: "catalog.manage",
      owningActions: ["catalog.product.history.read"],
      requiredFields: productPublicationSourceFieldsV2,
      observedAt: at,
    });
    await f.call(f.authority.variant.authority, {
      ...f.owner,
      ...f.intent,
      replacementIntentDigest: f.targetDigest,
      request: f.request,
      purposeCode: ack
        ? "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_QUALIFICATION_HISTORY_READ"
        : "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ",
      permission: "catalog.manage",
      owningAction: "catalog.product.history.read",
      requiredScope: "FullBrandScope",
      requiredFields: ack
        ? productWarningAcknowledgementQualificationHistoryFields
        : productPublicationQualificationHistoryFields,
      observedAt: at,
    });
    for (const tax of [false, true])
      await f.call(
        tax ? f.authority.tax.authority : f.authority.registeredContent.registryAuthority,
        {
          ...f.owner,
          ...f.intent,
          purposeCode: tax
            ? "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY"
            : "CATALOG_PRODUCT_CONTENT_REGISTRY",
          permission: "catalog.manage",
          action: tax ? "catalog.tax-classification.read" : "catalog.content-registry.read",
          registry: null,
          requiredFields: tax ? taxClassificationRegistryFields : contentRegistryFields,
          observedAt: at,
          ...(tax ? { mode: "Read" } : {}),
        },
      );
    const lease = await f.call(f.authority.options.authority, {
      ...f.owner,
      command: f.command,
      originalIntentDigest: hash(f.command),
      replacementIntentDigest: ack ? null : f.targetDigest,
      warningBindingDigest:
        ack && "warningBindingDigest" in f.command ? f.command.warningBindingDigest : null,
      requestObservedAt: at,
      requestValidUntil: until,
      purposeCode: f.command.purposeCode,
      permission: "catalog.manage",
      action: "catalog.option_set.read",
      requiredFields: productPublicationFrozenFullOptionSetContentFields,
      optionSetReference: id(50),
      versionReference: id(51),
      content: null,
      observedAt: at,
    });
    expect(lease).toEqual({ observedAt: at, validUntil: until });
    await f.finish();
    const actions = f.authorizeActions.mock.calls.flatMap(([v]) => [...v]);
    expect(actions).toEqual(
      expect.arrayContaining([
        "catalog.product.history.read",
        "catalog.tax-classification.read",
        "catalog.content-registry.read",
        "catalog.option_set.read",
      ]),
    );
  },
);

it("Store roster callback retains actual result and current native Product read permission", async () => {
  const f = fixture(),
    input = {
      ...f.intent,
      actorKind: "User" as const,
      replacementIntentDigest: f.targetDigest,
      request: {
        brandReference: id(2),
        actorReference: id(3),
        purposeCode: f.command.purposeCode,
        originalIntentDigest: hash(f.command),
        observedAt: at,
      },
    },
    result = { actual: "roster callback result" };
  expect(
    await f.authority.scope.tenantAuthority.withCurrentBrandReferenceRead(
      f.tx,
      input as never,
      async () => result,
    ),
  ).toBe(result);
  expect(await f.authority.scope.tenantAuthority.isCurrent(f.tx, input as never)).toBe(true);
  await f.finish();
});

it.each([false, true])(
  "binds all Catalog reference owner profiles to the actual request (Ack=%s)",
  async (ack) => {
    const f = fixture(ack),
      refs = ack ? f.authority.acknowledgementReferences : f.authority.publicationReferences,
      prefix = ack ? "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT" : "CATALOG_PRODUCT_PUBLICATION",
      cases = [
        [
          refs.historyAuthority,
          "REFERENCE_HISTORY_READ",
          ack
            ? productWarningAcknowledgementReferenceHistoryFields
            : productPublicationReferenceHistoryFieldsV2,
          true,
        ],
        [
          refs.menuAuthority,
          "MENU_SOURCE_READ",
          ack
            ? productWarningAcknowledgementMenuReferenceSourceFields
            : productPublicationMenuReferenceSourceFieldsV2,
          false,
        ],
        [
          refs.bundleAuthority,
          "BUNDLE_SOURCE_READ",
          ack
            ? productWarningAcknowledgementBundleReferenceSourceFields
            : productPublicationBundleReferenceSourceFieldsV2,
          false,
        ],
        [
          refs.availabilityAuthority,
          "AVAILABILITY_SOURCE_READ",
          ack
            ? productWarningAcknowledgementAvailabilityReferenceSourceFields
            : productPublicationAvailabilityReferenceSourceFieldsV2,
          false,
        ],
      ] as const;
    for (const [holder, suffix, requiredFields, history] of cases)
      await f.call(holder, {
        tenantReference: id(1),
        actorKind: "User",
        request: f.request,
        purposeCode: `${prefix}_${suffix}`,
        permission: "catalog.manage",
        requiredScope: "FullBrandScope",
        requiredFields,
        observedAt: at,
        ...(history
          ? {
              brandReference: id(2),
              actorReference: id(3),
              owningAction: "catalog.product.history.read",
            }
          : {}),
      });
    await f.finish();
    expect(f.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.product.history.read",
    ]);
  },
);

const crossProfiles = [
  [
    "recipeAuthority",
    "RecipeProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
    recipeProductPublicationReferenceSourceFieldsV2,
    ["recipe.manage"],
    false,
  ],
  [
    "recipeInventoryAuthority",
    "RecipeInventoryProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_RECIPE_INVENTORY_SOURCE_READ",
    recipeInventoryProductPublicationReferenceSourceFieldsV2,
    ["recipe.manage"],
    false,
  ],
  [
    "inventoryAuthority",
    "InventoryProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ",
    inventoryProductPublicationSkuMappingReferenceFieldsV2,
    inventoryConfigurationReferencePermissions,
    true,
  ],
  [
    "pricingAuthority",
    "PricingProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    productPublicationConfigurationReferenceSourceFieldsV2,
    ["pricing.price-book.manage", "pricing.promotion.manage"],
    true,
  ],
  [
    "priceBookAuthority",
    "PricingProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    productPublicationPriceBookReferenceSourceFieldsV2,
    ["pricing.price-book.manage"],
    false,
  ],
  [
    "optionPriceAuthority",
    "PricingProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    productPublicationOptionPriceReferenceSourceFieldsV2,
    ["pricing.price-book.manage"],
    false,
  ],
  [
    "promotionAuthority",
    "PricingProductPublicationReferenceRequestV2",
    "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
    productPublicationPromotionReferenceSourceFieldsV2,
    ["pricing.promotion.manage"],
    false,
  ],
] as const;
it.each(crossProfiles)(
  "requires owning grants rather than catalog.manage for %s",
  async (key, profile, purposeCode, requiredFields, permissions, multi) => {
    const f = fixture(),
      packet = {
        tenantReference: id(1),
        actorKind: "User",
        request: { ...f.common, profile, purposeCode },
        requiredFields,
        requiredScope: "FullBrandScope",
        observedAt: at,
        ...(key === "inventoryAuthority" ? {} : { purposeCode }),
        ...(multi ? { requiredPermissions: permissions } : { permission: permissions[0] }),
      };
    await f.call(f.authority.publicationReferences[key], packet);
    await f.finish();
    expect(
      f.authorizeActions.mock.calls.every(([actions]) => equalActions(actions, permissions)),
    ).toBe(true);
  },
);
function equalActions(a: readonly string[], b: readonly string[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

it("does not let cross-owner metadata hide a changed original operation or System actor", async () => {
  for (const change of [
    { operationReference: id(90) },
    { actorKind: "System" },
    { originalIntentDigest: hash("other") },
  ]) {
    const f = fixture(true);
    await expect(
      f.call(f.authority.acknowledgementReferences.recipeAuthority, {
        tenantReference: id(1),
        actorKind: "User",
        request: {
          ...f.common,
          ...change,
          profile: "RecipeProductPublicationReferenceRequestV2",
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
        },
        purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
        permission: "recipe.manage",
        requiredFields: recipeProductPublicationReferenceSourceFieldsV2,
        requiredScope: "FullBrandScope",
        observedAt: at,
      }),
    ).rejects.toHaveProperty("code", unavailable.code);
  }
});

it("holds exact publication action permissions including approval history without replay qualification", async () => {
  const f = fixture();
  await f.call(f.authority.publicationAuthority, {
    command: f.command,
    requiredPermissions: [
      "catalog.product.read",
      "catalog.product.validate",
      "catalog.product.history.read",
      "catalog.product.approval.read",
    ],
    requiredFields: productPublicationWriteFieldsV2,
    requiredScope: "FullBrandScope",
    observedAt: at,
  });
  await f.finish();
  expect(f.authorizeActions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.read",
    "catalog.product.validate",
    "catalog.product.history.read",
    "catalog.product.approval.read",
  ]);
});

it("holds independent Ack write/editor/history/report profiles with the unchanged root and original full command", async () => {
  const f = fixture(true),
    permissions = [
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.acknowledge-warnings",
      "catalog.product.read",
      "catalog.product.history.read",
    ];
  await f.call(f.authority.acknowledgementAuthority, {
    command: f.command,
    mode: "Replay",
    purposeCode: f.command.purposeCode,
    permission: "catalog.manage",
    requiredPermissions: permissions,
    requiredScope: "FullBrandScope",
    requiredFields: productPublicationWarningAcknowledgementFields,
    observedAt: at,
  });
  await f.call(f.authority.acknowledgementContentAuthority, {
    ...f.owner,
    productReference: id(5),
    purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
    permission: "catalog.manage",
    owningAction: "catalog.product.manage",
    requiredFields: productEditorSnapshotFields,
    observedAt: at,
  });
  await f.call(f.authority.acknowledgementHistoryAuthority, {
    ...f.owner,
    productReference: id(5),
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
    permission: "catalog.manage",
    owningActions: ["catalog.product.history.read"],
    requiredFields: productPublicationSourceFieldsV2,
    observedAt: at,
  });
  await f.call(f.authority.acknowledgementReportAuthority, {
    ...f.owner,
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 7,
    expectedPublicationVersion: 1,
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
    permission: "catalog.manage",
    owningActions: ["catalog.product.read", "catalog.product.history.read"],
    requiredScope: "FullBrandScope",
    requiredFields: productPublicationValidationReportReadFields,
    observedAt: at,
  });
  await f.finish();
  expect(f.authorizeActions).toHaveBeenCalledWith(permissions);
  expect(f.tx.query).not.toHaveBeenCalled();
});

it("cannot use an Ack profile for a publication or authorize another Product report", async () => {
  const f = fixture();
  await expect(
    f.call(f.authority.acknowledgementContentAuthority, {
      ...f.owner,
      productReference: id(5),
      purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
      permission: "catalog.manage",
      owningAction: "catalog.product.manage",
      requiredFields: productEditorSnapshotFields,
      observedAt: at,
    }),
  ).rejects.toHaveProperty("code", unavailable.code);
  const g = fixture(true);
  await expect(
    g.call(g.authority.acknowledgementReportAuthority, {
      ...g.owner,
      productReference: id(99),
      versionReference: id(6),
      expectedAggregateVersion: 7,
      expectedPublicationVersion: 1,
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
      permission: "catalog.manage",
      owningActions: ["catalog.product.read", "catalog.product.history.read"],
      requiredScope: "FullBrandScope",
      requiredFields: productPublicationValidationReportReadFields,
      observedAt: at,
    }),
  ).rejects.toHaveProperty("code", unavailable.code);
});
