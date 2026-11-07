import { BrowserSessionError } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  productEditorSnapshotFields,
  productPublicationSourceFieldsV2,
  productPublicationValidationReportReadFields,
  parseCatalogProductPublicationValidationReportView,
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
  buildCatalogProductPublicationValidationReport,
  productPublicationCheckCodes,
} from "@rms/catalog";
import { createMerchantProductPublicationValidationReportQueryV2 } from "./merchant-product-publication-validation-report-query-v2.js";

const state = vi.hoisted(() => ({
  factory: vi.fn(),
  brand: vi.fn(),
  capability: vi.fn(),
  holdCapability: vi.fn(),
  completed: false,
  mode: "normal",
  changed: {},
  laterGuard: undefined as (() => void) | undefined,
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => state.brand }));
// Only the FeatureControl leaf is controlled here; the current Brand bridge and
// fixed read-profile authorizer remain real. Native HTTP covers actual definitions.
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (...args: unknown[]) => state.capability(...args),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPublicationValidationReportSourceV2: (...args: unknown[]) =>
    state.factory(...args),
}));

const id = (n: number) => "01902495-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
type Options = Parameters<typeof createMerchantProductPublicationValidationReportQueryV2>[0];
type Source = Parameters<
  typeof import("@rms/catalog").createPostgresProductPublicationValidationReportSourceV2
>[0];
type View = ReturnType<typeof parseCatalogProductPublicationValidationReportView>;
type Transaction = Parameters<Source["reportAuthority"]["holdUntilTransactionCompletes"]>[0];
function seal(value: object) {
  return { ...value, digest: hash(value) };
}
function view(status: "NotValidated" | "Recorded" | "NotRecorded" = "NotValidated"): View {
  const historicalAt = "2026-10-03T11:00:00.000Z",
    historicalUntil = "2026-10-03T11:00:05.000Z",
    intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(4),
      actorKind: "User",
      operationReference: id(10),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: historicalAt,
          localDateTime: historicalAt.slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: historicalAt,
      reasonCode: "SYNTHETIC",
      replacementIntent: seal(intent),
      replacementIntentDigest: hash(intent),
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: command.replacementIntentDigest,
      evidenceReference: id(11),
      productAggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference: id(12),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy"
            ? "Pending"
            : code === "ChangeImpact" || code === "HardErrorsCleared"
              ? "HardError"
              : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: historicalAt,
      validUntil: historicalUntil,
    }),
    publication = planCatalogProductPublicationV2(command, null, {
      now: historicalAt,
      productAggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: null,
      replacement: null,
    }),
    report =
      status === "Recorded"
        ? buildCatalogProductPublicationValidationReport({
            command,
            publication,
            validation,
            details: null,
            recordedAt: historicalAt,
          })
        : null;
  return parseCatalogProductPublicationValidationReportView(
    seal({
      profile: "CatalogProductPublicationValidationReportViewV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: 7,
      publicationVersion: status === "NotValidated" ? 0 : 1,
      selectedPublicationOperationReference:
        status === "NotValidated" ? null : publication.operationReference,
      selectedPublicationDigest: status === "NotValidated" ? null : hash(publication),
      currentDraft: {
        versionReference: id(6),
        contentDigest: command.contentDigest,
        configurationDigest: command.configurationDigest,
        contentStatus: "Present",
      },
      status,
      applicability: status === "NotValidated" ? "NotValidated" : "CurrentDraftContent",
      report,
      observedAt: at,
      validUntil: until,
      eligibility: "NotEvaluated",
    }),
  );
}

