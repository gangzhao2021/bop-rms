import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogSellingUnitRegistryCommand,
  catalogSellingUnitRegistryDigest,
  sellingUnitRegistryFields,
  sellingUnitRegistrationResolutionFields,
  buildCatalogSellingUnitRegistrationResolution,
  parseCatalogSellingUnitRegistrationResolutionCommand,
  type CatalogSellingUnitRegistrationResolution,
  type SellingUnitRegistryStoreOptions,
  type CatalogSellingUnitRegistryCommand,
  type CatalogSellingUnitInspection,
} from "@rms/catalog";
import { createMerchantProductSellingUnitRegistry } from "./merchant-product-selling-unit-registry.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  store: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => mocks.current(options),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => mocks.capability(options),
}));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresSellingUnitRegistryStore: (options: unknown) => mocks.store(options),
}));
beforeEach(() => vi.clearAllMocks());
type Transaction = Parameters<
  SellingUnitRegistryStoreOptions["authority"]["holdUntilTransactionCompletes"]
>[0];
const id = (n: number) => "019a2421-0050-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function fixture() {
  const state = {
      now: at,
      fence: null as CatalogSellingUnitRegistrationResolution | null,
      deny: false,
      original: null as CatalogSellingUnitRegistryCommand | null,
      afterOwner: undefined as (() => void) | undefined,
      badPacket: false,
    },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    authentication = { authorize: vi.fn(async () => ({ sessionReference: id(9) })) },
    current = {
      assertCurrent: vi.fn(() => {
        if (state.deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
      authorizeActions: vi.fn(async (permissions: readonly string[]) => {
        void permissions;
        if (state.deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
      withCurrentStoreScope: vi.fn(),
    },
    capability = { holdUntilCommit: vi.fn(async () => undefined) },
    scope = {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      actorReference: id(3),
      selectedStoreReference: id(8),
    };
  mocks.scope.mockResolvedValue(scope);
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  mocks.store.mockImplementation((options: SellingUnitRegistryStoreOptions) => {
    async function held<T>(
      mode: "Intent" | "Inspect" | "Replay" | "Register" | "Resolve",
      work: (actual: Transaction) => Promise<T>,
    ) {
      return options.transactions.run(async (actual) => {
        const hold = async () =>
          options.authority.holdUntilTransactionCompletes(actual, {
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            actorKind: "User",
            purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
            permission: "catalog.manage",
            action: "catalog.manage",
            mode,
            requiredPermissions: state.badPacket
              ? ["catalog.manage"]
              : mode === "Inspect" || mode === "Register"
                ? [
                    "catalog.manage",
                    "catalog.product.read",
                    "catalog.product.history.read",
                    "catalog.sku.read",
                  ]
                : ["catalog.manage"],
            registry: state.original?.registry ?? null,
            requiredFields:
              mode === "Resolve"
                ? sellingUnitRegistrationResolutionFields
                : sellingUnitRegistryFields,
            observedAt: options.clock.now(),
          });
        await options.registerBeforeCommit(actual, hold, () => {
          options.clock.now();
        });
        await hold();
        const result = await work(actual);
        state.afterOwner?.();
        return result;
      });
    }
    return {
      withCurrentInspection: async (
        observation: CatalogSellingUnitInspection["observation"],
        work: (source: CatalogSellingUnitInspection, actual: Transaction) => Promise<unknown>,
      ) =>
        held("Inspect", async (actual) => {
          const source: CatalogSellingUnitInspection = {
            profile: "CatalogSellingUnitInspectionV1",
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            presence: state.original ? "Present" : "Absent",
            registry: state.original?.registry ?? null,
            assignments: [
              {
                source: "CurrentSku",
                productReference: id(100),
                versionReference: id(101),
                skuReference: id(102),
                operationReference: null,
                aggregateVersion: 1,
                unitCode: "SYNTHETIC",
                unitQuantity: "1.25",
              },
              {
                source: "OperationSnapshot",
                productReference: id(100),
                versionReference: id(101),
                skuReference: id(102),
                operationReference: id(103),
                aggregateVersion: 1,
                unitCode: "SYNTHETIC",
                unitQuantity: "1.25",
              },
            ],
            historyDigest: digest,
            inspectionDigest: digest,
            observation,
            sourceAuthority: "CurrentTransactionHeld",
          };
          return work(Object.freeze(source), actual);
        }),
      withRegistrationOperation: async (
        value: { operationReference: string },
        work: (
          original: CatalogSellingUnitRegistryCommand | null,
          registry: CatalogSellingUnitRegistryCommand["registry"] | null,
          actual: Transaction,
        ) => Promise<unknown>,
      ) => {
        const original =
          state.original?.operationReference === value.operationReference ? state.original : null;
        return held(original ? "Replay" : "Intent", async (actual) =>
          work(original, state.original?.registry ?? null, actual),
        );
      },
      resolveRegistrationOperation: async (value: unknown) =>
        held("Resolve", async () => {
          const command = parseCatalogSellingUnitRegistrationResolutionCommand(value),
            original =
              state.original?.operationReference === command.operationReference
                ? state.original
                : null;
          if (original) {
            if (original.actorReference !== command.actorReference)
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (
              original.expectedRegistryVersion !== command.expectedRegistryVersion ||
              original.reasonCode !==
                (command.action === "Create" ? "PRODUCT_CREATE_UNITS" : "PRODUCT_DRAFT_UNITS")
            )
              throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
            return buildCatalogSellingUnitRegistrationResolution({
              outcome: "Committed",
              command,
              registryReference: original.registry.registryReference,
              versionReference: original.registry.versionReference,
              registryVersion: original.registry.registryVersion,
              originalIntentDigest: original.intentDigest,
              snapshotDigest: original.snapshotDigest,
              recordedAt: original.occurredAt,
            });
          }
          if (state.fence) return state.fence;
          const resolution = buildCatalogSellingUnitRegistrationResolution({
            outcome: "Abandoned",
            command,
            registryReference: null,
            versionReference: null,
            registryVersion: null,
            originalIntentDigest: null,
            snapshotDigest: null,
            recordedAt: options.clock.now(),
          });
          options.audit?.createAbandonment?.({ command, resolution });
          state.fence = resolution;
          return resolution;
        }),
      execute: async (value: unknown) => {
        const command = parseCatalogSellingUnitRegistryCommand(value),
          replayed = state.original !== null;
        return held(replayed ? "Replay" : "Register", async () => {
          if (!replayed) {
            state.original = command;
            options.audit?.create(command);
          }
          return {
            status: replayed ? "Replayed" : "Applied",
            registry: command.registry,
            operationReference: command.operationReference,
            snapshotDigest: catalogSellingUnitRegistryDigest(command.registry),
          };
        });
      },
    };
  });
  const options = {
      merchant: {
        transactions: {
          async run<T>(work: (actual: Transaction) => Promise<T>) {
            const saved = state.original,
              savedFence = state.fence;
            try {
              return await work(tx);
            } catch (error) {
              state.original = saved;
              state.fence = savedFence;
              throw error;
            }
          },
        },
        now: () => state.now,
      } as never,
      authentication: authentication as never,
      auditReference: vi.fn(() => id(80)),
    },
    request = {
      sessionCookie: "SYNTHETIC_SESSION",
      csrf: "SYNTHETIC_CSRF",
      expectedScope: { brandReference: id(2), storeReference: id(8) },
      command: { action: "Create" },
    };
  const registration = {
    ...request,
    command: {
      action: "Create",
      operationReference: id(20),
      expectedRegistryVersion: 0,
      defaultLocale: "en-CA",
      units: [
        {
          unitReference: null as string | null,
          code: "SYNTHETIC",
          semanticDefinition: "Synthetic operator declared package",
          quantityDecimalPlaces: 2,
          localizedNames: { "en-CA": "Synthetic package" },
          lifecycle: "Active",
        },
      ],
    },
  };
  return { state, tx, current, capability, scope, options, request, registration, authentication };
}
it.each(["Create", "ReplaceDraft"])(
  "contextual %s inspection returns labels/grouped counts with no raw SKU graph",
  async (action) => {
    const s = fixture();
    s.request.command.action = action;
    const result = await createMerchantProductSellingUnitRegistry(s.options).inspect(s.request);
    expect(result).toMatchObject({
      presence: "Absent",
      registryVersion: 0,
      defaultLocale: null,
      units: [],
      assignedHistory: [
        {
          unitCode: "SYNTHETIC",
          currentSkuCount: 1,
          historicalAssignmentCount: 1,
          quantities: ["1.25"],
        },
      ],
      observedAt: at,
      validUntil: "2026-10-04T12:00:05.000Z",
    });
    expect(JSON.stringify(result)).not.toContain(id(102));
    expect(JSON.stringify(result)).not.toContain(id(100));
    expect(s.current.authorizeActions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.product.read",
      "catalog.product.history.read",
      "catalog.sku.read",
    ]);
    expect(mocks.current.mock.calls[0]?.[0]).toMatchObject({
      capabilityKey:
        action === "Create" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
    });
  },
);
it("actual registry registration binds server scope, original clock/IDs and Audit", async () => {
  const s = fixture(),
    handler = createMerchantProductSellingUnitRegistry(s.options),
    result = await handler.register(s.registration);
  expect(result.status).toBe("Applied");
  expect(s.state.original).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    occurredAt: at,
    purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
    reasonCode: "PRODUCT_CREATE_UNITS",
    registry: { registeredAt: at },
  });
  expect(s.options.auditReference).toHaveBeenCalledWith(id(20));
  expect(s.current.authorizeActions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.read",
    "catalog.product.history.read",
    "catalog.sku.read",
  ]);
  const source = await handler.inspect(s.request);
  expect(source.presence).toBe("Present");
  expect(source.units[0]?.localizedNames).toEqual({ "en-CA": "Synthetic package" });
});
it("lost reply retry retains original time/identities and uses recovery permission only", async () => {
  const s = fixture(),
    handler = createMerchantProductSellingUnitRegistry(s.options);
  await handler.register(s.registration);
  const original = s.state.original;
  s.state.now = "2026-10-05T12:00:00.000Z";
  s.current.authorizeActions.mockClear();
  s.options.auditReference.mockClear();
  const replay = await handler.register(s.registration);
  expect(replay.status).toBe("Replayed");
  expect(s.state.original).toEqual(original);
  expect(s.options.auditReference).not.toHaveBeenCalled();
  expect(
    s.current.authorizeActions.mock.calls.every(
      (args) => JSON.stringify(args[0]) === JSON.stringify(["catalog.manage"]),
    ),
  ).toBe(true);
});
it.each(["meaning", "precision", "locale", "action", "version"])(
  "original operation cannot silently replace %s payload",
  async (field) => {
    const s = fixture(),
      handler = createMerchantProductSellingUnitRegistry(s.options);
    await handler.register(s.registration);
    const unit = s.registration.command.units[0];
    if (!unit) throw Error("Missing fixture");
    if (field === "meaning") unit.semanticDefinition = "Other meaning";
    if (field === "precision") unit.quantityDecimalPlaces = 3;
    if (field === "locale") unit.localizedNames["en-CA"] = "Other label";
    if (field === "action") s.registration.command.action = "ReplaceDraft";
    if (field === "version") s.registration.command.expectedRegistryVersion = 1;
    await expect(handler.register(s.registration)).rejects.toMatchObject({
      code: "CATALOG_IDEMPOTENCY_CONFLICT",
    });
  },
);
it.each(["actorReference", "tenantReference", "registeredAt", "registryReference", "permission"])(
  "refuses caller identity/authority/time injection %s before authentication",
  async (field) => {
    const s = fixture();
    Object.assign(s.registration.command, { [field]: id(99) });
    await expect(
      createMerchantProductSellingUnitRegistry(s.options).register(s.registration),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(s.authentication.authorize).not.toHaveBeenCalled();
  },
);
it("refuses stale current Store selection", async () => {
  const s = fixture();
  s.request.expectedScope.storeReference = id(99);
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).inspect(s.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("source admission checks exact required fine permission tuple", async () => {
  const s = fixture();
  s.state.badPacket = true;
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).inspect(s.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("late source authority revocation refuses inspection and rolls registration back", async () => {
  const s = fixture();
  s.state.afterOwner = () => {
    s.state.deny = true;
  };
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).register(s.registration),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(s.state.original).toBeNull();
});
it("five second original lease is never renewed by source acquisition", async () => {
  const s = fixture();
  s.state.afterOwner = () => {
    s.state.now = "2026-10-04T12:00:05.000Z";
  };
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).inspect(s.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("slow initial authentication consumes original lease", async () => {
  const s = fixture();
  s.authentication.authorize.mockImplementation(async () => {
    s.state.now = "2026-10-04T12:00:05.000Z";
    return { sessionReference: id(9) };
  });
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).inspect(s.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("human bootstrap confirmation is preserved; server derives only owning definitions metadata", async () => {
  const s = fixture(),
    bootstrapConfirmation = {
      historyDigest: digest,
      confirmations: [
        {
          unitCode: "SYNTHETIC",
          semanticDefinition: "Synthetic operator declared package",
          confirmed: true,
        },
      ],
    };
  await createMerchantProductSellingUnitRegistry(s.options).register({
    ...s.registration,
    command: { ...s.registration.command, bootstrapConfirmation },
  });
  expect(s.state.original?.bootstrapConfirmation).toMatchObject({
    profile: "CatalogSellingUnitBootstrapConfirmationV1",
    historyDigest: digest,
    confirmations: bootstrapConfirmation.confirmations,
  });
  expect(s.state.original?.bootstrapConfirmation?.definitionsDigest).toMatch(
    /^sha256:[a-f0-9]{64}$/,
  );
});
it.each(["false", "missing", "unknown", "profile", "definitionsDigest"])(
  "bootstrap does not manufacture missing or malformed human consent %s",
  async (kind) => {
    const s = fixture(),
      bootstrapConfirmation: Record<string, unknown> = {
        historyDigest: digest,
        confirmations: [
          {
            unitCode: "SYNTHETIC",
            semanticDefinition: "Synthetic operator declared package",
            confirmed: true,
          },
        ],
      };
    if (kind === "false")
      bootstrapConfirmation.confirmations = [
        {
          unitCode: "SYNTHETIC",
          semanticDefinition: "Synthetic operator declared package",
          confirmed: false,
        },
      ];
    if (kind === "missing") bootstrapConfirmation.confirmations = [];
    if (kind === "unknown") bootstrapConfirmation.actorReference = id(99);
    if (kind === "profile")
      bootstrapConfirmation.profile = "CatalogSellingUnitBootstrapConfirmationV1";
    if (kind === "definitionsDigest") bootstrapConfirmation.definitionsDigest = digest;
    await expect(
      createMerchantProductSellingUnitRegistry(s.options).register({
        ...s.registration,
        command: { ...s.registration.command, bootstrapConfirmation },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(s.authentication.authorize).not.toHaveBeenCalled();
  },
);
it("fresh stale expected registry version conflicts before a new write", async () => {
  const s = fixture(),
    handler = createMerchantProductSellingUnitRegistry(s.options);
  await handler.register(s.registration);
  await expect(
    handler.register({
      ...s.registration,
      command: { ...s.registration.command, operationReference: id(21) },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
});

function resolveRequest(s: ReturnType<typeof fixture>) {
  return {
    ...s.request,
    command: {
      profile: "CatalogSellingUnitRegistrationResolutionRequestV1",
      tenantReference: id(1),
      actorReference: id(3),
      action: "Create",
      operationReference: id(20),
      expectedRegistryVersion: 0,
    },
  };
}
it("unit context supplies actual cursor identity without registry/history qualification", async () => {
  const s = fixture(),
    result = await createMerchantProductSellingUnitRegistry(s.options).context(s.request);
  expect(result).toEqual({
    profile: "CatalogSellingUnitRegistrationContextV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(8),
    actorReference: id(3),
    action: "Create",
    observedAt: at,
    validUntil: "2026-10-04T12:00:05.000Z",
  });
  expect(s.tx.query).not.toHaveBeenCalled();
  expect(
    s.current.authorizeActions.mock.calls.every(
      (args) => JSON.stringify(args[0]) === JSON.stringify(["catalog.manage"]),
    ),
  ).toBe(true);
});
it("unit resolution preserves immutable original clock and same Actor without new content qualification", async () => {
  const s = fixture(),
    handler = createMerchantProductSellingUnitRegistry(s.options);
  await handler.register(s.registration);
  s.state.now = "2026-10-05T12:00:00.000Z";
  s.current.authorizeActions.mockClear();
  s.options.auditReference.mockClear();
  const result = await handler.resolve(resolveRequest(s));
  expect(result.resolution).toMatchObject({
    outcome: "Committed",
    recordedAt: at,
    registryVersion: 1,
  });
  expect(s.options.auditReference).not.toHaveBeenCalled();
  expect(
    s.current.authorizeActions.mock.calls.every(
      (args) => JSON.stringify(args[0]) === JSON.stringify(["catalog.manage"]),
    ),
  ).toBe(true);
});
it("unit absence resolution appends one distinct audited terminal fence", async () => {
  const s = fixture(),
    handler = createMerchantProductSellingUnitRegistry(s.options),
    request = resolveRequest(s),
    first = await handler.resolve(request);
  expect(first.resolution).toMatchObject({
    outcome: "Abandoned",
    registryVersion: null,
    recordedAt: at,
  });
  expect((await handler.resolve(request)).resolution).toEqual(first.resolution);
  expect(s.options.auditReference).toHaveBeenCalledOnce();
});
it.each(["tenantReference", "actorReference"])(
  "original cursor %s must match current persisted identity",
  async (field) => {
    const s = fixture(),
      request = resolveRequest(s);
    Object.assign(request.command, { [field]: id(99) });
    await expect(
      createMerchantProductSellingUnitRegistry(s.options).resolve(request),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(s.state.fence).toBeNull();
  },
);
it("unit resolution late denial preserves nonterminal state and rolls absence back", async () => {
  const s = fixture();
  s.state.afterOwner = () => {
    s.state.deny = true;
  };
  await expect(
    createMerchantProductSellingUnitRegistry(s.options).resolve(resolveRequest(s)),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(s.state.fence).toBeNull();
});
