// Controlled HTTP facts; this suite does not prove live Session/IAM or PostgreSQL composition.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createStoreConfigurationOrdinaryClient,
  parseStoreConfigurationOrdinaryHistory,
  type StoreConfigurationOrdinaryCommand,
} from "./store-configuration-ordinary-client.js";
import {
  validateStoreConfigurationOriginalCursor,
  validateStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationOriginalCursor,
} from "./store-configuration-pending-journal.js";
import {
  canonicalPublicationValue,
  publicationValueDigest,
} from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(20),
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
  reasonCode: "SETUP_MATERIALIZATION",
  authoredByReference: id(4),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});

const setupSelector = {
  setupDraftReference: id(30),
  sourceRevision: 1,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
};
const basis = {
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(1),
  ...setupSelector,
  feeContexts: [
    { chargeType: "ServiceCharge", state: "Disabled" },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
};
async function original(
  operationReference = id(90),
  action: "Materialize" | "Validate" | "Submit" | "Approve" | "Publish" = "Materialize",
) {
  const command = {
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope,
    operationReference,
    action,
    expectedHead:
      action === "Materialize"
        ? { configurationReference: null, configurationVersion: 0, contentDigest: null }
        : {
            configurationReference: id(20),
            configurationVersion: 1,
            contentDigest: await publicationValueDigest(configuration("Draft")),
          },
    ...(action === "Materialize" ? { setupSelector, reasonCode: "SETUP_MATERIALIZATION" } : {}),
  };
  return validateStoreConfigurationOriginalCursor({
    ...command,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: await publicationValueDigest(command),
  });
}
async function terminal(cursor: StoreConfigurationOriginalCursor, abandoned = false) {
  const snapshot = {
    ...configuration(
      cursor.action === "Submit"
        ? "PendingApproval"
        : cursor.action === "Approve"
          ? "Approved"
          : cursor.action === "Publish"
            ? "Published"
            : "Draft",
    ),
    ...(cursor.action === "Materialize" ? { setupBasis: basis } : {}),
  };
  return validateStoreConfigurationOrdinaryReceipt(
    {
      ...cursor,
      profile: "StoreConfigurationOrdinaryReceiptV1",
      outcome: abandoned ? "Abandoned" : "Committed",
      operation: abandoned
        ? null
        : {
            command: cursor.action === "Materialize" ? "SaveDraft" : cursor.action,
            operationReference: cursor.operationReference,
            brandReference: id(2),
            storeReference: id(3),
            intentDigest: "sha256:" + "b".repeat(64),
            resultingVersion: 1,
            configuration: snapshot,
          },
      auditReference: id(91),
      occurredAt: at,
      dataClassification: "ConfigurationMetadata",
    },
    cursor,
  );
}
async function workspace(
  cursor: StoreConfigurationOriginalCursor,
  abandoned = false,
  successor = false,
) {
  const receipt = await terminal(cursor, abandoned);
  const latest = successor
    ? {
        ...configuration("Draft"),
        configurationReference: id(21),
        configurationVersion: 2,
        authoredByReference: id(22),
        supersedesConfigurationReference: id(20),
      }
    : (receipt.operation?.configuration ?? null);
  return parseStoreConfigurationOrdinaryWorkspace(
    {
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest,
      current: null,
      expectedHead: latest
        ? {
            configurationReference: latest.configurationReference,
            configurationVersion: latest.configurationVersion,
            contentDigest: await publicationValueDigest(latest),
          }
        : { configurationReference: null, configurationVersion: 0, contentDigest: null },
      original: receipt,
      observedAt: at,
      validUntil: until,
      businessReferenceValidation: "NotEvaluated",
    },
    scope,
  );
}

const csrf = "a".repeat(43);
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
async function prepared(client: ReturnType<typeof createStoreConfigurationOrdinaryClient>) {
  const cursor = await original();
  const command: StoreConfigurationOrdinaryCommand = {
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope,
    operationReference: cursor.operationReference,
    action: "Materialize",
    expectedHead: cursor.expectedHead,
    setupSelector,
    reasonCode: "SETUP_MATERIALIZATION",
  };
  return client.prepare(command);
}
it("loads the actual merchant route with scoped safe GET and no CSRF", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(await workspace(await original()))),
    client = createStoreConfigurationOrdinaryClient(fetcher);
  await client.load(scope);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    "/merchant/store-configuration/ordinary?expectedStoreReference=" + scope.storeReference,
  );
  const init = fetcher.mock.calls[0]?.[1];
  expect(init).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const headers = new Headers(init?.headers);
  expect(headers.has("X-BOP-CSRF")).toBe(false);
  expect(
    JSON.parse(
      atob((headers.get("X-BOP-Store-Setup-Scope") ?? "").replace(/-/gu, "+").replace(/_/gu, "/")),
    ),
  ).toEqual(scope);
  expect(init?.body).toBeUndefined();
});
it("prepares detached scoped intent and sends the exact command wrapper", async () => {
  const cursor = await original(),
    fetcher = vi.fn<typeof fetch>(async () => response(await terminal(cursor))),
    client = createStoreConfigurationOrdinaryClient(fetcher);
  const p = await prepared(client);
  expect(fetcher).not.toHaveBeenCalled();
  expect(Object.isFrozen(p.command)).toBe(true);
  expect(p.intentDigest).toBe(await publicationValueDigest(p.command));
  await client.execute(p, { csrf });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/store-configuration/ordinary-command");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(canonicalPublicationValue({ command: p.command }));
});
it("resolves exact original pins then requires an owner-read original in fresh POST state", async () => {
  const cursor = await original(),
    fetcher = vi.fn<typeof fetch>();
  fetcher
    .mockImplementationOnce(async () => response(await terminal(cursor)))
    .mockImplementationOnce(async () => response(await workspace(cursor, false, true)));
  const client = createStoreConfigurationOrdinaryClient(fetcher);
  await client.resolve(cursor, { csrf });
  const current = await client.refreshOriginal(cursor, { csrf });
  expect(current.latest?.configurationVersion).toBe(2);
  expect(fetcher.mock.calls[1]?.[0]).toBe("/merchant/store-configuration/ordinary-state");
  expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
    canonicalPublicationValue({ original: cursor, expectedStoreReference: scope.storeReference }),
  );
  expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-BOP-CSRF")).toBe(csrf);
});
it.each([
  [400, "Invalid"],
  [403, "Denied"],
  [409, "Conflict"],
] as const)("keeps finite refusal %s distinct from an unknown reply", async (status, code) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status })),
    client = createStoreConfigurationOrdinaryClient(fetcher),
    p = await prepared(client);
  await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code });
  expect(p.cursor.operationReference).toBe(id(90));
});
it("classifies dropped writes as unknown but read-only recovery transport as unavailable", async () => {
  const client = createStoreConfigurationOrdinaryClient(
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("transport");
      }),
    ),
    p = await prepared(client);
  await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  await expect(client.refreshOriginal(p.cursor, { csrf })).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("refuses a successful receipt with different actual operation or selector pins", async () => {
  const cursor = await original(),
    actual = await terminal(cursor);
  for (const altered of [
    { ...actual, operationReference: id(99) },
    { ...actual, setupSelector: { ...setupSelector, sourceRevision: 2 } },
  ]) {
    const client = createStoreConfigurationOrdinaryClient(
        vi.fn<typeof fetch>(async () => response(altered)),
      ),
      p = await prepared(client);
    await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  }
});
it("cannot refresh-confirm a copied or missing original or an expired workspace", async () => {
  const cursor = await original(),
    fresh = await workspace(cursor);
  for (const altered of [
    { ...fresh, original: null },
    { ...fresh, validUntil: at },
    {
      ...fresh,
      expectedHead: { ...fresh.expectedHead, contentDigest: "sha256:" + "f".repeat(64) },
    },
  ]) {
    const client = createStoreConfigurationOrdinaryClient(
      vi.fn<typeof fetch>(async () => response(altered)),
    );
    await expect(client.refreshOriginal(cursor, { csrf })).rejects.toBeDefined();
  }
});
it("accepts durable Abandoned only with exact original fresh state and no fabricated configuration", async () => {
  const cursor = await original(),
    fetcher = vi.fn<typeof fetch>();
  fetcher
    .mockImplementationOnce(async () => response(await terminal(cursor, true)))
    .mockImplementationOnce(async () => response(await workspace(cursor, true)));
  const client = createStoreConfigurationOrdinaryClient(fetcher);
  expect((await client.resolve(cursor, { csrf })).outcome).toBe("Abandoned");
  expect((await client.refreshOriginal(cursor, { csrf })).latest).toBeNull();
});
it("rejects aborted, corrupt and getter controls before dispatch", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response({})),
    client = createStoreConfigurationOrdinaryClient(fetcher),
    p = await prepared(client),
    controller = new AbortController();
  controller.abort();
  await expect(client.execute(p, { csrf, signal: controller.signal })).rejects.toBeDefined();
  await expect(
    client.execute({ ...p, intentDigest: "sha256:" + "f".repeat(64) }, { csrf }),
  ).rejects.toBeDefined();
  const getter = vi.fn(() => csrf),
    opts = Object.defineProperty({}, "csrf", { enumerable: true, get: getter });
  await expect(client.execute(p, opts as { csrf: string })).rejects.toBeDefined();
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses an active late Actor switch and ignores no scope mismatch as success", async () => {
  let release: (value: Response) => void = () => undefined;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const client = createStoreConfigurationOrdinaryClient(fetcher),
    mutable = { ...scope },
    pending = client.load(mutable);
  mutable.actorReference = id(44);
  release(response(await workspace(await original())));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("invalidates a dispatched write without confirming its terminal or clearing storage", async () => {
  let release: (value: Response) => void = () => undefined,
    arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        arrive();
      }),
  );
  const client = createStoreConfigurationOrdinaryClient(fetcher),
    p = await prepared(client),
    pending = client.execute(p, { csrf });
  await arrived;
  client.invalidate();
  release(response(await terminal(p.cursor)));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(p.cursor.intentDigest).toBe(p.intentDigest);
});
it("rejects cached or malformed successful write replies instead of fabricating a receipt", async () => {
  const cursor = await original();
  for (const reply of [
    new Response("{}", {
      headers: { "Content-Type": "application/json", "Cache-Control": "public" },
    }),
    response({ ...(await terminal(cursor)), extra: true }),
    new Response("{", {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  ]) {
    const client = createStoreConfigurationOrdinaryClient(vi.fn<typeof fetch>(async () => reply)),
      p = await prepared(client);
    await expect(client.execute(p, { csrf })).rejects.toMatchObject({ code: "OutcomeUnknown" });
  }
});

function historyPage(beforeSequence: number | null = null) {
  const entries = [
    {
      sequenceNumber: 3,
      operationReference: id(71),
      command: "Validate",
      configuration: configuration("Draft"),
      intentDigest: "sha256:" + "b".repeat(64),
      actorReference: id(40),
      purposeCode: "LEGACY_STORE_SETUP",
      auditReference: id(72),
      occurredAt: at,
      expectedVersion: 1,
    },
    {
      sequenceNumber: 2,
      operationReference: id(73),
      command: "SaveDraft",
      configuration: configuration("Draft"),
      intentDigest: "sha256:" + "c".repeat(64),
      actorReference: id(41),
      purposeCode: "STORE_CONFIGURATION",
      auditReference: id(74),
      occurredAt: at,
      expectedVersion: 0,
    },
  ];
  return {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    readerActorReference: scope.actorReference,
    beforeSequence,
    entries,
    nextBeforeSequence: 2,
    observedAt: at,
    validUntil: until,
  };
}
it("reads true paginated history by CSRF POST without cursor URL and keeps original authors distinct", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(historyPage())),
    client = createStoreConfigurationOrdinaryClient(fetcher);
  const page = await client.history(scope, { beforeSequence: null, csrf });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/store-configuration/ordinary-history");
  expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
    canonicalPublicationValue({
      expectedStoreReference: scope.storeReference,
      beforeSequence: null,
    }),
  );
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-BOP-CSRF")).toBe(csrf);
  expect(page.readerActorReference).toBe(scope.actorReference);
  expect(page.entries[0]?.actorReference).toBe(id(40));
  expect(page.entries[0]?.purposeCode).toBe("LEGACY_STORE_SETUP");
  expect(Object.isFrozen(page.entries)).toBe(true);
});
it("history parser refuses oversized pages wrong ordering selectors leases scope and altered configuration", () => {
  const page = historyPage(),
    first = page.entries[0],
    second = page.entries[1];
  if (!first || !second) throw new Error("history fixtures absent");
  expect(parseStoreConfigurationOrdinaryHistory(page, scope, null).entries).toHaveLength(2);
  for (const invalid of [
    { ...page, entries: [first, second, first] },
    { ...page, entries: [second, first] },
    { ...page, entries: [first, { ...second, sequenceNumber: 3 }] },
    { ...page, nextBeforeSequence: 1 },
    { ...page, readerActorReference: id(88) },
    { ...page, validUntil: at },
    { ...page, entries: [{ ...first, expectedVersion: 0 }, second] },
    {
      ...page,
      entries: [
        { ...first, configuration: { ...first.configuration, storeReference: id(88) } },
        second,
      ],
    },
    { ...page, extra: true },
  ])
    expect(() => parseStoreConfigurationOrdinaryHistory(invalid, scope, null)).toThrow();
  expect(() => parseStoreConfigurationOrdinaryHistory(page, scope, 3)).toThrow();
});
it("history rejects accessor output without executing it and preserves accepted historical purposes", () => {
  const page = historyPage(),
    getter = vi.fn(() => page.entries),
    raw = Object.defineProperty({ ...page }, "entries", { enumerable: true, get: getter });
  expect(() => parseStoreConfigurationOrdinaryHistory(raw, scope, null)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(
    parseStoreConfigurationOrdinaryHistory(
      { ...page, entries: [], nextBeforeSequence: null },
      scope,
      null,
    ).entries,
  ).toEqual([]);
});
it("history denial and dropped readonly transport never become unknown write outcomes", async () => {
  const denied = createStoreConfigurationOrdinaryClient(
    vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 })),
  );
  await expect(denied.history(scope, { beforeSequence: null, csrf })).rejects.toMatchObject({
    code: "Denied",
  });
  const dropped = createStoreConfigurationOrdinaryClient(
    vi.fn<typeof fetch>(async () => {
      throw new TypeError("transport");
    }),
  );
  await expect(dropped.history(scope, { beforeSequence: 3, csrf })).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("history late actual reader scope or selector mutation cannot display a page from the previous request", async () => {
  let release: (value: Response) => void = () => undefined;
  const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
    client = createStoreConfigurationOrdinaryClient(fetcher),
    options = { beforeSequence: null as number | null, csrf };
  const pending = client.history(scope, options);
  options.beforeSequence = 2;
  release(response(historyPage()));
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
});