// Controlled owner facade: SQL/current-history/report recovery have independent
// Catalog/native tests. Here no fixture grants complete validation or sale status.
function setup(status: "NotValidated" | "Recorded" | "NotRecorded" = "NotValidated") {
  let now = at;
  const events: string[] = [],
    resultView = view(status),
    authenticate = vi.fn(async () => ({ sessionReference: id(9) })),
    action = vi.fn(async (requested: string) => ({
      effect: "Allow",
      action: requested,
      scopeKind: "Brand",
    })),
    scope = {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: action,
      authorizeActions: async (actions: readonly string[]) => Promise.all(actions.map(action)),
      authorizeActionsWithValidity: async (actions: readonly string[]) => ({
        decisions: await Promise.all(actions.map(action)),
        validUntil: null,
      }),
    },
    screen = vi.fn<NonNullable<Options["holdScreenUntilCommit"]>>(async () => {
      events.push(state.completed ? "final-screen" : "screen");
    }),
    content = vi.fn<Source["contentAuthority"]["holdUntilTransactionCompletes"]>(async () => {
      events.push(state.completed ? "final-content" : "content");
    }),
    history = vi.fn<Source["historyAuthority"]["holdUntilTransactionCompletes"]>(async () => {
      events.push(state.completed ? "final-history" : "history");
    }),
    report = vi.fn<Source["reportAuthority"]["holdUntilTransactionCompletes"]>(async () => {
      events.push(state.completed ? "final-report" : "report");
    });
  state.brand.mockResolvedValue(scope);
  state.capability.mockImplementation(() => ({ holdUntilCommit: state.holdCapability }));
  state.holdCapability.mockResolvedValue(undefined);
  state.factory.mockImplementation((source: Source) => ({
    async withCurrentReport(
      query: unknown,
      work: (value: View, tx: Transaction) => Promise<unknown>,
    ) {
      expect(query).toEqual({
        productReference: id(5),
        versionReference: id(6),
        expectedAggregateVersion: 7,
        expectedPublicationVersion: resultView.publicationVersion,
      });
      return source.transactions.run(async (tx) => {
        const common = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          productReference: id(5),
          permission: "catalog.manage" as const,
          observedAt: at,
        };
        await source.contentAuthority.holdUntilTransactionCompletes(tx, {
          ...common,
          purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
          owningAction: "catalog.product.manage",
          requiredFields: productEditorSnapshotFields,
        });
        await source.historyAuthority.holdUntilTransactionCompletes(tx, {
          ...common,
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
          owningActions: ["catalog.product.history.read"],
          requiredFields: productPublicationSourceFieldsV2,
        });
        await source.reportAuthority.holdUntilTransactionCompletes(tx, {
          ...common,
          versionReference: id(6),
          expectedAggregateVersion: 7,
          expectedPublicationVersion: resultView.publicationVersion,
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
          owningActions: ["catalog.product.read", "catalog.product.history.read"],
          requiredScope: "FullBrandScope",
          requiredFields: productPublicationValidationReportReadFields,
        });
        await source.registerBeforeCommit(
          tx,
          async () => {
            await Promise.resolve();
            events.push("source-final");
            state.laterGuard?.();
          },
          () => undefined,
        );
        if (state.mode === "caught-wrong-hook-tx") {
          try {
            await source.registerBeforeCommit(
              { query: tx.query },
              async () => undefined,
              () => undefined,
            );
          } catch {
            /* The original read must remain poisoned even when caught. */
          }
        }
        if (state.mode === "none") return resultView;
        const result = await work(
          { ...resultView, ...state.changed },
          state.mode === "wrong-tx" ? { query: tx.query } : tx,
        );
        if (state.mode === "twice") await work(resultView, tx);
        if (state.mode === "caught-twice") {
          try {
            await work(resultView, tx);
          } catch {
            /* Test a swallowed callback failure. */
          }
        }
        state.completed = true;
        return state.mode === "rebound" ? { ...(result as object) } : result;
      });
    },
  }));
  const options = {
      merchant: {
        now: () => now,
        transactions: {
          async run(work) {
            events.push("begin");
            const result = await work({
              async query() {
                return { rows: [] };
              },
            });
            events.push("commit");
            return result;
          },
        },
      } as Options["merchant"],
      authentication: { authorize: authenticate } as unknown as Options["authentication"],
      contentAuthority: { holdUntilTransactionCompletes: content },
      historyAuthority: { holdUntilTransactionCompletes: history },
      reportAuthority: { holdUntilTransactionCompletes: report },
      holdScreenUntilCommit: screen,
    } satisfies Options,
    request = {
      sessionCookie: "Synthetic opaque credential",
      csrf: "Synthetic csrf",
      query: {
        productReference: id(5),
        versionReference: id(6),
        expectedAggregateVersion: 7,
        expectedPublicationVersion: resultView.publicationVersion,
      },
      expectedScope: { brandReference: id(2), storeReference: id(3) },
    };
  return {
    options,
    request,
    resultView,
    events,
    authenticate,
    action,
    scope,
    screen,
    content,
    history,
    report,
    setNow(value: string) {
      now = value;
    },
  };
}
beforeEach(() => {
  state.factory.mockReset();
  state.brand.mockReset();
  state.capability.mockReset();
  state.holdCapability.mockReset();
  state.completed = false;
  state.mode = "normal";
  state.changed = {};
  state.laterGuard = undefined;
});

