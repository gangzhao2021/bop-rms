import { beforeEach, expect, it, vi } from "vitest";
import {
  createIdentityActor,
  createAuthenticationSession,
  parseSessionReference,
} from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  materializeOptionPriceVersion,
  optionPriceIntentDigest,
  optionPriceWireSnapshot,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  parsePricingReference,
  parseCurrencyCode,
  parsePricingDigest,
  OptionPriceAuthoringError,
  optionPriceAuthoringFields,
  type OptionPriceAuthoringStoreOptions,
  type OptionPriceAuthoringState,
  type OptionPriceAuthoringOperation,
} from "@rms/pricing";
import {
  createMerchantOptionPriceAuthoringCommand,
  type MerchantOptionPriceAuthoringCommandOptions,
} from "./merchant-option-price-authoring-command.js";
import type {
  MerchantOptionPriceContext,
  MerchantOptionPriceContextOptions,
  MerchantOptionPriceContextRequest,
} from "./merchant-option-price-context.js";
import type { MerchantOptionPricePublicationAuthorityOptions } from "./merchant-option-price-publication-authority.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

// Controlled public acquisition/command seams with genuine outer transaction
// guards and owning parsers. Not native IAM, approval, SQL or durable evidence.
const ports = vi.hoisted(() => ({
  brand: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  owner: vi.fn(),
  context: vi.fn(),
  publication: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => ports.brand }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => ports.store }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => ports.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => ports.capability(o),
}));
vi.mock("./merchant-option-price-context.js", () => ({
  createMerchantOptionPriceContextSource: (o: unknown) => ports.context(o),
}));
vi.mock("./merchant-option-price-publication-authority.js", () => ({
  createMerchantOptionPricePublicationAuthority: (o: unknown) => ports.publication(o),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresTransactionCurrentPermissionPolicySource: (tx: unknown) => ports.permission(tx),
}));
vi.mock("@rms/pricing", async (original) => ({
  ...(await original<typeof import("@rms/pricing")>()),
  createPostgresOptionPriceAuthoringStore: (o: unknown) => ports.owner(o),
}));
const id = (n: number) => "01902421-7970-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  after = (n: number) => new Date(Date.parse(at) + n).toISOString(),
  until = after(5000),
  digest = "sha256:" + "a".repeat(64);
