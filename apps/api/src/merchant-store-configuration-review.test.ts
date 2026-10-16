import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import type {
  createPersistentStoreConfigurationReview,
  createPersistentStoreApprovalPreparation,
} from "@rms/store";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  review: vi.fn(),
  preparation: vi.fn(),
  administration: vi.fn(),
  authoring: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.resolve }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPersistentStoreConfigurationReview: mocks.review,
  createPersistentStoreApprovalPreparation: mocks.preparation,
  createPersistentStoreConfigurationAdministration: mocks.administration,
  createPostgresStoreConfigurationAuthoringSource: mocks.authoring,
}));
const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

type ReviewOptions = Parameters<typeof createPersistentStoreConfigurationReview>[0];
type ReviewInput = Parameters<ReturnType<typeof createPersistentStoreConfigurationReview>>[0];
beforeEach(() => vi.clearAllMocks());
function setup() {
  const legacyHash = vi.fn(() => "sha256:" + "b".repeat(64));
  const decision = Object.freeze({
    effect: "Allow" as "Allow" | "Deny",
    action: "publishing.review.approve",
    scopeKind: "Store",
  });
  const scope = {
    selected: { tenantReference: id(40) },
    context: { actor: { actorReference: id(11) }, brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    actorReference: id(11),
    allowed: vi.fn(async () => true),
    authorizeAction: vi.fn(async () => decision),
    authorizeActions: vi.fn(
      async (actions: readonly string[]) =>
        new Map<
          string,
          Readonly<{ effect: "Allow" | "Deny"; action: string; scopeKind: string }> | null
        >(
          actions.map((action) => [
            action,
            action === "publishing.review.approve"
              ? decision
              : Object.freeze({ effect: "Allow" as "Allow" | "Deny", action, scopeKind: "Store" }),
          ]),
        ),
    ),
  };
  mocks.resolve.mockResolvedValue(scope);
  const prepare = vi.fn(async () => ({
    kind: "Approve",
    configuration: configuration("Approved"),
    snapshot: { actorReference: id(11) },
    // Deliberately injected runtime context must be overwritten by the API.
    publishingApproval: { tenantContext: { actor: { actorReference: id(99) } } },
  }));
  mocks.preparation.mockReturnValue(prepare);
  const inputs: ReviewInput[] = [];
  mocks.review.mockImplementation((options: ReviewOptions) => async (input: ReviewInput) => {
    inputs.push(input);
    const result = await options
      .publishingAuthorization({ query: async () => undefined })
      .authorize({
        action: "publishing.review.approve",
      } as never);
    if (result.effect !== "Allow") throw new Error("PUBLISHING_PERMISSION_DENIED");
    return { status: "Applied", operation: { resultingVersion: 1 } };
  });
  const service = createMerchantStoreConfiguration({
    persistence: {
      now: () => at,
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work({}) },
    },
    authentication: { authorize: async () => ({ sessionReference: id(30) }) },
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure: () => ({
      publication: { authorize: async () => true, hashContent: legacyHash },
      ports: () => ({}),
    }),
    review: { validate: async () => undefined, snapshotAudit: async () => undefined },
  } as unknown as Parameters<typeof createMerchantStoreConfiguration>[0]);
  const request = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    command: {
      command: "Approve",
      operationReference: id(20),
      auditReference: id(21),
      expectedVersion: 1,
      configuration: configuration("Approved"),
    },
  };
  return { service, request, scope, prepare, inputs, legacyHash };
}
it("preserves supplied V1 hashing and supplies owning V2 content and Setup digest ports", async () => {
  const f = setup();
  await f.service(f.request);
  const ports = mocks.preparation.mock.calls[0]?.[0] as Parameters<
    typeof createPersistentStoreApprovalPreparation
  >[0];
  const old = configuration("Approved");
  expect(ports.hashContent(old as never)).toBe("sha256:" + "b".repeat(64));
  expect(f.legacyHash).toHaveBeenCalledWith(old);
  const basis = {
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: id(40),
    setupDraftReference: id(41),
    sourceRevision: 1,
    sourceSnapshotDigest: "sha256:" + "a".repeat(64),
    feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
      chargeType,
      state: "Disabled",
    })),
  };
  const modern = { ...old, setupBasis: basis };
  const hash = ports.hashContent(modern as never);
  expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(
    ports.hashContent({ ...modern, approvedByReference: id(91), updatedAt: at } as never),
  ).toBe(hash);
  expect(f.legacyHash).toHaveBeenCalledTimes(1);
  // These ports go to the actual owning materializer/authority, not browser bytes.
  const preparation = mocks.review.mock.calls[0]?.[0] as ReviewOptions;
  const references = preparation.administration.publication.setupSnapshotReferences;
  expect(references?.hashIntent(references.canonicalize(modern))).toBe(
    "sha256:" + sha256Hex(canonicalizeRfc8785(modern)),
  );
});
it("routes approval through atomic workflow using server context and current Publishing decision", async () => {
  const f = setup();
  expect(await f.service(f.request)).toEqual({ status: "Applied", resultingVersion: 1 });
  expect(f.inputs[0]?.publishingApproval.tenantContext).toBe(f.scope.context);
  expect(f.inputs[0]?.storeCommand).toMatchObject({ actorReference: id(11), occurredAt: at });
  // WP-2423: the command's permission and every approval Publishing decision come from one
  // permission packet at the start; the used ones are re-checked in full before the commit.
  expect(mocks.resolve).toHaveBeenCalledOnce();
  expect(f.scope.authorizeActions).toHaveBeenCalledTimes(2);
  expect(f.scope.authorizeActions.mock.calls[0]?.[0]).toEqual([
    "store.service.approve",
    "publishing.draft.create",
    "publishing.review.submit",
    "publishing.review.approve",
  ]);
  expect(f.scope.authorizeActions.mock.calls[1]?.[0]).toEqual([
    "store.service.approve",
    "publishing.review.approve",
  ]);
  expect(f.scope.allowed).not.toHaveBeenCalled();
  expect(f.scope.authorizeAction).not.toHaveBeenCalled();
  expect(mocks.administration).not.toHaveBeenCalled();
});
it("WP-2423: owner callbacks take the run's guard: true during the run, false after", async () => {
  const f = setup();
  const during: boolean[] = [];
  f.prepare.mockImplementation(async () => {
    const options = mocks.preparation.mock.calls[0]?.[0] as Parameters<
      typeof createPersistentStoreApprovalPreparation
    >[0];
    during.push(await options.authorize({} as never, at));
    return {
      kind: "Approve",
      configuration: configuration("Approved"),
      snapshot: { actorReference: id(11) },
      publishingApproval: { tenantContext: { actor: { actorReference: id(99) } } },
    };
  });
  await f.service(f.request);
  const options = mocks.preparation.mock.calls[0]?.[0] as Parameters<
    typeof createPersistentStoreApprovalPreparation
  >[0];
  expect(during).toEqual([true]);
  expect(await options.authorize({} as never, at)).toBe(false);
  // The owner configuration's scope answers from the same guard.
  const review = mocks.review.mock.calls[0]?.[0] as ReviewOptions;
  await expect(
    review.publishingAuthorization({ query: async () => undefined } as never).authorize({
      action: "publishing.review.approve",
    } as never),
  ).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
});
it("WP-2423: a permission withdrawn or Session ended during approval refuses it before commit", async () => {
  const f = setup();
  const start = f.scope.authorizeActions.getMockImplementation();
  if (!start) throw new Error("Synthetic permission packet is missing");
  f.scope.authorizeActions
    .mockImplementationOnce(start)
    .mockImplementation(
      async (actions: readonly string[]) => new Map(actions.map((action) => [action, null])),
    );
  await expect(f.service(f.request)).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  // The refusal is thrown inside the transaction callback after the approval ran.
  expect(f.inputs).toHaveLength(1);
});
it("passes current Publishing denial through without manufacturing an Allow", async () => {
  const f = setup();
  const start = f.scope.authorizeActions.getMockImplementation();
  if (!start) throw new Error("Synthetic permission packet is missing");
  f.scope.authorizeActions.mockImplementation(async (actions: readonly string[]) => {
    const decisions = await start(actions);
    decisions.set(
      "publishing.review.approve",
      Object.freeze({ effect: "Deny", action: "publishing.review.approve", scopeKind: "Store" }),
    );
    return decisions;
  });
  await expect(f.service(f.request)).rejects.toThrow("PUBLISHING_PERMISSION_DENIED");
});
it("refuses a caller without the command's permission before preparing approval", async () => {
  const f = setup();
  f.scope.authorizeActions.mockResolvedValue(new Map());
  await expect(f.service(f.request)).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  expect(f.prepare).not.toHaveBeenCalled();
});

