import {
  type TaxRegistrantSourceOptions,
  type TaxRegistrantTransaction,
  taxRegistrantSourceRequiredFields,
} from "@bop/operating-entity";
import { beforeEach, expect, it, vi } from "vitest";
import { createFeatureControlAdministrationDefinition } from "@bop/feature-control";
import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex, validateAuditRecord } from "@bop/audit";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parseEvidenceReference,
  parseRoleReference,
  parsePolicyReference,
  parsePolicyVersion,
} from "@bop/permission";
import {
  parseCatalogTaxClassificationRegistryCommand,
  catalogTaxClassificationRegistryRequest,
  catalogTaxClassificationRegistryEventId,
} from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  createTaxConfigurationSnapshot,
  parsePricingCode,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringState,
  type TaxConfigurationSnapshot,
  taxConfigAuthoringIntentDigest,
  type TaxConfigAuthoringStoreOptions,
  type TaxConfigMaterialStoreOptions,
  type TaxConfigCandidateStoreOptions,
  createTaxPublicationCandidate,
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  taxConfigCandidateRequiredFields,
  taxConfigCandidateIntentDigest,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialOperation,
  taxConfigMaterialIntentDigest,
  taxConfigMaterialContentDigest,
  taxConfigMaterialRequiredFields,
  TaxConfigWorkflowError,
} from "@rms/pricing";
import {
  createMerchantTaxConfigAuthoring,
  type MerchantTaxConfigAuthoringOptions,
} from "./merchant-tax-config-authoring.js";
const boundary = vi.hoisted(() => ({
  store: vi.fn(),
  brand: vi.fn(),
  owner: vi.fn(),
  material: vi.fn(),
  candidate: vi.fn(),
  registrant: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => boundary.store }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => boundary.brand }));