const currency = createCurrencyMetadataSnapshot({
  currencyCode: parseCurrencyCode("CAD"),
  minorUnitExponent: 2,
  metadataVersion: 1,
  metadataVersionReference: parsePricingReference(id(8)),
  metadataDigest: parsePricingDigest(digest),
});
const create = () =>
  parseOptionPriceAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(20),
    ruleReference: id(21),
    expectedAggregateVersion: null,
    bindingReference: id(22),
    optionReference: id(23),
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  });
const initialState = (published = false) => {
  const command = create(),
    draft = materializeOptionPriceVersion({
      command,
      current: null,
      brandReference: id(2),
      versionReference: id(24),
      occurredAt: at,
      currencyMetadata: currency,
    }),
    state = parseOptionPriceAuthoringState({
      profile: "OptionPriceAuthoringStateV1",
      brandReference: id(2),
      ruleReference: id(21),
      bindingReference: id(22),
      optionReference: id(23),
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(4),
      updatedAt: at,
      draftAuthorActorReference: id(4),
      draft: optionPriceWireSnapshot(draft),
      currentPublished: null,
      latestVersion: optionPriceWireSnapshot(draft),
    });
  if (!published) return state;
  const next = materializeOptionPriceVersion({
    command: parseOptionPriceAuthoringCommand({
      ...command,
      action: "Publish",
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    }),
    current: state,
    brandReference: id(2),
    versionReference: id(25),
    occurredAt: at,
    currencyMetadata: currency,
  });
  return parseOptionPriceAuthoringState({
    ...state,
    aggregateVersion: 2,
    draftAuthorActorReference: null,
    draft: null,
    currentPublished: optionPriceWireSnapshot(next),
    latestVersion: optionPriceWireSnapshot(next),
  });
};
beforeEach(() => vi.clearAllMocks());
function fixture(action: "CreateDraft" | "ReplaceDraft" | "Publish" | "Archive" = "CreateDraft") {
  const state = {
    now: at,
    denied: false,
    disabled: false,
    shortLease: until,
    replay: false,
    abandon: false,
    wrongScope: false,
    badOwnerTuple: false,
    noFinal: false,
    unknown: false,
    lateDenied: false,
    contextCalls: 0,
    listEmpty: false,
    listForeign: false,
  };
  const events: string[] = [],
    base = create(),
    currentState = action === "CreateDraft" ? null : initialState(action === "Archive"),
    command = parseOptionPriceAuthoringCommand(
      action === "CreateDraft"
        ? base
        : {
            ...base,
            action,
            expectedAggregateVersion: currentState?.aggregateVersion,
            bindingReference: null,
            optionReference: null,
            content: action === "ReplaceDraft" ? base.content : null,
          },
    ),
    actor = createIdentityActor({
      actorType: "User",
      actorReference: id(4),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    brand = createBrand({
      brandReference: id(2),
      code: "SYNTHETIC",
      displayName: "Synthetic",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    store = createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "STORE",
      displayName: "Synthetic",
      timeZone: "UTC",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    tenantContext = createTenantContext(actor, brand, store, at),
    tx = { query: vi.fn(async (): Promise<unknown> => ({ rows: [], rowCount: 0 })) };
  const session = createAuthenticationSession({
    sessionReference: id(5),
    actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: after(1800000),
    absoluteExpiresAt: after(43200000),
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const brandScope = {
    tenantReference: id(1),
    context: createTenantContext(actor, brand, null, at),
    actorReference: id(4),
    selectedStoreReference: id(3),
  };
  ports.brand.mockImplementation(async () => brandScope);
  ports.store.mockImplementation(async () => ({
    selected: { tenantReference: id(1) },
    context: tenantContext,
    store,
    actorReference: state.wrongScope ? id(99) : id(4),
    sessionReference: parseSessionReference(id(5)),
  }));
  ports.permission.mockReturnValue({
    authorize: vi.fn(),
    authorizeWithRoles: vi.fn(),
    authorizeActionsWithRoles: vi.fn(),
  });
  const check = () => {
    if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return parseCatalogInstant(state.now);
  };
  const current = {
    assertCurrent: vi.fn(check),
    leaseDeadline: () => state.shortLease,
    authorizeActions: vi.fn(async (actions: readonly string[]) => {
      expect(actions).toEqual(["pricing.price-book.manage"]);
      check();
      events.push("IAM");
      return undefined;
    }),
    withCurrentStoreScope: vi.fn(),
  };
  const capability = {
    leaseDeadline: () => state.shortLease,
    holdUntilCommit: vi.fn(async () => {
      check();
      if (state.disabled) throw new MerchantProductWriteFeatureDisabled();
      events.push("Feature");
      return undefined;
    }),
  };
  ports.current.mockReturnValue(current);
  ports.capability.mockReturnValue(capability);
  let ownerFinal = false,
    contextFinal = false,
    publicationFinal = false;
  const actualContext: MerchantOptionPriceContext = {
    profile: "MerchantOptionPriceContextV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    productReference: id(30),
    productAggregateVersion: 2,
    productVersionReference: id(31),
    productSnapshotDigest: digest,
    binding: {
      bindingReference: parseCatalogReference(id(22)),
      optionSetReference: parseCatalogReference(id(32)),
      optionSetVersionReference: parseCatalogReference(id(33)),
      purpose: parseCatalogCode("EXTRAS"),
      sortOrder: 0,
      enabledOptionReferences: [parseCatalogReference(id(23))],
      defaultSelections: [],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
    versionResolution: "CurrentPublished",
    optionReference: id(23),
    optionSetReference: id(32),
    optionSetVersionReference: id(33),
    optionSourceDigest: digest,
    optionSourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic" },
    choices: [
      {
        optionReference: id(23),
        stableCode: "CHOICE",
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic" },
      },
    ],
    skus: [],
    currencyMetadata: currency,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    observedAt: at,
    validUntil: until,
  };
  ports.context.mockImplementation((o: MerchantOptionPriceContextOptions) => ({
    async withCurrentContext<T>(
      actual: Parameters<OptionPriceAuthoringStoreOptions["registerBeforeCommit"]>[0],
      anchor: MerchantOptionPriceContextRequest,
      work: (context: MerchantOptionPriceContext) => Promise<T>,
    ) {
      expect(actual).toBe(o.transaction);
      expect(anchor).toMatchObject({
        productReference: id(30),
        expectedProductAggregateVersion: 2,
        bindingReference: id(22),
        optionReference: id(23),
      });
      state.contextCalls++;
      events.push("Catalog");
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          check();
          events.push("CatalogGuard");
          if (state.lateDenied) state.denied = true;
        },
        () => {
          contextFinal = true;
        },
      );
      return work(actualContext);
    },
    assertFinalized() {
      expect(contextFinal).toBe(true);
      return state.shortLease;
    },
  }));
  ports.publication.mockImplementation((o: MerchantOptionPricePublicationAuthorityOptions) => ({
    async withCurrentAuthorization<T>(
      actual: Parameters<OptionPriceAuthoringStoreOptions["registerBeforeCommit"]>[0],
      input: Parameters<
        NonNullable<
          OptionPriceAuthoringStoreOptions["publicationSource"]
        >["withCurrentAuthorization"]
      >[1],
      work: (packet: import("@rms/pricing").OptionPricePublicationAuthorization) => Promise<T>,
    ) {
      expect(actual).toBe(o.transaction);
      expect(input.originalObservedAt).toBe(at);
      events.push("Publishing");
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          check();
          return undefined;
        },
        () => {
          publicationFinal = true;
        },
      );
      if (!input.state.draft || !input.state.draftAuthorActorReference)
        throw new Error("Fixture lacks original Draft");
      return work({
        policy: {
          profile: "PublishingOptionPricePublicationPolicyV1",
          tenantReference: id(1),
          brandReference: id(2),
          familyReference: id(7),
          policyReference: id(9),
          policyVersion: 1,
          approvalPolicy: "NotRequired",
          effectiveFrom: at,
          effectiveUntil: null,
        },
        currentPolicyPublicationReference: id(10),
        draftVersionReference: input.state.draft.versionReference,
        draftSnapshotDigest: input.state.draft.snapshotDigest,
        draftAuthorActorReference: input.state.draftAuthorActorReference,
        approvalEvidenceReference: null,
        approvedActorReference: null,
        observedAt: at,
        validUntil: state.shortLease,
      });
    },
    assertFinalized() {
      expect(publicationFinal).toBe(true);
      return state.shortLease;
    },
  }));
  let actualOwner: OptionPriceAuthoringStoreOptions | undefined;
  ports.owner.mockImplementation((o: OptionPriceAuthoringStoreOptions) => {
    actualOwner = o;
    const hold = (mode: "Read" | "Write" | "Resolve", snapshot: OptionPriceAuthoringState | null) =>
      o.authority.holdUntilTransactionCompletes(o.transaction, {
        tenantReference: id(1),
        brandReference: id(2),
        selectedStoreReference: id(3),
        actorReference: id(4),
        permission: "pricing.price-book.manage",
        purposeCode: "PRICING_OPTION_PRICE_AUTHORING",
        requiredFields: optionPriceAuthoringFields,
        mode,
        command,
        state: snapshot,
        observedAt: state.now,
        originalObservedAt: at,
        originalValidUntil: until,
      });
    const operation = (
      snapshot: OptionPriceAuthoringState | null,
    ): OptionPriceAuthoringOperation => ({
      profile: "OptionPriceAuthoringOperationV1",
      tenantReference: parsePricingReference(id(1)),
      brandReference: parsePricingReference(id(2)),
      actorReference: parsePricingReference(state.badOwnerTuple ? id(99) : id(4)),
      command,
      intentDigest: optionPriceIntentDigest(command),
      outcome: snapshot ? "Committed" : "Abandoned",
      state: snapshot,
      auditReference: parsePricingReference(id(40)),
      eventReference: snapshot ? parsePricingReference(id(41)) : null,
      occurredAt: at,
    });
    const finish = async (snapshot: OptionPriceAuthoringState | null) => {
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          await hold("Read", snapshot);
        },
        () => {
          ownerFinal = !state.noFinal;
        },
      );
      return operation(snapshot);
    };
    const mutate = async () => {
      if (state.unknown) throw new Error("private fixture input must not echo");
      await hold("Read", null);
      events.push("OriginalRead");
      if (state.replay) return finish(initialState());
      await hold("Write", currentState);
      const write = async () => {
        events.push("PricingWrite");
        const version = materializeOptionPriceVersion({
          command,
          current: currentState,
          brandReference: id(2),
          versionReference: id(42),
          occurredAt: at,
          currencyMetadata: currency,
        });
        const snapshot = parseOptionPriceAuthoringState({
          profile: "OptionPriceAuthoringStateV1",
          brandReference: id(2),
          ruleReference: id(21),
          bindingReference: id(22),
          optionReference: id(23),
          aggregateVersion: (currentState?.aggregateVersion ?? 0) + 1,
          createdAt: at,
          createdByActorReference: id(4),
          updatedAt: at,
          draftAuthorActorReference:
            command.action === "CreateDraft" || command.action === "ReplaceDraft" ? id(4) : null,
          draft:
            command.action === "CreateDraft" || command.action === "ReplaceDraft"
              ? optionPriceWireSnapshot(version)
              : null,
          currentPublished: command.action === "Publish" ? optionPriceWireSnapshot(version) : null,
          latestVersion: optionPriceWireSnapshot(version),
        });
        const audit = o.audit.create({
          auditReference: id(40),
          command,
          actorReference: id(4),
          brandReference: id(2),
          occurredAt: at,
          mode: "Write",
        });
        expect(audit).toMatchObject({
          brandId: id(2),
          actor: { type: "User", reference: id(4) },
          correlationId: id(20),
          actionCode: "PRICING_OPTION_PRICE_" + action.toUpperCase(),
          occurredAt: at,
        });
        return finish(snapshot);
      };
      if (action === "Publish") {
        if (!o.publicationSource || !currentState) throw new Error("Missing genuine producer");
        return o.publicationSource.withCurrentAuthorization(
          o.transaction,
          {
            command,
            originalIntentDigest: optionPriceIntentDigest(command),
            state: currentState,
            originalObservedAt: at,
            validUntil: until,
          },
          write,
        );
      }
      return write();
    };
    return {
      async listForBinding(selector: unknown) {
        expect(selector).toEqual({ bindingReference: id(22), optionReference: id(23) });
        events.push("PricingList");
        const listed = state.listEmpty ? [] : [initialState()];
        const read = async () => {
          await o.authority.holdUntilTransactionCompletes(o.transaction, {
            tenantReference: id(1),
            brandReference: id(2),
            selectedStoreReference: id(3),
            actorReference: id(4),
            permission: "pricing.price-book.manage",
            purposeCode: "PRICING_OPTION_PRICE_AUTHORING",
            requiredFields: optionPriceAuthoringFields,
            mode: "Read",
            command: null,
            state: listed[0] ?? null,
            observedAt: state.now,
            originalObservedAt: at,
            originalValidUntil: until,
          });
        };
        await read();
        await o.registerBeforeCommit(
          o.transaction,
          async () => {
            await read();
          },
          () => {
            ownerFinal = !state.noFinal;
          },
        );
        return state.listForeign
          ? listed.map((snapshot) => ({
              ...snapshot,
              bindingReference: parsePricingReference(id(99)),
            }))
          : listed;
      },
      execute: mutate,
      async resolve() {
        await hold("Resolve", null);
        events.push("OriginalResolve");
        return finish(state.abandon ? null : initialState());
      },
      assertFinalized() {
        if (!ownerFinal) throw new OptionPriceAuthoringError("OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
        return state.shortLease;
      },
    };
  });
  const run: MerchantOptionPriceAuthoringCommandOptions["merchant"]["transactions"]["run"] = async (
    work,
  ) => {
    events.push("BEGIN");
    try {
      const result = await work(tx);
      events.push("COMMIT");
      return result;
    } catch (error) {
      events.push("ROLLBACK");
      throw error;
    }
  };
  const options: MerchantOptionPriceAuthoringCommandOptions = {
    merchant: {
      now: () => state.now,
      transactions: { run },
      currentActor: vi.fn(),
      validateAssociation: vi.fn(),
    } as unknown as MerchantOptionPriceAuthoringCommandOptions["merchant"],
    authentication: {
      authorize: vi.fn(async () => session),
    },
    currencyMetadata: currency,
    publicationPolicyFamilyReference: id(7),
    references: { generate: vi.fn(() => id(50)) },
  };
  const request = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    expectedScope: { brandReference: id(2), storeReference: id(3) },
    command,
    context: { productReference: id(30), expectedProductAggregateVersion: 2 },
  };
  return {
    state,
    session,
    events,
    options,
    request,
    command,
    tx,
    current,
    capability,
    build: () => createMerchantOptionPriceAuthoringCommand(options),
    owner: () => {
      if (!actualOwner) throw new Error("No actual owner factory");
      return actualOwner;
    },
  };
}
it.each(["CreateDraft", "ReplaceDraft", "Publish", "Archive"] as const)(
  "composes actual %s with original-first sources and final owner receipt",
  async (action) => {
    const f = fixture(action),
      result = await f.build().execute(f.request);
    expect(result).toMatchObject({
      profile: "MerchantOptionPriceAuthoringResultV1",
      action,
      operationReference: id(20),
      tenantReference: id(1),
      actorReference: id(4),
      outcome: "Committed",
      occurredAt: at,
    });
    expect(f.events.indexOf("OriginalRead")).toBeLessThan(f.events.indexOf("Catalog"));
    expect(f.events.indexOf("Catalog")).toBeLessThan(f.events.indexOf("PricingWrite"));
    if (action === "Publish") {
      expect(f.events.indexOf("Catalog")).toBeLessThan(f.events.indexOf("Publishing"));
      expect(f.events.indexOf("Publishing")).toBeLessThan(f.events.indexOf("PricingWrite"));
    }
    expect(f.state.contextCalls).toBe(1);
    expect(f.events.at(-1)).toBe("COMMIT");
    expect(f.options.references.generate).not.toHaveBeenCalled();
  },
);
it.each(["CreateDraft", "Publish"] as const)(
  "restores immutable %s replay without current Product or policy reads",
  async (action) => {
    const f = fixture(action);
    f.state.replay = true;
    expect(
      await f.build().execute({
        ...f.request,
        context: { productReference: id(99), expectedProductAggregateVersion: 99 },
      }),
    ).toMatchObject({ outcome: "Committed", occurredAt: at });
    expect(ports.context).not.toHaveBeenCalled();
    expect(f.events).not.toContain("Publishing");
    expect(f.events).not.toContain("PricingWrite");
  },
);
it.each([false, true])(
  "resolves original committed/abandoned without Catalog qualification, abandoned:%s",
  async (abandoned) => {
    const f = fixture();
    f.state.abandon = abandoned;
    expect(await f.build().resolve(f.request)).toMatchObject({
      outcome: abandoned ? "Abandoned" : "Committed",
      state: abandoned ? null : expect.any(Object),
    });
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.publication).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("COMMIT");
  },
);
it.each(["denied", "disabled", "wrongScope"] as const)(
  "rejects actual %s and never enters writer",
  async (flag) => {
    const f = fixture();
    f.state[flag] = true;
    await expect(f.build().execute(f.request)).rejects.toThrow();
    expect(f.events).not.toContain("PricingWrite");
    expect(f.events.at(-1)).toBe("ROLLBACK");
  },
);
it("keeps original five seconds rather than restarting after authentication", async () => {
  const f = fixture(),
    options = {
      ...f.options,
      authentication: {
        authorize: vi.fn(async () => {
          f.state.now = until;
          return f.session;
        }),
      },
    };
  await expect(
    createMerchantOptionPriceAuthoringCommand(options).execute(f.request),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
  expect(f.events).not.toContain("BEGIN");
});
it("clamps only to the actual final shortened owner lease", async () => {
  const f = fixture();
  f.state.shortLease = after(3000);
  expect(await f.build().execute(f.request)).toHaveProperty("validUntil", after(3000));
});
it.each(["badOwnerTuple", "noFinal", "unknown"] as const)(
  "refuses %s without exposing original bodies",
  async (flag) => {
    const f = fixture();
    f.state[flag] = true;
    await expect(f.build().execute(f.request)).rejects.toMatchObject({
      code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
      message: "Option price operation is unavailable",
    });
  },
);
it("rejects foreign expected scope and malformed anchor before source qualification", async () => {
  const f = fixture();
  await expect(
    f
      .build()
      .execute({ ...f.request, expectedScope: { brandReference: id(99), storeReference: id(3) } }),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_PERMISSION_DENIED");
  const g = fixture();
  await expect(
    g.build().execute({
      ...g.request,
      context: { productReference: id(30), expectedProductAggregateVersion: 0 },
    }),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_INPUT_INVALID");
  expect(ports.context).not.toHaveBeenCalled();
});
it("retains late current permission denial after the consumer returns and rolls back", async () => {
  const f = fixture();
  f.state.lateDenied = true;
  await expect(f.build().execute(f.request)).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_PERMISSION_DENIED",
  );
  expect(f.events).toContain("PricingWrite");
  expect(f.events.at(-1)).toBe("ROLLBACK");
  expect(f.events).not.toContain("COMMIT");
});

const queryRequest = (f: ReturnType<typeof fixture>) => ({
  sessionCookie: f.request.sessionCookie,
  csrf: f.request.csrf,
  expectedScope: f.request.expectedScope,
  context: { ...f.request.context, bindingReference: id(22), optionReference: id(23) },
});
it.each([false, true])(
  "queries actual binding prices with genuine empty/nonempty source, empty:%s",
  async (empty) => {
    const f = fixture();
    f.state.listEmpty = empty;
    const result = await f.build().query(queryRequest(f));
    expect(result).toMatchObject({
      profile: "MerchantOptionPriceAuthoringQueryV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      context: {
        binding: { bindingReference: id(22) },
        optionReference: id(23),
        referenceEligibility: "NotEvaluated",
        publishValidation: "Incomplete",
      },
      validUntil: until,
    });
    expect(result.states).toHaveLength(empty ? 0 : 1);
    if (!empty)
      expect(result.states[0]).toMatchObject({
        bindingReference: id(22),
        optionReference: id(23),
        draft: { unitAmount: { amountMinor: "125", currencyCode: "CAD" } },
        currentPublished: null,
      });
    expect(f.events.indexOf("Catalog")).toBeLessThan(f.events.indexOf("PricingList"));
    expect(f.events).not.toContain("OriginalRead");
    expect(f.events).not.toContain("OriginalResolve");
    expect(ports.publication).not.toHaveBeenCalled();
    expect(f.options.references.generate).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("COMMIT");
  },
);
it.each(["denied", "disabled", "wrongScope"] as const)(
  "query rejects %s before price discovery",
  async (reason) => {
    const f = fixture();
    f.state[reason] = true;
    await expect(f.build().query(queryRequest(f))).rejects.toThrow();
    expect(f.events).not.toContain("PricingList");
    expect(f.events.at(-1)).toBe("ROLLBACK");
  },
);
it.each(["listForeign", "noFinal"] as const)(
  "query rejects owning %s rather than returning a fake list",
  async (reason) => {
    const f = fixture();
    f.state[reason] = true;
    await expect(f.build().query(queryRequest(f))).rejects.toHaveProperty(
      "code",
      "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    );
  },
);
it("query retains late permission withdrawal and the final shortest lease", async () => {
  const f = fixture();
  f.state.lateDenied = true;
  await expect(f.build().query(queryRequest(f))).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_PERMISSION_DENIED",
  );
  expect(f.events.at(-1)).toBe("ROLLBACK");
  const g = fixture();
  g.state.shortLease = after(2500);
  const result = await g.build().query(queryRequest(g));
  expect(result.validUntil).toBe(after(2500));
  expect(result.context.validUntil).toBe(after(2500));
});
it("query requires exact choice and closed anchor, with no caller operation or allocation", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(22)),
    request = queryRequest(f);
  Object.defineProperty(request.context, "bindingReference", { enumerable: true, get: getter });
  await expect(f.build().query(request)).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_INPUT_INVALID",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.events).not.toContain("BEGIN");
});
const scopeRequest = (f: ReturnType<typeof fixture>) => ({
  sessionCookie: f.request.sessionCookie,
  csrf: f.request.csrf,
  expectedScope: f.request.expectedScope,
});
it("reads genuine Pricing scope after deleted Catalog binding without acquiring Catalog, Pricing rows, policy or IDs", async () => {
  const f = fixture();
  ports.context.mockImplementation(() => {
    throw new Error("removed Binding source unavailable");
  });
  ports.owner.mockImplementation(() => {
    throw new Error("no Pricing row needed");
  });
  ports.publication.mockImplementation(() => {
    throw new Error("policy source unavailable");
  });
  expect(await f.build().scope(scopeRequest(f))).toEqual({
    profile: "MerchantOptionPriceScopeV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    observedAt: at,
    validUntil: until,
  });
  expect(ports.context).not.toHaveBeenCalled();
  expect(ports.owner).not.toHaveBeenCalled();
  expect(ports.publication).not.toHaveBeenCalled();
  expect(f.options.references.generate).not.toHaveBeenCalled();
  expect(f.current.authorizeActions).toHaveBeenCalledWith(["pricing.price-book.manage"]);
  expect(f.events.at(-1)).toBe("COMMIT");
});
it.each(["denied", "disabled", "wrongScope"] as const)(
  "scope refuses current %s instead of inventing an identity",
  async (reason) => {
    const f = fixture();
    f.state[reason] = true;
    await expect(f.build().scope(scopeRequest(f))).rejects.toThrow();
    expect(f.events.at(-1)).toBe("ROLLBACK");
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.owner).not.toHaveBeenCalled();
  },
);
it("scope retains final permission withdrawal without needing a content holder", async () => {
  const f = fixture();
  let calls = 0;
  f.current.authorizeActions.mockImplementation(async (actions) => {
    expect(actions).toEqual(["pricing.price-book.manage"]);
    if (++calls === 2) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return undefined;
  });
  await expect(f.build().scope(scopeRequest(f))).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_PERMISSION_DENIED",
  );
  expect(f.events.at(-1)).toBe("ROLLBACK");
  expect(f.events).not.toContain("COMMIT");
});
it("scope keeps original five seconds and actual final shortest source lease", async () => {
  const f = fixture();
  f.state.shortLease = after(2500);
  expect((await f.build().scope(scopeRequest(f))).validUntil).toBe(after(2500));
  const g = fixture();
  g.capability.holdUntilCommit.mockImplementationOnce(async () => {
    g.state.now = until;
    return undefined;
  });
  await expect(g.build().scope(scopeRequest(g))).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  );
  expect(g.events.at(-1)).toBe("ROLLBACK");
});
it("scope detects captured authorization lease port replacement before COMMIT", async () => {
  const f = fixture();
  f.capability.holdUntilCommit.mockImplementationOnce(async () => {
    f.current.leaseDeadline = () => after(1000);
    return undefined;
  });
  await expect(f.build().scope(scopeRequest(f))).rejects.toHaveProperty(
    "code",
    "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  );
  expect(f.events.at(-1)).toBe("ROLLBACK");
});
it("scope returns actual tightened post-COMMIT current-source lease", async () => {
  const f = fixture();
  f.current.leaseDeadline = () => (f.events.includes("COMMIT") ? after(1500) : until);
  const result = await f.build().scope(scopeRequest(f));
  expect(result.validUntil).toBe(after(1500));
  expect(ports.context).not.toHaveBeenCalled();
  expect(ports.owner).not.toHaveBeenCalled();
  expect(f.options.references.generate).not.toHaveBeenCalled();
});