it("refuses a valid closed Setup basis from a foreign Tenant before allocating approval evidence", async () => {
  const f = setup();
  await expect(
    f.service({
      ...f.request,
      command: {
        ...f.request.command,
        configuration: {
          ...f.request.command.configuration,
          setupBasis: {
            profile: "StoreSetupConfigurationBasisV2",
            tenantReference: id(99),
            setupDraftReference: id(41),
            sourceRevision: 1,
            sourceSnapshotDigest: "sha256:" + "a".repeat(64),
            feeContexts: [
              { chargeType: "ServiceCharge", state: "Disabled" },
              { chargeType: "DeliveryFee", state: "Disabled" },
              { chargeType: "Tip", state: "Disabled" },
            ],
          },
        },
      },
    }),
  ).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
  expect(mocks.administration).not.toHaveBeenCalled();
});

it("routes V2 approval through owning fresh preparation instead of synthesizing a Submit", async () => {
  const f = setup();
  const approve = vi.fn<
    (input: unknown) => Promise<{ status: string; operation: { resultingVersion: number } }>
  >(async () => ({ status: "Applied", operation: { resultingVersion: 1 } }));
  mocks.administration.mockReturnValue({ approve });
  const modern = {
    ...configuration("PendingApproval"),
    setupBasis: {
      profile: "StoreSetupConfigurationBasisV2",
      tenantReference: id(40),
      setupDraftReference: id(41),
      sourceRevision: 1,
      sourceSnapshotDigest: "sha256:" + "a".repeat(64),
      feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
        chargeType,
        state: "Disabled",
      })),
    },
  };
  await expect(
    f.service({ ...f.request, command: { ...f.request.command, configuration: modern } }),
  ).resolves.toEqual({ status: "Applied", resultingVersion: 1 });
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve.mock.calls[0]?.[0]).toMatchObject({
    actorReference: id(11),
    configuration: { setupBasis: modern.setupBasis },
  });
  expect(f.prepare).not.toHaveBeenCalled();
  expect(mocks.preparation).not.toHaveBeenCalled();
  expect(mocks.review).not.toHaveBeenCalled();
});