vi.mock("@rms/pricing", async (original) => ({
  ...(await original<typeof import("@rms/pricing")>()),
  createPostgresTaxConfigAuthoringStore: boundary.owner,
  createPostgresTaxConfigMaterialStore: boundary.material,
  createPostgresTaxConfigCandidateStore: boundary.candidate,
}));
vi.mock("@bop/operating-entity", async (original) => ({
  ...(await original<typeof import("@bop/operating-entity")>()),
  createPostgresTaxRegistrantSource: boundary.registrant,
}));
// Controlled Session/selection and Pricing boundary. The actual Catalog registry
// reader, public Permission evaluator and real outer transaction host run here.
// Native acceptance is responsible for Session/IAM/Pricing persistence proof.
const id = (n: number) => `018ff820-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T14:00:00.000Z",
  until = "2026-10-05T14:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = {
  stableCode: "SYNTHETIC_TAX",
  effectivePeriod: {
    timeZone: "America/Toronto",
    effectiveFrom: {
      instant: "2026-10-01T04:00:00.000Z",
      localDateTime: "2026-10-01T00:00:00.000",
      utcOffsetMinutes: -240,
    },
    effectiveUntil: null,
  },
  rules: [
    {
      taxClassificationReference: id(8),
      orderType: "Pickup",
      chargeType: "Sellable",
      taxComponentCode: "SYNTHETIC_TAX",
      treatment: "Taxable",
      rate: "0.13",
      priceInclusion: "Exclusive",
      roundingMode: "HalfUp",
      calculationOrder: 1,
      compoundOnPriorTax: false,
      exceptionEvidenceReference: null,
      receiptPresentationCode: "SYNTHETIC_TAX",
    },
  ],
};
const command = () => ({
  action: "CreateDraft",
  operationReference: id(10),
  configurationReference: null,
  expectedAggregateVersion: null,
  content,
});
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  let clock = at,
    allow = true,
    registryAllow = true,
    short = until,
    serial = 100,
    ownerOptions: TaxConfigAuthoringStoreOptions | undefined;
  const events: string[] = [];
  const state = {
    historical: false,
    inactive: false,
    missingCount: false,
    mutateScope: false,
    withdrawAfterApply: false,
    featureDisabled: false,
    featureAbsent: false,
  };
  const brand = createBrand({
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Controlled Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    code: "TAX",
    displayName: "Controlled Store",
    locale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  function context() {
    const actor = {
      actorType: "User",
      actorReference: scope.actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as Parameters<typeof createTenantContext>[0];
    return createTenantContext(actor, brand, store, clock);
  }
  function decision(action: string, brandOnly = false) {
    const ctx = context(),
      actorReference = ctx.actor.actorReference;
    if (actorReference === null) throw new Error("Controlled Actor missing");
    return evaluatePermission({
      tenantContext: brandOnly ? createTenantContext(ctx.actor, brand, null, clock) : ctx,
      action: parseBusinessAction(action),
      resourceScope: {
        kind: brandOnly ? "Brand" : "Store",
        brandReference: brand.brandReference,
        storeReference: brandOnly ? null : store.storeReference,
      },
      policySnapshotReference: parsePolicyReference(id(20)),
      policyVersion: parsePolicyVersion(1),
      evidence: (brandOnly ? registryAllow : allow)
        ? [
            {
              source: "RolePermission",
              evidenceReference: parseEvidenceReference(id(21)),
              action: parseBusinessAction(action),
              actorReference,
              roleReference: parseRoleReference(id(22)),
              brandReference: brand.brandReference,
              storeReference: brandOnly ? null : store.storeReference,
              effectiveFrom: parseCanonicalInstant(at),
              effectiveUntil: null,
            },
          ]
        : [],
    });
  }
  boundary.store.mockImplementation(async (_tx, _cookie, action) => {
    events.push("store:" + action);
    const result = {
      selected: { tenantReference: scope.tenantReference },
      context: context(),
      store,
      actorReference: scope.actorReference,
      sessionReference: id(5),
      authorizeAction: vi.fn(async (requested) => {
        events.push(requested);
        const value = decision(requested);
        if (state.mutateScope) result.actorReference = id(99);
        return value;
      }),
      authorizationValidUntil: () => short,
    };
    return result;
  });
  boundary.brand.mockImplementation(async () => ({
    tenantReference: scope.tenantReference,
    selectedStoreReference: scope.storeReference,
    context: createTenantContext(context().actor, brand, null, clock),
    actorReference: scope.actorReference,
    authorizeActionsWithValidity: async (actions: readonly string[]) => {
      events.push("catalog-fine");
      return { decisions: actions.map((action) => decision(action, true)), validUntil: short };
    },
  }));
  const registry = () =>
    parseCatalogTaxClassificationRegistryCommand({
      purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: scope.actorReference,
      actorKind: "User",
      operationReference: id(30),
      expectedRegistryVersion: 0,
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
      registry: {
        profile: "CatalogProductTaxClassificationRegistryV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        registryReference: id(31),
        versionReference: id(32),
        registryVersion: 1,
        defaultLocale: "en-CA",
        previousSnapshotDigest: null,
        registeredAt: at,
        definitions: [
          {
            classificationReference: id(8),
            code: "SYNTHETIC_TAX",
            localizedNames: { "en-CA": "Controlled classification" },
            lifecycle: state.inactive ? "Inactive" : "Active",
          },
        ],
        defaultClassificationReference: state.inactive ? null : id(8),
      },
    });
  let savedSnapshot: TaxConfigurationSnapshot | null = null;
  const query = vi.fn(async (sql: string) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("AS complete")) rows = [{ complete: true }];
    else if (
      sql.includes("jsonb_build_object") &&
      sql.includes("bop_feature_control.control_version")
    )
      rows = state.featureAbsent
        ? []
        : [
            {
              recordedAt: at,
              dependencies: [],
              definition: createFeatureControlAdministrationDefinition({
                controlId: id(80),
                key: "pricing.taxconfig.authoring",
                description: "Synthetic Tax control",
                version: 1,
                ownerReference: id(81),
                purposeCode: "TAX_CONFIG",
                scope: {
                  kind: "Brand",
                  brandReference: scope.brandReference,
                  storeReference: null,
                },
                source: "BrandOverride",
                defaultValue: "Disabled",
                configuredValue: state.featureDisabled ? "Disabled" : "Enabled",
                lifecycle: "Published",
                temporary: false,
                effectiveFrom: at,
                effectiveUntil: null,
                reviewAt: "2026-10-06T14:00:00.000Z",
                expiresAt: null,
                dependencies: [],
                authoredByReference: id(81),
                approvedByReference: id(82),
                approvalEvidenceReference: id(83),
                publicationReference: id(84),
              }),
            },
          ];
    else if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
    else if (sql.includes("SELECT count(*)::text n")) rows = [{ n: "1", bytes: "4096" }];
    else if (sql.includes("command_json command")) {
      const c = registry();
      rows = [
        {
          command: catalogTaxClassificationRegistryRequest(c),
          registry: c.registry,
          intent_digest: c.intentDigest,
          snapshot_digest: c.snapshotDigest,
          event_id: catalogTaxClassificationRegistryEventId(c),
          coherent: true,
        },
      ];
    }
    return { rows, ...(state.missingCount ? {} : { rowCount: 1 }) };
  });
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    events.push("begin");
    try {
      const result = await work({ query });
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  });
  const options = {
    persistence: {
      now: () => clock,
      transactions: { run },
      identity: { hasher: {} },
      currentActor: async () => context().actor,
      validateAssociation: async () => true,
    },
    authentication: { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    nextReference: vi.fn(() => id(++serial)),
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: parsePricingReference(id(40)),
      metadataDigest: parsePricingDigest("sha256:" + "a".repeat(64)),
    }),
  } as unknown as MerchantTaxConfigAuthoringOptions;
  boundary.owner.mockImplementation((o: TaxConfigAuthoringStoreOptions) => {
    ownerOptions = o;
    let final = false;
    let guardWork = async () => {
      await hold("Read", null);
    };
    async function hold(
      mode: "Read" | "Write" | "Resolve",
      command: Parameters<
        TaxConfigAuthoringStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1]["command"],
    ) {
      return o.authority.holdUntilTransactionCompletes(o.transaction, {
        scope: o.scope,
        mode,
        permission: "pricing.tax-config.manage",
        purposeCode: "PRICING_TAX_CONFIG_AUTHORING",
        requiredFields: (await import("@rms/pricing")).taxConfigAuthoringRequiredFields,
        command,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
    }
    async function enter() {
      await o.registerBeforeCommit(
        o.transaction,
        async () => guardWork(),
        () => {
          final = true;
        },
      );
      await hold("Read", null);
      await o.transaction.query("SELECT 1", []);
    }
    async function apply(raw: unknown, resolve = false) {
      await enter();
      const p = await import("@rms/pricing");
      const c = resolve
        ? p.parseTaxConfigAuthoringResolve(raw)
        : p.parseTaxConfigAuthoringCommand(raw);
      const digest = resolve
        ? (c as ReturnType<typeof p.parseTaxConfigAuthoringResolve>).intentDigest
        : taxConfigAuthoringIntentDigest(scope, p.parseTaxConfigAuthoringCommand(c));
      if (resolve || state.historical) {
        return parseTaxConfigAuthoringOperation({
          profile: "TaxConfigAuthoringOperationV1",
          ...scope,
          action: c.action,
          operationReference: c.operationReference,
          configurationReference: c.configurationReference,
          expectedAggregateVersion: c.expectedAggregateVersion,
          command: null,
          intentDigest: digest,
          serviceIntentDigest: null,
          outcome: "Abandoned",
          snapshot: null,
          auditReference: id(70),
          eventReference: null,
          occurredAt: at,
        });
      }
      const parsed = p.parseTaxConfigAuthoringCommand(c);
      await hold("Write", parsed);
      const currency = await o.currency.readCurrent(o.transaction);
      const base = {
        configurationReference: parsePricingReference(o.references.generate("Configuration")),
        versionReference: parsePricingReference(o.references.generate("Version")),
        brandReference: parsePricingReference(scope.brandReference),
        storeReference: parsePricingReference(scope.storeReference),
        stableCode: parsed.content.stableCode,
        aggregateVersion: 1,
        versionNumber: 1,
        lifecycle: "Draft" as const,
        jurisdictionCode: parsePricingCode("CA-ON"),
        currencyMetadata: currency,
        effectivePeriod: parsed.content.effectivePeriod,
        registrationEvidence: null,
        professionalEvidence: null,
        rules: parsed.content.rules.map((rule) => ({
          ruleReference: parsePricingReference(o.references.generate("Rule")),
          ...rule,
        })),
        createdAt: at,
      };
      const snapshot = createTaxConfigurationSnapshot({
        ...base,
        snapshotDigest: parsePricingDigest(hash(base)),
      });
      savedSnapshot = snapshot;
      await o.facts.validateDraft(o.transaction, {
        command: parsed,
        snapshot,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
      guardWork = async () => {
        await hold("Write", parsed);
        await o.facts.validateDraft(o.transaction, {
          command: parsed,
          snapshot,
          observedAt: o.clock.now(),
          validUntil: o.originalValidUntil,
        });
      };
      const audit = o.audit.create({
        scope: o.scope,
        command: parsed,
        mode: "Write",
        auditReference: o.references.generate("Audit"),
        configurationReference: snapshot.configurationReference,
        intentDigest: digest,
        occurredAt: at,
      });
      validateAuditRecord(audit, Date.parse(at));
      if (state.withdrawAfterApply) allow = false;
      return parseTaxConfigAuthoringOperation({
        profile: "TaxConfigAuthoringOperationV1",
        ...scope,
        action: parsed.action,
        operationReference: parsed.operationReference,
        configurationReference: null,
        expectedAggregateVersion: null,
        command: parsed,
        intentDigest: digest,
        serviceIntentDigest: "sha256:" + "b".repeat(64),
        outcome: "Committed",
        snapshot,
        auditReference: audit.auditId,
        eventReference: id(71),
        occurredAt: at,
      });
    }
    return {
      execute: (c: unknown) => apply(c),
      resolve: (c: unknown) => apply(c, true),
      async readCurrent(ref: unknown) {
        await enter();
        return parseTaxConfigAuthoringCurrent({
          profile: "TaxConfigAuthoringCurrentV1",
          ...scope,
          configurationReference: ref,
          state:
            savedSnapshot && ref === savedSnapshot.configurationReference
              ? parseTaxConfigAuthoringState({
                  profile: "TaxConfigAuthoringStateV1",
                  tenantReference: scope.tenantReference,
                  brandReference: scope.brandReference,
                  storeReference: scope.storeReference,
                  draftAuthorActorReference: scope.actorReference,
                  snapshot: savedSnapshot,
                })
              : null,
          observedAt: at,
          validUntil: o.originalValidUntil,
          referenceEligibility: "NotEvaluated",
        });
      },
      async readRoster(after: unknown) {
        await enter();
        return parseTaxConfigAuthoringRoster({
          profile: "TaxConfigAuthoringRosterV1",
          ...scope,
          afterConfiguration: after,
          entries: [],
          nextAfterConfiguration: null,
          observedAt: at,
          validUntil: o.originalValidUntil,
          referenceEligibility: "NotEvaluated",
        });
      },
      assertFinalized() {
        expect(events).toContain("commit");
        if (!final) throw new Error("Missing real final hook");
        return o.originalValidUntil;
      },
    };
  });
  const service = createMerchantTaxConfigAuthoring(options);
  return {
    service,
    options,
    state,
    events,
    query,
    owner: () => ownerOptions,
    deny: () => {
      allow = false;
    },
    denyRegistry: () => {
      registryAllow = false;
    },
    shorten: () => {
      short = "2026-10-05T14:00:01.000Z";
    },
    setClock: (value: string) => {
      clock = value;
    },
  };
}
const request = () => ({
  sessionCookie: "c".repeat(43),
  csrf: "s".repeat(43),
  expectedScope: scope,
  command: command(),
});
it("acquires genuine fine decisions and an actual Catalog registry for fresh Draft rules including final reread", async () => {
  const f = fixture();
  const result = await f.service.execute(request());
  expect(result.outcome).toBe("Committed");
  expect(f.events.filter((e) => e === "catalog-fine").length).toBeGreaterThan(2);
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("product_tax_classification_registry_record")),
  ).toBe(true);
  expect(f.events.at(-1)).toBe("commit");
});
it("reads current and roster without configuring CurrencyMetadata or allocating identities", async () => {
  const f = fixture();
  const { currencyMetadata: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  const service = createMerchantTaxConfigAuthoring(options);
  expect(
    (
      await service.current({
        sessionCookie: "c",
        expectedStoreReference: scope.storeReference,
        configurationReference: null,
      })
    ).profile,
  ).toBe("TaxConfigAuthoringCurrentV1");
  expect(
    (
      await service.roster({
        sessionCookie: "c",
        expectedStoreReference: scope.storeReference,
        afterConfiguration: null,
      })
    ).profile,
  ).toBe("TaxConfigAuthoringRosterV1");
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("recovers payload-free originals without today currency or Catalog qualification", async () => {
  const f = fixture();
  const { currencyMetadata: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  const service = createMerchantTaxConfigAuthoring(options);
  const result = await service.resolve({
    ...request(),
    command: {
      action: "CreateDraft",
      operationReference: id(10),
      configurationReference: null,
      expectedAggregateVersion: null,
      intentDigest: taxConfigAuthoringIntentDigest(scope, command()),
    },
  });
  expect(result.outcome).toBe("Abandoned");
  expect(f.events).not.toContain("catalog-fine");
  expect(options.nextReference).not.toHaveBeenCalled();
});
it("refuses missing fresh Currency metadata without fabricating CAD", async () => {
  const f = fixture();
  const { currencyMetadata: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  await expect(createMerchantTaxConfigAuthoring(options).execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
  });
  expect(options.nextReference).not.toHaveBeenCalled();
});
it("refuses an actual inactive Catalog classification", async () => {
  const f = fixture();
  f.state.inactive = true;
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_INPUT_INVALID",
  });
  expect(f.events).toContain("rollback");
});
it("requires actual Catalog coarse and fine permission for a fresh write", async () => {
  const f = fixture();
  f.denyRegistry();
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(f.events).toContain("rollback");
});
it("denies Tax authority before invoking the owning store", async () => {
  const f = fixture();
  f.deny();
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(boundary.owner).not.toHaveBeenCalled();
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("compares the actual selected Store and Actor with the original intent scope", async () => {
  const f = fixture();
  await expect(
    f.service.execute({ ...request(), expectedScope: { ...scope, actorReference: id(99) } }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(boundary.owner).not.toHaveBeenCalled();
});
it("rejects scope mutation during an awaited fine permission read", async () => {
  const f = fixture();
  f.state.mutateScope = true;
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("retains the shortest real Session/policy lease in readonly output", async () => {
  const f = fixture();
  f.shorten();
  const result = await f.service.current({
    sessionCookie: "c",
    expectedStoreReference: scope.storeReference,
    configurationReference: null,
    expectedScope: scope,
  });
  expect(result.validUntil).toBe("2026-10-05T14:00:01.000Z");
});
it("validates GET actual scope and Store before returning a packet", async () => {
  const f = fixture();
  await expect(
    f.service.current({
      sessionCookie: "c",
      expectedStoreReference: id(99),
      configurationReference: null,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
});
it("does not invent rowCount for a malformed real transport", async () => {
  const f = fixture();
  f.state.missingCount = true;
  await expect(
    f.service.current({
      sessionCookie: "c",
      expectedStoreReference: scope.storeReference,
      configurationReference: null,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toContain("rollback");
});
it("requires real CSRF authentication before authoring source acquisition", async () => {
  const f = fixture();
  vi.mocked(f.options.authentication.authorize).mockRejectedValueOnce(
    new BrowserSessionError("BROWSER_SESSION_DENIED"),
  );
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(boundary.store).not.toHaveBeenCalled();
});
it("rejects captured source port replacement before another request", async () => {
  const f = fixture();
  Object.defineProperty(f.options, "nextReference", { value: () => id(99) });
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
  });
});

it("rolls back a tentative fresh write when real fine authority withdraws before COMMIT", async () => {
  const f = fixture();
  f.state.withdrawAfterApply = true;
  await expect(f.service.execute(request())).rejects.toMatchObject({
    code: "TAX_CONFIG_PERMISSION_DENIED",
  });
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});

it("returns actual registry definitions with truthful lifecycle and retained real child guards", async () => {
  const f = fixture();
  f.state.inactive = true;
  const result = await f.service.classifications({
    sessionCookie: "synthetic-cookie",
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
  });
  expect(result.choices).toEqual([
    {
      classificationReference: id(8),
      code: "SYNTHETIC_TAX",
      localizedNames: { "en-CA": "Controlled classification" },
      lifecycle: "Inactive",
    },
  ]);
  expect(result.sourceQualification).toBe("NotEvaluated");
  expect(f.query.mock.calls.filter(([sql]) => sql.includes("command_json command")).length).toBe(1);
  // The owner holds the Brand history lock; its one-shot child guard refreshes
  // real Catalog authority, rather than rereading immutable history.
  expect(f.events.filter((event) => event === "catalog-fine").length).toBeGreaterThan(1);
  expect(f.events).toContain("commit");
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("denies classification reading without actual Catalog fine authority", async () => {
  const f = fixture();
  f.denyRegistry();
  await expect(
    f.service.classifications({
      sessionCookie: "synthetic-cookie",
      expectedStoreReference: scope.storeReference,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
const basketFixture = () => ({
  profile: "TaxDraftFixtureV1",
  fixtureReference: id(90),
  kind: "Basket",
  evaluatedAt: at,
  lines: [
    {
      lineReference: id(91),
      calculationReferences: [id(92)],
      labelCode: "MEAL",
      taxClassificationReference: id(8),
      orderType: "Pickup",
      chargeType: "Sellable",
      amountMinor: "100",
    },
  ],
});
it("simulates only the exact saved Draft mechanically with no writes, allocation or approved-suite claims", async () => {
  const f = fixture();
  const saved = await f.service.execute(request());
  const snapshot = saved.snapshot;
  if (!snapshot) throw new Error("Missing controlled saved Draft");
  vi.mocked(f.options.nextReference).mockClear();
  f.events.length = 0;
  const result = await f.service.simulate({
    sessionCookie: "synthetic-cookie",
    csrf: "csrf",
    expectedScope: scope,
    command: {
      configurationReference: snapshot.configurationReference,
      expectedVersionReference: snapshot.versionReference,
      expectedSnapshotDigest: snapshot.snapshotDigest,
      fixture: basketFixture(),
    },
  });
  expect(result.simulation.netAmountMinor).toBe("100");
  expect(result.simulation.taxAmountMinor).toBe("13");
  expect(result.simulation.grossAmountMinor).toBe("113");
  expect(result.simulation.professionalReviewStatus).toBe("NotEvaluated");
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(f.options.nextReference).not.toHaveBeenCalled();
  expect(f.events).toContain("commit");
});
it("rejects stale saved version and malformed mechanical inputs without creating another operation", async () => {
  const f = fixture();
  const saved = await f.service.execute(request());
  const snapshot = saved.snapshot;
  if (!snapshot) throw new Error("Missing Draft");
  vi.mocked(f.options.nextReference).mockClear();
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "csrf",
    expectedScope: scope,
    command: {
      configurationReference: snapshot.configurationReference,
      expectedVersionReference: id(99),
      expectedSnapshotDigest: snapshot.snapshotDigest,
      fixture: basketFixture(),
    },
  };
  await expect(f.service.simulate(input)).rejects.toMatchObject({
    code: "TAX_CONFIG_VERSION_CONFLICT",
  });
  await expect(
    f.service.simulate({
      ...input,
      command: {
        ...input.command,
        expectedVersionReference: snapshot.versionReference,
        fixture: { ...basketFixture(), fixtureSuiteReference: id(98) },
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("requires an actual current Feature definition for read and original recovery", async () => {
  const f = fixture();
  f.state.featureAbsent = true;
  await expect(
    f.service.current({
      sessionCookie: "synthetic-cookie",
      expectedStoreReference: scope.storeReference,
      configurationReference: null,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
  expect(boundary.owner).not.toHaveBeenCalled();
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("refuses actual Disabled Tax control before owner or allocation", async () => {
  const f = fixture();
  f.state.featureDisabled = true;
  await expect(f.service.execute(request())).rejects.toMatchObject({
    name: "MerchantTaxConfigFeatureDisabled",
  });
  expect(boundary.owner).not.toHaveBeenCalled();
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("retains saved mechanical simulation when today's optional CurrencyMetadata is unconfigured", async () => {
  const f = fixture();
  const saved = await f.service.execute(request());
  const snapshot = saved.snapshot;
  if (!snapshot) throw new Error("Missing Draft");
  const { currencyMetadata: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  const service = createMerchantTaxConfigAuthoring(options);
  vi.mocked(f.options.nextReference).mockClear();
  const result = await service.simulate({
    sessionCookie: "synthetic-cookie",
    csrf: "csrf",
    expectedScope: scope,
    command: {
      configurationReference: snapshot.configurationReference,
      expectedVersionReference: snapshot.versionReference,
      expectedSnapshotDigest: snapshot.snapshotDigest,
      fixture: basketFixture(),
    },
  });
  expect(result.simulation.grossAmountMinor).toBe("113");
  expect(f.options.nextReference).not.toHaveBeenCalled();
});
it("refuses unsupported fixture coverage rather than reporting professional validity", async () => {
  const f = fixture();
  const saved = await f.service.execute(request());
  const snapshot = saved.snapshot;
  if (!snapshot) throw new Error("Missing Draft");
  vi.mocked(f.options.nextReference).mockClear();
  const fixtureInput = basketFixture();
  const line = fixtureInput.lines[0];
  if (!line) throw new Error("Missing line");
  line.taxClassificationReference = id(99);
  await expect(
    f.service.simulate({
      sessionCookie: "synthetic-cookie",
      csrf: "csrf",
      expectedScope: scope,
      command: {
        configurationReference: snapshot.configurationReference,
        expectedVersionReference: snapshot.versionReference,
        expectedSnapshotDigest: snapshot.snapshotDigest,
        fixture: fixtureInput,
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
  expect(f.options.nextReference).not.toHaveBeenCalled();
});

// Material and TaxRegistrant transports below model their exact real callback
// lifetimes/final hooks. Their public parsers and Permission evaluator are real;
// this component suite is not persisted source or native IAM evidence.
function materialFixture() {
  const f = fixture();
  let profileReference = id(101),
    nullSource = false,
    denyOrg = false;
  let saved: ReturnType<typeof parseTaxConfigMaterialOperation> | undefined;
  const materialOperations = new Map<string, ReturnType<typeof parseTaxConfigMaterialOperation>>();
  const materialVersions = new Map<string, ReturnType<typeof parseTaxConfigMaterialVersion>>();
  const baseStore = boundary.store.getMockImplementation();
  if (!baseStore) throw Error("missing Store source");
  boundary.store.mockImplementation(async (...args) => {
    const current = await baseStore(...args);
    const authorize = current.authorizeAction;
    current.authorizeAction = async (action: string) => {
      if (action === "organization.manage" && denyOrg)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
      return authorize(action);
    };
    return current;
  });
  boundary.registrant.mockImplementation((o: TaxRegistrantSourceOptions) => {
    let tx: TaxRegistrantTransaction | undefined;
    let registered = false,
      final = false,
      checking = false;
    const initialProfile = profileReference;
    async function hold() {
      if (!tx) throw Error("missing source tx");
      const packet = await o.authority.holdUntilTransactionCompletes(tx, {
        ...scope,
        actorKind: "User",
        permission: "organization.manage",
        purposeCode: "TAX_REGISTRANT_SOURCE",
        businessFunction: "TaxRegistrant",
        effectiveAt: at,
        requiredFields: taxRegistrantSourceRequiredFields,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
      expect(packet.permission.action).toBe("organization.manage");
    }
    return {
      async resolve(input: { transaction: NonNullable<typeof tx>; effectiveAt: string }) {
        if (checking) throw Error("public read after own guard");
        tx = input.transaction;
        if (!registered) {
          await o.registerBeforeCommit(
            tx,
            async () => {
              checking = true;
              await hold();
              if (profileReference !== initialProfile)
                throw new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
            },
            () => {
              final = true;
            },
          );
          registered = true;
        }
        await hold();
        return nullSource
          ? null
          : Object.freeze({
              profile: "TaxRegistrantCurrentSourceV1",
              ...scope,
              businessFunction: "TaxRegistrant",
              effectiveAt: at,
              assignmentReference: id(102),
              assignmentVersion: 1,
              effectiveFrom: at,
              effectiveUntil: null,
              operatingEntityReference: id(103),
              entityVersion: 2,
              operatingEntityProfileVersionReference: profileReference,
              profileVersion: 1,
              legalName: "Synthetic entity",
              jurisdictionCode: "CA-ON",
              registrationReference: id(104),
              taxRegistrationReference: null,
              observedAt: at,
              validUntil: o.originalValidUntil,
              qualification: "NotEvaluated",
            });
      },
      assertFinalized(actual: NonNullable<typeof tx>) {
        expect(actual).toBe(tx);
        expect(f.events).toContain("commit");
        if (!final) throw Error("missing source final");
        return o.originalValidUntil;
      },
    };
  });
  boundary.material.mockImplementation((o: TaxConfigMaterialStoreOptions) => {
    let final = false,
      registered = false,
      checking = false;
    let validate: () => Promise<void> = async () => {
      /* no fresh write observed */
    };
    async function hold(
      mode: "Read" | "Write" | "Resolve",
      command: Parameters<
        TaxConfigMaterialStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1]["command"],
    ) {
      return o.authority.holdUntilTransactionCompletes(o.transaction, {
        scope: o.scope,
        mode,
        permission: "pricing.tax-config.manage",
        purposeCode: "PRICING_TAX_CONFIG_MATERIAL",
        requiredFields: taxConfigMaterialRequiredFields,
        command,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
    }
    async function enter() {
      if (checking) throw Error("read after own guard");
      if (!registered) {
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            checking = true;
            await validate();
            await hold("Read", null);
          },
          () => {
            final = true;
          },
        );
        registered = true;
      }
      await hold("Read", null);
    }
    async function apply(raw: unknown, resolve = false) {
      await enter();
      const command = resolve
        ? parseTaxConfigMaterialResolve(raw)
        : parseTaxConfigMaterialCommand(raw);
      const intent = resolve
        ? parseTaxConfigMaterialResolve(raw).intentDigest
        : taxConfigMaterialIntentDigest(scope, parseTaxConfigMaterialCommand(raw));
      const prior = materialOperations.get(command.operationReference);
      if (prior) {
        expect(intent).toBe(prior.intentDigest);
        return prior;
      }
      const { action, operationReference, materialReference, expectedRevision, materialKind } =
        command;
      const pins = {
        action,
        operationReference,
        materialReference,
        expectedRevision,
        materialKind,
      };
      await hold(resolve ? "Resolve" : "Write", pins);
      if (resolve) {
        const audit = o.audit.create({
          scope: o.scope,
          command: pins,
          mode: "Abandon",
          auditReference: o.references.generate("Audit"),
          materialReference: null,
          intentDigest: intent,
          occurredAt: at,
        });
        return parseTaxConfigMaterialOperation({
          profile: "TaxConfigMaterialOperationV1",
          ...scope,
          ...pins,
          command: null,
          intentDigest: intent,
          outcome: "Abandoned",
          version: null,
          auditReference: audit.auditId,
          eventReference: null,
          occurredAt: at,
        });
      }
      const c = parseTaxConfigMaterialCommand(raw);
      const version = parseTaxConfigMaterialVersion({
        profile: "TaxConfigMaterialVersionV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        materialReference: o.references.generate("Material"),
        versionReference: o.references.generate("Version"),
        revision: 1,
        previousVersionReference: null,
        materialKind: c.materialKind,
        content: c.content,
        contentDigest: taxConfigMaterialContentDigest(c.content, c.materialKind),
        recordedByActorReference: scope.actorReference,
        createdAt: at,
        recordedAt: at,
        dataClassification: "Confidential",
        status: "Recorded",
        qualification: "NotEvaluated",
      });
      validate = () =>
        o.facts.validateMaterial(o.transaction, {
          command: c,
          version,
          observedAt: o.clock.now(),
          validUntil: o.originalValidUntil,
        });
      await validate();
      const audit = o.audit.create({
        scope: o.scope,
        command: pins,
        mode: "Write",
        auditReference: o.references.generate("Audit"),
        materialReference: version.materialReference,
        intentDigest: intent,
        occurredAt: at,
      });
      validateAuditRecord(audit, Date.parse(at));
      saved = parseTaxConfigMaterialOperation({
        profile: "TaxConfigMaterialOperationV1",
        ...scope,
        ...pins,
        command: c,
        intentDigest: intent,
        outcome: "Committed",
        version,
        auditReference: audit.auditId,
        eventReference: o.references.generate("Event"),
        occurredAt: at,
      });
      materialOperations.set(saved.operationReference, saved);
      materialVersions.set(version.versionReference, version);
      return saved;
    }
    return {
      execute: (c: unknown) => apply(c),
      resolveOriginal: (c: unknown) => apply(c, true),
      async readCurrent(value: unknown) {
        await enter();
        const r = value as {
          materialKind: "RegistrationApplicability";
          materialReference: string | null;
        };
        return parseTaxConfigMaterialCurrent({
          profile: "TaxConfigMaterialCurrentV1",
          ...scope,
          materialKind: r.materialKind,
          materialReference: r.materialReference,
          version: saved?.version ?? null,
          observedAt: at,
          validUntil: o.originalValidUntil,
          qualification: "NotEvaluated",
        });
      },
      async readVersion(value: unknown) {
        await enter();
        const r = value as { materialKind: "RegistrationApplicability"; versionReference: string };
        const version = materialVersions.get(r.versionReference);
        if (!version || version.materialKind !== r.materialKind)
          throw new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
        return parseTaxConfigMaterialCurrent({
          profile: "TaxConfigMaterialCurrentV1",
          ...scope,
          materialKind: r.materialKind,
          materialReference: version.materialReference,
          version,
          observedAt: at,
          validUntil: o.originalValidUntil,
          qualification: "NotEvaluated",
        });
      },
      async readRoster(value: unknown) {
        await enter();
        const r = value as {
          materialKind: "RegistrationApplicability";
          afterMaterial: string | null;
        };
        return parseTaxConfigMaterialRoster({
          profile: "TaxConfigMaterialRosterV1",
          ...scope,
          materialKind: r.materialKind,
          afterMaterial: r.afterMaterial,
          entries: [],
          nextAfterMaterial: null,
          observedAt: at,
          validUntil: o.originalValidUntil,
          qualification: "NotEvaluated",
        });
      },
      assertFinalized() {
        expect(f.events).toContain("commit");
        if (!final) throw Error("missing source final");
        return o.originalValidUntil;
      },
    };
  });
  const registration = () => ({
    action: "CreateMaterial",
    operationReference: id(110),
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content: {
      operatingEntityProfileVersionReference: id(101),
      operatingEntityTaxReference: null,
      jurisdictionCode: "CA-ON",
      applicability: "NotApplicable",
      sourceIssuedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      declaredSourceDigest: null,
    },
  });
  return {
    ...f,
    registration,
    removeMaterialVersion: (ref: string) => {
      materialVersions.delete(ref);
    },
    replaceMaterialVersion: (value: unknown) => {
      const v = parseTaxConfigMaterialVersion(value);
      materialVersions.set(v.versionReference, v);
    },
    denyOrg: () => {
      denyOrg = true;
    },
    changeProfile: () => {
      profileReference = id(199);
    },
    absent: () => {
      nullSource = true;
    },
  };
}
it("records real registration source pins with null tax reference and finalizes both owners after COMMIT", async () => {
  const f = materialFixture();
  const receipt = await f.service.materialExecute({ ...request(), command: f.registration() });
  expect(receipt.outcome).toBe("Committed");
  expect(receipt.version?.content).toMatchObject({ operatingEntityTaxReference: null });
  expect(f.events).toContain("organization.manage");
  expect(boundary.owner).not.toHaveBeenCalled();
  const read = {
    sessionCookie: request().sessionCookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
  };
  const current = await f.service.materialCurrent({
    ...read,
    materialKind: "RegistrationApplicability",
    materialReference: receipt.version?.materialReference,
  });
  expect(current.version).toEqual(receipt.version);
  const historical = await f.service.materialVersion({
    ...read,
    materialKind: "RegistrationApplicability",
    versionReference: receipt.version?.versionReference,
  });
  expect(historical.version).toEqual(receipt.version);
  const roster = await f.service.materialRoster({
    ...read,
    materialKind: "RegistrationApplicability",
    afterMaterial: null,
  });
  expect(roster.qualification).toBe("NotEvaluated");
});
it("requires organization.manage only for real registration source qualification, not historical original recovery", async () => {
  const f = materialFixture();
  await f.service.materialExecute({ ...request(), command: f.registration() });
  f.denyOrg();
  boundary.registrant.mockClear();
  const c = parseTaxConfigMaterialCommand(f.registration());
  const receipt = await f.service.materialResolve({
    ...request(),
    command: {
      action: c.action,
      operationReference: c.operationReference,
      materialReference: c.materialReference,
      expectedRevision: c.expectedRevision,
      materialKind: c.materialKind,
      intentDigest: taxConfigMaterialIntentDigest(scope, c),
    },
  });
  expect(receipt.outcome).toBe("Committed");
  expect(boundary.registrant).not.toHaveBeenCalled();
  const denied = materialFixture();
  denied.denyOrg();
  await expect(
    denied.service.materialExecute({ ...request(), command: denied.registration() }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(denied.events).toContain("rollback");
});
it("refuses forged source pins and true source absence without turning NotApplicable into a waiver", async () => {
  for (const absent of [false, true]) {
    const f = materialFixture();
    if (absent) f.absent();
    else f.changeProfile();
    await expect(
      f.service.materialExecute({ ...request(), command: f.registration() }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
    expect(f.events).toContain("rollback");
  }
});
it("reads true registration source under separate owner permission and scoped guards", async () => {
  const f = materialFixture();
  const result = await f.service.taxRegistrant({
    sessionCookie: request().sessionCookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
  });
  expect(result?.qualification).toBe("NotEvaluated");
  expect(result?.taxRegistrationReference).toBeNull();
  expect(boundary.material).not.toHaveBeenCalled();
  const denied = materialFixture();
  denied.denyOrg();
  await expect(
    denied.service.taxRegistrant({
      sessionCookie: request().sessionCookie,
      expectedStoreReference: scope.storeReference,
      expectedScope: scope,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
});
it("keeps registration freshness and late Tax permission guards active until rollback", async () => {
  const drift = materialFixture();
  let allocations = 0;
  const driftReference = () => {
    allocations++;
    if (allocations === 3) drift.changeProfile();
    return id(220 + allocations);
  };
  // The source captures this selected generator before dispatch. The third ID is
  // Audit, after initial source qualification but before the real final guards.
  const service = createMerchantTaxConfigAuthoring({
    ...drift.options,
    nextReference: driftReference,
  });
  await expect(
    service.materialExecute({ ...request(), command: drift.registration() }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  expect(drift.events).toContain("rollback");
  const withdrawn = materialFixture();
  let generated = 0;
  const withdrawnReference = () => {
    generated++;
    if (generated === 3) withdrawn.deny();
    return id(250 + generated);
  };
  const withdrawingService = createMerchantTaxConfigAuthoring({
    ...withdrawn.options,
    nextReference: withdrawnReference,
  });
  await expect(
    withdrawingService.materialExecute({ ...request(), command: withdrawn.registration() }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(withdrawn.events).toContain("rollback");
});
it("refuses a declared professional report without its actual recorded FixtureSuite source", async () => {
  const f = materialFixture();
  const target = { versionReference: id(150), contentDigest: hash("candidate") };
  await expect(
    f.service.materialExecute({
      ...request(),
      command: {
        ...f.registration(),
        materialKind: "ProfessionalReport",
        content: {
          targetPublicationCandidate: target,
          registrationMaterial: target,
          fixtureSuiteMaterial: target,
          declaredIssuer: {
            displayName: "Synthetic external declaration",
            organizationName: null,
            credentialIdentifier: null,
          },
          reviewedAt: at,
          validUntil: until,
          declaredConclusion: "Pass",
          declaredSourceDigest: null,
        },
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  expect(f.events).toContain("rollback");
  expect(boundary.registrant).not.toHaveBeenCalled();
});
it("fences material scope and closed body before any owner or source read", async () => {
  const f = materialFixture();
  await expect(
    f.service.materialExecute({
      ...request(),
      expectedScope: { ...scope, storeReference: id(199) },
      command: f.registration(),
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(boundary.material).not.toHaveBeenCalled();
  const malformed = materialFixture();
  await expect(
    malformed.service.materialExecute({
      ...request(),
      command: { ...malformed.registration(), actorReference: id(199) },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
  expect(malformed.query).not.toHaveBeenCalled();
  expect(boundary.material).not.toHaveBeenCalled();
});

// Controlled candidate boundary exercises the real common Session/Feature/IAM
// host and captured child options. Owner/native tests prove persistence itself.
function candidateBoundary(
  f: ReturnType<typeof fixture>,
  result: ReturnType<typeof parseTaxConfigCandidateOperation> | null = null,
) {
  const state: { drift: boolean; beforeGuard: () => void; events: string[] } = {
    drift: false,
    beforeGuard: vi.fn<() => void>(),
    events: [],
  };
  boundary.candidate.mockImplementation((o: TaxConfigCandidateStoreOptions) => {
    for (const child of [o.draftSource, o.materialSource]) {
      expect(child.transaction).toBe(o.transaction);
      expect(child.scope).toBe(o.scope);
      expect(child.clock).toBe(o.clock);
      expect(child.registerBeforeCommit).toBe(o.registerBeforeCommit);
      expect(child.originalObservedAt).toBe(o.originalObservedAt);
      expect(child.originalValidUntil).toBe(o.originalValidUntil);
    }
    let registered = false,
      final = false;
    let pins: ReturnType<typeof parseTaxConfigCandidateCommand> | null = null;
    async function hold(mode: "Read" | "Write" | "Resolve") {
      return o.authority.holdUntilTransactionCompletes(o.transaction, {
        scope: o.scope,
        mode,
        permission: "pricing.tax-config.manage",
        purposeCode: "PRICING_TAX_CONFIG_CANDIDATE",
        requiredFields: taxConfigCandidateRequiredFields,
        command: pins,
        observedAt: o.clock.now(),
        validUntil: o.originalValidUntil,
      });
    }
    async function enter() {
      if (final) throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
      if (!registered) {
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            state.beforeGuard();
            await hold("Read");
            if (state.drift) throw new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
            state.events.push("source-fresh");
          },
          () => {
            final = true;
            state.events.push("source-final");
          },
        );
        registered = true;
      }
      await hold("Read");
    }
    async function apply(raw: unknown, resolving: boolean) {
      const c = resolving
        ? parseTaxConfigCandidateResolve(raw)
        : parseTaxConfigCandidateCommand(raw);
      pins = parseTaxConfigCandidateCommand({
        action: c.action,
        operationReference: c.operationReference,
        configurationReference: c.configurationReference,
        expectedDraft: c.expectedDraft,
        registrationMaterial: c.registrationMaterial,
      });
      await enter();
      if (result) return parseTaxConfigCandidateOperation(result);
      await hold("Resolve");
      const audit = o.audit.create({
        scope: o.scope,
        command: pins,
        mode: "Abandon",
        auditReference: o.references.generate("Audit"),
        targetVersionReference: null,
        intentDigest: taxConfigCandidateIntentDigest(o.scope, pins),
        occurredAt: o.clock.now(),
      });
      expect(audit.dataClassification).toBe("Confidential");
      expect(audit.actionCode).toBe("PRICING_TAX_CANDIDATE_RESOLVE");
      return parseTaxConfigCandidateOperation({
        profile: "TaxConfigCandidateOperationV1",
        ...o.scope,
        ...pins,
        command: null,
        intentDigest: taxConfigCandidateIntentDigest(o.scope, pins),
        outcome: "Abandoned",
        result: null,
        auditReference: audit.auditId,
        eventReference: null,
        occurredAt: audit.occurredAt,
      });
    }
    return {
      prepare: (v: unknown) => apply(v, false),
      resolveOriginal: (v: unknown) => apply(v, true),
      async readCurrent(v: unknown) {
        await enter();
        const r = v as { configurationReference: string; targetVersionReference: string | null };
        if (
          (result?.result &&
            result.result.candidate.content.configurationReference !== r.configurationReference) ||
          (!result?.result && r.targetVersionReference !== null)
        )
          throw new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
        return parseTaxConfigCandidateCurrent({
          profile: "TaxConfigCandidateCurrentV1",
          ...o.scope,
          ...r,
          targetVersionReference:
            result?.result?.candidate.content.targetVersionReference ?? r.targetVersionReference,
          record: result?.result ?? null,
          observedAt: o.clock.now(),
          validUntil: o.originalValidUntil,
          qualification: "NotEvaluated",
        });
      },
      async readRoster(v: unknown) {
        await enter();
        const r = v as { configurationReference: string; afterCandidate: null };
        return parseTaxConfigCandidateRoster({
          profile: "TaxConfigCandidateRosterV1",
          ...o.scope,
          ...r,
          entries: [],
          nextAfterCandidate: null,
          observedAt: o.clock.now(),
          validUntil: o.originalValidUntil,
          qualification: "NotEvaluated",
        });
      },
      assertFinalized() {
        expect(f.events).toContain("commit");
        if (!final) throw Error("candidate not finalized");
        state.events.push("post-commit-finalized");
        return o.originalValidUntil;
      },
    };
  });
  return state;
}
const candidateCommand = () =>
  parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(300),
    configurationReference: id(301),
    expectedDraft: {
      versionReference: id(302),
      snapshotDigest: hash("draft"),
      aggregateVersion: 1,
      versionNumber: 1,
    },
    registrationMaterial: {
      materialReference: id(303),
      versionReference: id(304),
      contentDigest: hash("registration"),
    },
  });
it("reads candidate current/roster under real Tax authority without today's Currency or Org source", async () => {
  const f = fixture(),
    s = candidateBoundary(f);
  const { currencyMetadata: ignoredCurrency, ...options } = f.options;
  void ignoredCurrency;
  const service = createMerchantTaxConfigAuthoring(options);
  const input = {
    sessionCookie: request().sessionCookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
    configurationReference: id(301),
  };
  expect(
    (await service.candidateCurrent({ ...input, targetVersionReference: null })).record,
  ).toBeNull();
  expect((await service.candidateRoster({ ...input, afterCandidate: null })).entries).toEqual([]);
  expect(boundary.registrant).not.toHaveBeenCalled();
  expect(boundary.owner).not.toHaveBeenCalled();
  expect(boundary.material).not.toHaveBeenCalled();
  expect(s.events).toContain("post-commit-finalized");
});
it("resolves candidate absence with original pins and Confidential Audit, no current registration qualification", async () => {
  const f = fixture();
  candidateBoundary(f);
  const c = candidateCommand();
  const result = await f.service.candidateResolve({
    ...request(),
    command: { ...c, intentDigest: taxConfigCandidateIntentDigest(scope, c) },
  });
  expect(result.outcome).toBe("Abandoned");
  expect(result.command).toBeNull();
  expect(result.registrationMaterial).toEqual(c.registrationMaterial);
  expect(boundary.registrant).not.toHaveBeenCalled();
  expect(boundary.owner).not.toHaveBeenCalled();
});
it("prepares a stored-Draft candidate and returns parsed immutable actual source pins after outer COMMIT", async () => {
  const f = materialFixture();
  const saved = await f.service.execute(request());
  const material = await f.service.materialExecute({ ...request(), command: f.registration() });
  if (!saved.snapshot || !material.version) throw Error("missing controlled owner sources");
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: scope.actorReference,
    snapshot: saved.snapshot,
  });
  const registration = {
    materialReference: material.version.materialReference,
    versionReference: material.version.versionReference,
    contentDigest: material.version.contentDigest,
  };
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(400),
    sourceRuleBindings: saved.snapshot.rules.map((r, i) => ({
      sourceRuleReference: r.ruleReference,
      targetRuleReference: id(410 + i),
    })),
    registrationMaterial: registration,
  });
  const command = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(401),
    configurationReference: saved.snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial: registration,
  });
  const record = createTaxConfigCandidateRecord({
    scope,
    command,
    candidate,
    draft,
    registrationMaterial: material.version,
    preparedAt: at,
    auditReference: id(402),
    eventReference: id(403),
  });
  const original = parseTaxConfigCandidateOperation({
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command,
    intentDigest: taxConfigCandidateIntentDigest(scope, command),
    outcome: "Committed",
    result: record,
    auditReference: record.auditReference,
    eventReference: record.eventReference,
    occurredAt: at,
  });
  const s = candidateBoundary(f, original);
  f.denyOrg();
  const result = await f.service.candidatePrepare({ ...request(), command });
  expect(result).toEqual(original);
  const latest = await f.service.candidateCurrent({
    sessionCookie: request().sessionCookie,
    expectedStoreReference: scope.storeReference,
    expectedScope: scope,
    configurationReference: command.configurationReference,
    targetVersionReference: null,
  });
  expect(latest.record).toEqual(record);
  expect(latest.targetVersionReference).toBe(candidate.content.targetVersionReference);
  await expect(
    f.service.candidateCurrent({
      sessionCookie: request().sessionCookie,
      expectedStoreReference: scope.storeReference,
      expectedScope: scope,
      configurationReference: command.configurationReference,
      targetVersionReference: id(499),
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
  expect(result.result?.qualification).toBe("NotEvaluated");
  expect(s.events.at(-1)).toBe("post-commit-finalized");
});
it("late actual Tax authority withdrawal rolls back candidate without a successful terminal reply", async () => {
  const f = fixture();
  const s = candidateBoundary(f);
  s.beforeGuard = f.deny;
  await expect(
    f.service.candidateResolve({
      ...request(),
      command: {
        ...candidateCommand(),
        intentDigest: taxConfigCandidateIntentDigest(scope, candidateCommand()),
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(f.events).toContain("rollback");
  expect(f.events).not.toContain("commit");
});
it("whole saved-source drift during candidate final revalidation rolls back", async () => {
  const f = fixture();
  const s = candidateBoundary(f);
  s.drift = true;
  await expect(
    f.service.candidateCurrent({
      sessionCookie: request().sessionCookie,
      expectedStoreReference: scope.storeReference,
      expectedScope: scope,
      configurationReference: id(301),
      targetVersionReference: null,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  expect(f.events).toContain("rollback");
});
it("candidate commands reject caller qualification/Actor injection and mismatched selected scope before owner work", async () => {
  const f = fixture();
  candidateBoundary(f);
  await expect(
    f.service.candidatePrepare({
      ...request(),
      command: { ...candidateCommand(), actorReference: id(999) },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
  expect(boundary.candidate).not.toHaveBeenCalled();
  await expect(
    f.service.candidatePrepare({
      ...request(),
      expectedScope: { ...scope, storeReference: id(998) },
      command: candidateCommand(),
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(boundary.candidate).not.toHaveBeenCalled();
});

async function candidateMaterialFixture() {
  const f = materialFixture(),
    saved = await f.service.execute(request()),
    registrationReceipt = await f.service.materialExecute({
      ...request(),
      command: f.registration(),
    });
  if (!saved.snapshot || !registrationReceipt.version)
    throw Error("Missing real parsed source packets");
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: scope.actorReference,
    snapshot: saved.snapshot,
  });
  const registration = registrationReceipt.version,
    registrationPin = {
      materialReference: registration.materialReference,
      versionReference: registration.versionReference,
      contentDigest: registration.contentDigest,
    };
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(500),
    sourceRuleBindings: draft.snapshot.rules.map((r, i) => ({
      sourceRuleReference: r.ruleReference,
      targetRuleReference: id(510 + i),
    })),
    registrationMaterial: registrationPin,
  });
  const command = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(501),
    configurationReference: draft.snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial: registrationPin,
  });
  const record = createTaxConfigCandidateRecord({
    scope,
    command,
    candidate,
    draft,
    registrationMaterial: registration,
    preparedAt: at,
    auditReference: id(502),
    eventReference: id(503),
  });
  const operation = parseTaxConfigCandidateOperation({
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command,
    intentDigest: taxConfigCandidateIntentDigest(scope, command),
    outcome: "Committed",
    result: record,
    auditReference: record.auditReference,
    eventReference: record.eventReference,
    occurredAt: at,
  });
  const source = candidateBoundary(f, operation),
    target = {
      versionReference: candidate.content.targetVersionReference,
      contentDigest: candidate.contentDigest,
    };
  const rule = candidate.content.rules[0];
  if (!rule) throw Error("Missing candidate rule");
  const suite = () =>
    parseTaxConfigMaterialCommand({
      action: "CreateMaterial",
      operationReference: id(520),
      materialReference: null,
      expectedRevision: null,
      materialKind: "FixtureSuite",
      content: {
        targetPublicationCandidate: target,
        currencyMetadata: candidate.content.currencyMetadata,
        cases: [
          {
            fixture: {
              profile: "TaxDraftFixtureV1",
              fixtureReference: id(521),
              kind: "Basket",
              evaluatedAt: at,
              lines: [
                {
                  lineReference: id(522),
                  calculationReferences: [id(523)],
                  labelCode: "INTERNAL_TEST",
                  taxClassificationReference: rule.taxClassificationReference,
                  orderType: rule.orderType,
                  chargeType: rule.chargeType,
                  amountMinor: "1000",
                },
              ],
            },
            expected: {
              fixtureReference: id(521),
              kind: "Basket",
              configurationReference: candidate.content.configurationReference,
              versionReference: target.versionReference,
              snapshotDigest: target.contentDigest,
              netAmountMinor: "1000",
              taxAmountMinor: "130",
              grossAmountMinor: "1130",
              receiptPreview: [
                {
                  lineReference: id(522),
                  labelCode: "INTERNAL_TEST",
                  componentCode: rule.taxComponentCode,
                  treatment: rule.treatment,
                  rate: rule.rate,
                  taxAmountMinor: "130",
                },
              ],
            },
          },
        ],
        sourceIssuedAt: at,
        declaredSourceDigest: null,
      },
    });
  const report = (suiteVersion: ReturnType<typeof parseTaxConfigMaterialVersion>) =>
    parseTaxConfigMaterialCommand({
      action: "CreateMaterial",
      operationReference: id(530),
      materialReference: null,
      expectedRevision: null,
      materialKind: "ProfessionalReport",
      content: {
        targetPublicationCandidate: target,
        registrationMaterial: {
          versionReference: registration.versionReference,
          contentDigest: registration.contentDigest,
        },
        fixtureSuiteMaterial: {
          versionReference: suiteVersion.versionReference,
          contentDigest: suiteVersion.contentDigest,
        },
        declaredIssuer: {
          displayName: "Declared reviewer",
          organizationName: null,
          credentialIdentifier: null,
        },
        reviewedAt: at,
        validUntil: "2026-10-06T14:00:00.000Z",
        declaredConclusion: "Pass",
        declaredSourceDigest: null,
      },
    });
  return { ...f, source, candidate, registration, suite, report };
}
it("records candidate-bound FixtureSuite and declared ProfessionalReport from actual immutable source packets without qualification", async () => {
  const f = await candidateMaterialFixture();
  f.denyOrg();
  const suite = await f.service.materialExecute({ ...request(), command: f.suite() });
  if (!suite.version) throw Error("Missing recorded Suite");
  expect(suite.version.materialKind).toBe("FixtureSuite");
  expect(suite.version.qualification).toBe("NotEvaluated");
  const report = await f.service.materialExecute({
    ...request(),
    command: f.report(suite.version),
  });
  expect(report.version?.materialKind).toBe("ProfessionalReport");
  expect(report.version?.qualification).toBe("NotEvaluated");
  expect(report.version?.content).toHaveProperty("declaredConclusion", "Pass");
  expect(f.source.events).toContain("source-fresh");
  expect(f.source.events).toContain("source-final");
  expect(f.source.events).toContain("post-commit-finalized");
});
it("rejects missing candidate, candidate digest drift, currency mismatch and every fixture's wrong configuration", async () => {
  const f = await candidateMaterialFixture(),
    good = f.suite();
  if (!("cases" in good.content)) throw Error("Missing Suite content");
  await expect(
    f.service.materialExecute({
      ...request(),
      command: {
        ...good,
        content: {
          ...good.content,
          targetPublicationCandidate: {
            ...good.content.targetPublicationCandidate,
            contentDigest: hash("wrong"),
          },
          cases: good.content.cases.map((c) => ({
            ...c,
            expected: { ...c.expected, snapshotDigest: hash("wrong") },
          })),
        },
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  const metadata = createCurrencyMetadataSnapshot({
    ...good.content.currencyMetadata,
    metadataVersion: good.content.currencyMetadata.metadataVersion + 1,
  });
  await expect(
    f.service.materialExecute({
      ...request(),
      command: { ...good, content: { ...good.content, currencyMetadata: metadata } },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  const first = good.content.cases[0];
  if (!first) throw Error("Missing Suite case");
  await expect(
    f.service.materialExecute({
      ...request(),
      command: {
        ...good,
        content: {
          ...good.content,
          cases: [{ ...first, expected: { ...first.expected, configurationReference: id(999) } }],
        },
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
});
it("requires exact immutable Suite and Registration hashes and candidate registration identity for a report", async () => {
  const f = await candidateMaterialFixture(),
    suite = await f.service.materialExecute({ ...request(), command: f.suite() });
  if (!suite.version) throw Error("Missing Suite");
  const report = f.report(suite.version);
  if (!("fixtureSuiteMaterial" in report.content)) throw Error("Missing report");
  for (const field of ["fixtureSuiteMaterial", "registrationMaterial"] as const) {
    await expect(
      f.service.materialExecute({
        ...request(),
        command: {
          ...report,
          content: {
            ...report.content,
            [field]: { ...report.content[field], contentDigest: hash("wrong") },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  }
  f.removeMaterialVersion(suite.version.versionReference);
  await expect(f.service.materialExecute({ ...request(), command: report })).rejects.toMatchObject({
    code: "TAX_CONFIG_VERSION_CONFLICT",
  });
});
it("retains original material recovery without today's candidate facts and refuses late candidate source drift", async () => {
  const f = await candidateMaterialFixture(),
    command = f.suite(),
    receipt = await f.service.materialExecute({ ...request(), command });
  f.source.drift = true;
  expect(await f.service.materialExecute({ ...request(), command })).toEqual(receipt);
  const next = { ...command, operationReference: id(540) };
  await expect(f.service.materialExecute({ ...request(), command: next })).rejects.toMatchObject({
    code: "TAX_CONFIG_VERSION_CONFLICT",
  });
});

it("refuses actual fine withdrawal at consumed candidate checks and missing selected candidate before a material terminal reply", async () => {
  const f = await candidateMaterialFixture();
  f.source.beforeGuard = () => f.deny();
  await expect(
    f.service.materialExecute({ ...request(), command: f.suite() }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  const absent = await candidateMaterialFixture();
  candidateBoundary(absent, null);
  await expect(
    absent.service.materialExecute({ ...request(), command: absent.suite() }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
});

async function materialComparisonFixture(wrongAmounts = false, wrongReceipt = false) {
  const f = await candidateMaterialFixture(),
    original = f.suite();
  if (!("cases" in original.content)) throw Error("Missing controlled Suite");
  const content = wrongAmounts
    ? {
        ...original.content,
        cases: original.content.cases.map((row) => ({
          ...row,
          expected: {
            ...row.expected,
            taxAmountMinor: "131",
            grossAmountMinor: "1131",
            receiptPreview: row.expected.receiptPreview.map((component) => ({
              ...component,
              taxAmountMinor: "131",
            })),
          },
        })),
      }
    : wrongReceipt
      ? {
          ...original.content,
          cases: original.content.cases.map((row) => ({
            ...row,
            expected: {
              ...row.expected,
              receiptPreview: row.expected.receiptPreview.map((component) => ({
                ...component,
                rate: "0.14",
              })),
            },
          })),
        }
      : original.content;
  const receipt = await f.service.materialExecute({
    ...request(),
    command: { ...original, content },
  });
  if (!receipt.version) throw Error("Missing saved controlled Suite version");
  const compare = {
    configurationReference: f.candidate.content.configurationReference,
    targetPublicationCandidate: {
      versionReference: f.candidate.content.targetVersionReference,
      contentDigest: f.candidate.contentDigest,
    },
    fixtureSuiteMaterial: {
      materialReference: receipt.version.materialReference,
      versionReference: receipt.version.versionReference,
      contentDigest: receipt.version.contentDigest,
    },
  };
  return { ...f, compare, suiteVersion: receipt.version };
}
it("compares exact historical Suite and Candidate after real host final guards without today's Currency or Org qualification", async () => {
  const f = await materialComparisonFixture();
  f.denyOrg();
  const { currencyMetadata: omitted, ...options } = f.options;
  expect(omitted).toBeDefined();
  const service = createMerchantTaxConfigAuthoring(options),
    allocated = vi.mocked(f.options.nextReference).mock.calls.length;
  boundary.registrant.mockClear();
  const result = await service.materialCompare({ ...request(), command: f.compare });
  expect(result.profile).toBe("TaxConfigMaterialComparisonV1");
  expect(result.comparison.allCasesMatched).toBe(true);
  expect(result.comparison.cases[0]?.matches).toBe(true);
  expect(result.comparison.suite).toEqual(f.compare.fixtureSuiteMaterial);
  expect(result.comparison.candidate).toEqual(f.compare.targetPublicationCandidate);
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(boundary.registrant).not.toHaveBeenCalled();
  expect(vi.mocked(f.options.nextReference).mock.calls.length).toBe(allocated);
  expect(f.source.events.at(-1)).toBe("post-commit-finalized");
});
it("returns a typed nonmatch for mechanically wrong but coherent stored expected amounts", async () => {
  const f = await materialComparisonFixture(true);
  const result = await f.service.materialCompare({ ...request(), command: f.compare });
  expect(result.comparison.allCasesMatched).toBe(false);
  expect(result.comparison.cases[0]?.mismatchedFields).toEqual([
    "taxAmountMinor",
    "grossAmountMinor",
    "receiptPreview",
  ]);
  expect(result.comparison.cases[0]?.actualDigest).not.toBe(
    result.comparison.cases[0]?.expectedDigest,
  );
  expect(result.comparison.professionalReviewStatus).toBe("NotEvaluated");
});
it("returns receipt component differences without asserting professional or legal qualification", async () => {
  const f = await materialComparisonFixture(false, true);
  const result = await f.service.materialCompare({ ...request(), command: f.compare });
  expect(result.comparison.cases[0]?.mismatchedFields).toEqual(["receiptPreview"]);
  expect(result.comparison.legalConclusion).toBe("NotEvaluated");
});
it("refuses incorrect Suite root/hash/kind, Candidate configuration/hash and missing immutable source pins", async () => {
  const f = await materialComparisonFixture();
  for (const changed of [
    {
      ...f.compare,
      fixtureSuiteMaterial: { ...f.compare.fixtureSuiteMaterial, materialReference: id(999) },
    },
    {
      ...f.compare,
      fixtureSuiteMaterial: {
        ...f.compare.fixtureSuiteMaterial,
        contentDigest: hash("wrong Suite"),
      },
    },
    {
      ...f.compare,
      fixtureSuiteMaterial: {
        materialReference: f.registration.materialReference,
        versionReference: f.registration.versionReference,
        contentDigest: f.registration.contentDigest,
      },
    },
    {
      ...f.compare,
      fixtureSuiteMaterial: { ...f.compare.fixtureSuiteMaterial, versionReference: id(998) },
    },
    { ...f.compare, configurationReference: id(997) },
    {
      ...f.compare,
      targetPublicationCandidate: {
        ...f.compare.targetPublicationCandidate,
        contentDigest: hash("wrong Candidate"),
      },
    },
  ])
    await expect(
      f.service.materialCompare({ ...request(), command: changed }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
});
it("requires actual current authority and scope before Suite comparison and retains short leases", async () => {
  const f = await materialComparisonFixture();
  await expect(
    f.service.materialCompare({
      ...request(),
      expectedScope: { ...scope, actorReference: id(999) },
      command: f.compare,
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  f.shorten();
  const result = await f.service.materialCompare({ ...request(), command: f.compare });
  expect(result.validUntil).toBe("2026-10-05T14:00:01.000Z");
  f.deny();
  await expect(
    f.service.materialCompare({ ...request(), command: f.compare }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
});
it("refuses late candidate provenance drift and late actual Tax withdrawal before returning comparison", async () => {
  const changed = await materialComparisonFixture();
  changed.source.drift = true;
  await expect(
    changed.service.materialCompare({ ...request(), command: changed.compare }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
  expect(changed.events.at(-1)).toBe("rollback");
  const denied = await materialComparisonFixture();
  denied.source.beforeGuard = denied.deny;
  await expect(
    denied.service.materialCompare({ ...request(), command: denied.compare }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  expect(denied.events.at(-1)).toBe("rollback");
});
it("refuses full immutable Suite currency drift instead of substituting current metadata", async () => {
  const f = await materialComparisonFixture(),
    version = f.suiteVersion;
  if (!("cases" in version.content)) throw Error("Missing controlled Suite");
  const content = {
    ...version.content,
    currencyMetadata: {
      ...version.content.currencyMetadata,
      metadataVersion: version.content.currencyMetadata.metadataVersion + 1,
    },
  };
  const changed = parseTaxConfigMaterialVersion({
    ...version,
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "FixtureSuite"),
  });
  f.replaceMaterialVersion(changed);
  await expect(
    f.service.materialCompare({
      ...request(),
      command: {
        ...f.compare,
        fixtureSuiteMaterial: {
          ...f.compare.fixtureSuiteMaterial,
          contentDigest: changed.contentDigest,
        },
      },
    }),
  ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
});