it.each(["NotValidated", "NotRecorded", "Recorded"] as const)(
  "returns actual %s facts through exactly one owner facade and final authorities",
  async (status) => {
    const f = setup(status),
      result = await createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request);
    expect(result).toEqual(f.resultView);
    expect(state.factory).toHaveBeenCalledTimes(1);
    expect(f.events.slice(-6)).toEqual([
      "final-screen",
      "final-content",
      "final-history",
      "final-report",
      "source-final",
      "commit",
    ]);
    expect(f.screen.mock.calls[0]?.[1]).toMatchObject({
      storeReference: id(3),
      sessionReference: id(9),
      versionReference: id(6),
      screenId: "CAT-PRODUCT-EDIT",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_VALIDATION_REPORT_READ",
      requiredFields: productPublicationValidationReportReadFields,
    });
    expect(state.factory.mock.calls[0]?.[0]).toMatchObject({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
    });
    if (status === "Recorded") {
      expect(result.report?.validation.validUntil).toBe("2026-10-03T11:00:05.000Z");
      expect(result.validUntil).toBe(until);
      expect(result.eligibility).toBe("NotEvaluated");
    }
  },
);

it.each([
  null,
  {},
  {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 0,
    expectedPublicationVersion: 0,
  },
  {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 7,
    expectedPublicationVersion: -1,
  },
  {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 7,
    expectedPublicationVersion: 0,
    tenantReference: id(1),
  },
])("rejects closed request before authentication %#", async (query) => {
  const f = setup();
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)({ ...f.request, query }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.authenticate).not.toHaveBeenCalled();
  expect(state.factory).not.toHaveBeenCalled();
});
it("refuses accessors without invoking them", async () => {
  const f = setup(),
    getter = vi.fn(),
    query = { ...f.request.query };
  Object.defineProperty(query, "versionReference", { enumerable: true, get: getter });
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)({ ...f.request, query }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
});
it.each(["brandReference", "storeReference"])(
  "rejects a different selected %s before owner reads",
  async (key) => {
    const f = setup();
    await expect(
      createMerchantProductPublicationValidationReportQueryV2(f.options)({
        ...f.request,
        expectedScope: { ...f.request.expectedScope, [key]: id(99) },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it.each([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.sku.read",
  "catalog.product.history.read",
])("requires current Brand %s including outer commit", async (required) => {
  for (const late of [false, true]) {
    const f = setup();
    f.action.mockImplementation(async (action) => ({
      effect: action === required && (!late || state.completed) ? "Deny" : "Allow",
      scopeKind: "Brand",
      action,
    }));
    await expect(
      createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.events).not.toContain("commit");
    state.completed = false;
  }
});
it.each(["Store", "wrong-action"])("rejects substituted %s authority evidence", async (mode) => {
  const f = setup();
  f.action.mockImplementation(async (action) => ({
    effect: "Allow",
    action: mode === "wrong-action" ? "catalog.product.update" : action,
    scopeKind: mode === "Store" ? "Store" : "Brand",
  }));
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(state.factory).not.toHaveBeenCalled();
});
it.each(["screen", "content", "history", "report"] as const)(
  "drops the read after final %s denial or expiry",
  async (key) => {
    for (const mode of ["deny", "expire"]) {
      const f = setup();
      f[key].mockImplementation(async () => {
        if (state.completed) {
          if (mode === "deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
          f.setNow(until);
        }
      });
      await expect(
        createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
      ).rejects.toMatchObject({
        code: mode === "deny" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.events).not.toContain("commit");
      state.completed = false;
    }
  },
);
it("refuses commit when a later async owner guard consumes the already-checked original lease", async () => {
  const f = setup();
  state.laterGuard = () => f.setNow(until);
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toContain("final-report");
  expect(f.events).toContain("source-final");
  expect(f.events).not.toContain("commit");
});
it.each(["none", "twice", "caught-twice", "wrong-tx", "caught-wrong-hook-tx", "rebound"])(
  "requires exact callback, transaction and result identity: %s",
  async (mode) => {
    const f = setup();
    state.mode = mode;
    await expect(
      createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.events).not.toContain("commit");
  },
);
it("rejects a backwards clock during the final owner phase", async () => {
  const f = setup();
  state.laterGuard = () => f.setNow("2026-10-03T11:59:59.999Z");
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).not.toContain("commit");
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "productReference",
  "versionReference",
  "aggregateVersion",
  "publicationVersion",
])("rejects a fully rehashed but mismatched owning %s", async (key) => {
  const f = setup(),
    raw = { ...f.resultView, [key]: key.endsWith("Version") ? 8 : id(99) },
    { digest: ignored, ...body } = raw;
  void ignored;
  state.changed = seal(body);
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).not.toContain("commit");
});
it.each([
  "contentAuthority",
  "historyAuthority",
  "reportAuthority",
  "holdScreenUntilCommit",
] as const)("requires configured %s", (key) => {
  const f = setup();
  expect(() =>
    createMerchantProductPublicationValidationReportQueryV2({
      ...f.options,
      [key]: undefined,
    } as unknown as Options),
  ).toThrow();
});
it("captures collaborators and clock without requiring mutation or publication grants", async () => {
  const f = setup(),
    read = createMerchantProductPublicationValidationReportQueryV2(f.options),
    replaced = vi.fn(() => {
      throw Error("replaced");
    });
  for (const authority of [
    f.options.contentAuthority,
    f.options.historyAuthority,
    f.options.reportAuthority,
  ])
    Object.assign(authority, { holdUntilTransactionCompletes: replaced });
  Object.assign(f.options.authentication, { authorize: replaced });
  Object.assign(f.options, { holdScreenUntilCommit: replaced });
  Object.assign(f.options.merchant, { now: () => until });
  Object.assign(f.options.merchant.transactions, { run: replaced });
  expect(await read(f.request)).toEqual(f.resultView);
  expect(replaced).not.toHaveBeenCalled();
  expect(f.action.mock.calls.some(([action]) => /\.(?:create|update|publish)$/u.test(action))).toBe(
    false,
  );
});
it("sanitizes session denial and private source errors", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const g = setup();
  g.report.mockRejectedValue(Error("SYNTHETIC_PRIVATE"));
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(g.options)(g.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("suppresses transport when the original read expires during outer transaction completion", async () => {
  const f = setup(),
    run = f.options.merchant.transactions.run;
  f.options.merchant.transactions.run = async (work) => {
    const result = await run(work);
    f.setNow(until);
    return result;
  };
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toContain("commit"); // Read only, no post-COMMIT rollback claim.
});

function runtimeOptions(f: ReturnType<typeof setup>): Options {
  return {
    merchant: f.options.merchant,
    authentication: f.options.authentication,
    currentRuntime: true,
  };
}
it.each(["NotValidated", "NotRecorded", "Recorded"] as const)(
  "runtime read returns exact %s recorded facts without renewing historic validation",
  async (status) => {
    const f = setup(status);
    const result = await createMerchantProductPublicationValidationReportQueryV2(runtimeOptions(f))(
      f.request,
    );
    expect(result).toEqual(f.resultView);
    expect(result.eligibility).toBe("NotEvaluated");
    expect(state.factory).toHaveBeenCalledOnce();
    expect(state.capability).toHaveBeenCalledOnce();
    expect(state.capability.mock.calls[0]?.[0]).toMatchObject({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      originalValidUntil: until,
    });
    for (const legacy of [f.screen, f.content, f.history, f.report])
      expect(legacy).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("commit");
    if (status === "Recorded")
      expect(result.report?.validation.validUntil).toBe("2026-10-03T11:00:05.000Z");
  },
);
it.each([
  "contentAuthority",
  "historyAuthority",
  "reportAuthority",
  "holdScreenUntilCommit",
] as const)("runtime report read refuses mixed legacy %s", (key) => {
  const f = setup();
  expect(() =>
    createMerchantProductPublicationValidationReportQueryV2({
      ...runtimeOptions(f),
      [key]: f.options[key],
    }),
  ).toThrow();
  expect(state.factory).not.toHaveBeenCalled();
});
it("runtime report read refuses permission revoked after its actual report callback", async () => {
  const f = setup("Recorded");
  f.action.mockImplementation(async (action) => ({
    effect: state.completed ? "Deny" : "Allow",
    action,
    scopeKind: "Brand",
  }));
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(state.completed).toBe(true);
  expect(f.events).not.toContain("commit");
});
it("runtime report read expires in the global final phase after a later owning guard", async () => {
  const f = setup("Recorded");
  state.laterGuard = () => {
    f.setNow(until);
  };
  await expect(
    createMerchantProductPublicationValidationReportQueryV2(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).toContain("source-final");
  expect(f.events).not.toContain("commit");
});