it("WP-2423: reads with two full resolutions; owner reads take the run's guard", async () => {
  const f = setup();
  const during: boolean[] = [];
  mocks.authoring.mockImplementation((options: { authorize(): Promise<boolean> }) => async () => {
    during.push(await options.authorize());
    return null;
  });
  const baseline = vi.fn(async () => {
    const scope = (configure.mock.calls[0] as unknown[] | undefined)?.[1] as {
      allowed(): Promise<boolean>;
    };
    during.push(await scope.allowed());
    return null;
  });
  const configure = vi.fn(() => ({ publishedBaseline: baseline }));
  const service = createMerchantStoreConfiguration({
    persistence: {
      now: () => at,
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work({}) },
    },
    authentication: { authorize: async () => ({ sessionReference: id(30) }) },
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure,
  } as unknown as Parameters<typeof createMerchantStoreConfiguration>[0]);
  await expect(service.read("synthetic")).resolves.toMatchObject({ expectedVersion: 0 });
  expect(during).toEqual([true, true]);
  expect(f.scope.allowed).toHaveBeenCalledTimes(2);
  const scope = (configure.mock.calls[0] as unknown[] | undefined)?.[1] as {
    allowed(): Promise<boolean>;
  };
  expect(await scope.allowed()).toBe(false);
  f.scope.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(service.read("synthetic")).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
});

/** WP-2423 (v15 2026-10-16): a publication reads its sole-operator mark; none is recorded here. */
const noSoleOperatorMark = { query: async () => ({ rows: [], rowCount: 0 }) };

describe("WP-2423 Q4: Publishing decisions of a configuration from Store setup", () => {
  const basis = {
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: id(40),
    setupDraftReference: id(41),
    sourceRevision: 1,
    sourceSnapshotDigest: "sha256:" + "a".repeat(64),
    feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
      chargeType,
      state: "Disabled",
    })),
  };
  it.each([
    ["Submit", "submit", "Draft", ["publishing.draft.create", "publishing.review.submit"]],
    ["Approve", "approve", "PendingApproval", ["publishing.review.approve"]],
    ["Publish", "publish", "Approved", ["publishing.release.publish"]],
  ] as const)(
    "%s resolves only its own Publishing decisions once and hands them to owner configuration",
    async (command, method, lifecycle, publishing) => {
      const f = setup();
      const configure = vi.fn(
        (
          _tx: unknown,
          _scope: unknown,
          access: { authorize(request: unknown): Promise<unknown> },
        ) => {
          void access;
          return {
            publication: { authorize: async () => true, hashContent: f.legacyHash },
            ports: () => ({}),
          };
        },
      );
      const step = vi.fn(async () => {
        const access = configure.mock.calls[0]?.[2];
        if (!access) throw new Error("Missing Publishing access");
        // Every decision of the step is answered from the start of the run; others are refused.
        for (const action of publishing)
          expect(await access.authorize({ action } as never)).toMatchObject({
            effect: "Allow",
            action,
          });
        await expect(
          access.authorize({ action: "publishing.release.rollback" } as never),
        ).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
        return { status: "Applied", operation: { resultingVersion: 1 } };
      });
      mocks.administration.mockReturnValue({ [method]: step });
      const service = createMerchantStoreConfiguration({
        persistence: {
          now: () => at,
          transactions: {
            run: async (work: (tx: object) => Promise<unknown>) => work(noSoleOperatorMark),
          },
        },
        authentication: { authorize: async () => ({ sessionReference: id(30) }) },
        actionPermissions: {
          saveDraft: "store.service.save-draft",
          validate: "store.service.validate",
          submit: "store.service.submit",
          approve: "store.service.approve",
          publish: "store.service.publish",
        },
        configure,
        review: { validate: async () => undefined, snapshotAudit: async () => undefined },
      } as unknown as Parameters<typeof createMerchantStoreConfiguration>[0]);
      await expect(
        service({
          ...f.request,
          command: {
            ...f.request.command,
            command,
            configuration: { ...configuration(lifecycle), setupBasis: basis },
          },
        }),
      ).resolves.toEqual({ status: "Applied", resultingVersion: 1 });
      expect(step).toHaveBeenCalledOnce();
      expect(f.scope.authorizeActions.mock.calls[0]?.[0]).toEqual([
        "store.service." + method,
        ...publishing,
      ]);
      // The used decisions are re-checked in full before the commit.
      expect(f.scope.authorizeActions.mock.calls[1]?.[0]).toEqual([
        "store.service." + method,
        ...publishing,
      ]);
      expect(mocks.resolve).toHaveBeenCalledOnce();
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );
  it("refuses a Publishing decision withdrawn during the run before the commit", async () => {
    const f = setup();
    const start = f.scope.authorizeActions.getMockImplementation();
    if (!start) throw new Error("Synthetic permission packet is missing");
    f.scope.authorizeActions.mockImplementationOnce(start).mockImplementation(async (actions) => {
      const decisions = await start(actions);
      decisions.set("publishing.release.publish", null);
      return decisions;
    });
    let access: { authorize(request: unknown): Promise<unknown> } | undefined;
    mocks.administration.mockReturnValue({
      publish: async () => {
        await access?.authorize({ action: "publishing.release.publish" });
        return { status: "Applied", operation: { resultingVersion: 1 } };
      },
    });
    const service = createMerchantStoreConfiguration({
      persistence: {
        now: () => at,
        transactions: {
          run: async (work: (tx: object) => Promise<unknown>) => work(noSoleOperatorMark),
        },
      },
      authentication: { authorize: async () => ({ sessionReference: id(30) }) },
      actionPermissions: {
        saveDraft: "store.service.save-draft",
        validate: "store.service.validate",
        submit: "store.service.submit",
        approve: "store.service.approve",
        publish: "store.service.publish",
      },
      configure: (_tx: unknown, _scope: unknown, publishing: typeof access) => {
        access = publishing;
        return { publication: { authorize: async () => true, hashContent: f.legacyHash } };
      },
    } as unknown as Parameters<typeof createMerchantStoreConfiguration>[0]);
    await expect(
      service({
        ...f.request,
        command: {
          ...f.request.command,
          command: "Publish",
          configuration: { ...configuration("Approved"), setupBasis: basis },
        },
      }),
    ).rejects.toThrow("STORE_CONFIGURATION_PERMISSION_DENIED");
  });
  it("refuses a whole configuration from the browser for a configuration from Store setup", async () => {
    const f = setup();
    await expect(
      f.service({
        ...f.request,
        command: {
          ...f.request.command,
          command: "SaveDraft",
          expectedVersion: 1,
          configuration: {
            ...configuration("Draft"),
            configurationReference: id(50),
            configurationVersion: 2,
            supersedesConfigurationReference: id(1),
            setupBasis: basis,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_COMMAND_INVALID" });
    expect(f.scope.authorizeActions).not.toHaveBeenCalled();
    expect(mocks.administration).not.toHaveBeenCalled();
  });
});

describe("WP-2423 DEC-SOLE-OPERATOR-APPROVAL: approving your own hours change", () => {
  const own = (approvalMode?: unknown) => {
    const f = setup();
    // The signed-in Owner (id 11) made the change waiting for approval.
    return {
      f,
      request: {
        ...f.request,
        command: {
          ...f.request.command,
          configuration: { ...configuration("PendingApproval"), authoredByReference: id(11) },
          ...(approvalMode === undefined ? {} : { approvalMode }),
        },
      },
    };
  };
  it("refuses the author's own approval unless they ask to approve it alone", async () => {
    const { f, request } = own();
    await expect(f.service(request)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_SELF_APPROVAL",
    });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("refuses an unknown approval mode, and asking alone where the deployment does not offer it", async () => {
    const odd = own("Alone");
    await expect(odd.f.service(odd.request)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_COMMAND_INVALID",
    });
    // This deployment evaluates no Store approvers (no sole-operator option).
    const offered = own("SoleOperator");
    await expect(offered.f.service(offered.request)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_COMMAND_INVALID",
    });
    expect(offered.f.prepare).not.toHaveBeenCalled();
  });
  it("never lets someone approve another person's change as sole operator", async () => {
    const f = setup();
    await expect(
      f.service({ ...f.request, command: { ...f.request.command, approvalMode: "SoleOperator" } }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_COMMAND_INVALID" });
  });
});
