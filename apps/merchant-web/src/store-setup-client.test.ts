import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Pure owning fixture parity only; the production browser imports no RMS runtime.
import { parseStoreSetupDraftContent } from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  createUnconfiguredStoreSetupContentV2,
  normalizeStoreSetupContentV2,
  parseStoreSetupSnapshot,
  parseStoreSetupContent,
  parseStoreSetupWorkspace,
  parseStoreSetupCursor,
  validateStoreSetupReceipt,
} from "./store-setup-client.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z",
  csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const content = () => createUnconfiguredStoreSetupContent();
const input = () => ({
  expectedScope: scope,
  operationReference: id(5),
  expectedSetupReference: null,
  expectedRevision: 0,
  content: content(),
});
function workspace(snapshot: unknown = null) {
  return {
    profile: "StoreSetupWorkspaceV1",
    scope,
    store: {
      storeReference: id(3),
      code: "SYNTH_STORE",
      displayName: "Synthetic store",
      locale: "en-CA",
      currencyCode: "CAD",
      timeZone: "America/Toronto",
      version: 1,
    },
    setup: {
      profile: "StoreSetupCurrentV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      readerActorReference: id(4),
      snapshot,
      observedAt: at,
      validUntil: until,
      businessReferenceValidation: "NotEvaluated",
    },
  };
}
function snapshot(value = content()) {
  return {
    profile: "StoreSetupDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    setupDraftReference: id(6),
    revision: 1,
    authoredByReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    baseConfigurationReference: null,
    content: value,
    createdAt: at,
    updatedAt: at,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  };
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
async function receipt(outcome: "Committed" | "Abandoned" = "Committed") {
  const prepared = await createStoreSetupClient().prepare(input());
  return {
    profile: "StoreSetupOperationReceiptV1",
    ...scope,
    operationReference: id(5),
    expectedSetupReference: null,
    expectedRevision: 0,
    purposeCode: "STORE_SETUP_DRAFT",
    intentDigest: prepared.intentDigest,
    outcome,
    snapshot: outcome === "Committed" ? snapshot() : null,
    auditReference: id(7),
    occurredAt: at,
  };
}
it("initial current read obtains true full scope with no guessed Actor or CSRF", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(workspace()));
  const view = await createStoreSetupClient(fetcher).load({ storeReference: id(3) });
  expect(view.scope).toEqual(scope);
  expect(view.setup.snapshot).toBeNull();
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/merchant/store-setup?storeReference=${id(3)}`);
});
it("history author is distinct from current reader", () => {
  const saved = { ...snapshot(), authoredByReference: id(8) };
  expect(
    parseStoreSetupWorkspace(workspace(saved), id(3), scope).setup.snapshot?.authoredByReference,
  ).toBe(id(8));
});
it("retains all 15 unconfigured fields without filling facts or claiming validity", () => {
  expect(Object.keys(content())).toHaveLength(15);
  expect(content().capacityConfigurationReference).toEqual({ state: "Unconfigured" });
  const parsed = parseStoreSetupContent({
    ...content(),
    capacityConfigurationReference: { state: "Configured", value: null },
    effectiveUntil: { state: "Configured", value: null },
  });
  expect(parsed.capacityConfigurationReference).toEqual({ state: "Configured", value: null });
  expect(parsed.effectiveUntil).toEqual({ state: "Configured", value: null });
});
it("matches owning canonical schedule, modes and date ordering before hashing original", async () => {
  const interval = {
    startLocalTime: "09:00:00",
    endLocalTime: "17:00:00",
    endsNextDay: false,
    serviceModes: ["Delivery", "Pickup"],
    orderCutoffSeconds: 600,
    leadTimeSeconds: 900,
  };
  const value = {
    ...content(),
    enabledServiceModes: { state: "Configured", value: ["Delivery", "Pickup"] },
    weeklySchedule: {
      state: "Configured",
      value: Array.from({ length: 7 }, (_, i) => ({
        isoWeekday: i + 1,
        intervals: i === 0 ? [interval] : [],
      })),
    },
    exceptions: {
      state: "Configured",
      value: [
        { localDate: "2026-12-25", kind: "Holiday", intervals: [] },
        { localDate: "2026-11-01", kind: "TemporaryClosure", intervals: [] },
      ],
    },
  };
  expect(await publicationValueDigest(parseStoreSetupContent(value))).toBe(
    await publicationValueDigest(parseStoreSetupDraftContent(value)),
  );
});
it.each([
  { timeZone: { state: "Configured", value: "Mars/Unknown" } },
  { capacityConfigurationReference: { state: "Configured", value: "unknown" } },
  { contactReference: { state: "Configured", value: null } },
  { weeklySchedule: { state: "Configured", value: [] } },
  { source: { state: "Configured", value: "Default" } },
  { extraReference: id(8) },
])("refuses invalid partial shape %j", (change) =>
  expect(() => parseStoreSetupContent({ ...content(), ...change })).toThrow(),
);
it("retains the accepted 366-day schedule bound beyond the Product copy budget", () => {
  const intervals = Array.from({ length: 16 }, (_, i) => ({
    startLocalTime: `${String(i).padStart(2, "0")}:00:00`,
    endLocalTime: `${String(i).padStart(2, "0")}:30:00`,
    endsNextDay: false,
    serviceModes: ["Pickup"],
    orderCutoffSeconds: 0,
    leadTimeSeconds: 0,
  }));
  const value = {
    ...content(),
    exceptions: {
      state: "Configured",
      value: Array.from({ length: 366 }, (_, i) => ({
        localDate: new Date(Date.UTC(2028, 0, 1 + i)).toISOString().slice(0, 10),
        kind: "Override",
        intervals,
      })),
    },
  };
  expect(parseStoreSetupContent(value).exceptions).toEqual(
    parseStoreSetupDraftContent(value).exceptions,
  );
});
it("refuses accessors and sparse schedules without invoking accessors", () => {
  const value = { ...content() };
  let called = false;
  Object.defineProperty(value, "timeZone", {
    enumerable: true,
    get() {
      called = true;
      return { state: "Unconfigured" };
    },
  });
  expect(() => parseStoreSetupContent(value)).toThrow();
  expect(called).toBe(false);
  expect(() =>
    parseStoreSetupContent({
      ...content(),
      weeklySchedule: { state: "Configured", value: new Array(7) },
    }),
  ).toThrow();
});
it("prepares detached original before transport and POST strips server scope/profile/purpose", async () => {
  const body = input();
  const fetcher = vi.fn<typeof fetch>(async () => response(await receipt()));
  const client = createStoreSetupClient(fetcher);
  const prepared = await client.prepare(body);
  body.content = { ...content(), timeZone: { state: "Configured", value: "America/Toronto" } };
  expect(prepared.command.content.timeZone.state).toBe("Unconfigured");
  expect(fetcher).not.toHaveBeenCalled();
  const result = await client.execute(prepared, { csrf });
  expect(result.outcome).toBe("Committed");
  const request = fetcher.mock.calls[0]?.[1];
  expect(Object.keys(JSON.parse(String(request?.body)))).toEqual([
    "command",
    "content",
    "expectedRevision",
    "expectedSetupReference",
    "operationReference",
  ]);
  expect(request?.credentials).toBe("same-origin");
  expect((request?.headers as Record<string, string>)["X-BOP-CSRF"]).toBe(csrf);
  const header = (request?.headers as Record<string, string>)["X-BOP-Store-Setup-Scope"];
  if (!header) throw new Error("missing exact setup scope header");
  expect(header).not.toContain("=");
  expect(JSON.parse(atob(header.replace(/-/gu, "+").replace(/_/gu, "/")))).toEqual(scope);
  expect((request?.headers as Record<string, string>)["X-BOP-Catalog-Scope"]).toBeUndefined();
});
it("Resolve sends payload-free original operation and validates historical committed digest", async () => {
  const prepared = await createStoreSetupClient().prepare(input());
  const fetcher = vi.fn<typeof fetch>(async () => response(await receipt()));
  await createStoreSetupClient(fetcher).resolve(prepared.cursor, { csrf });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.command).toBe("ResolveOriginal");
  expect(body.intentDigest).toBe(prepared.intentDigest);
  expect(body).not.toHaveProperty("content");
  const forged = await receipt();
  await expect(
    validateStoreSetupReceipt(
      {
        ...forged,
        snapshot: snapshot({
          ...content(),
          timeZone: { state: "Configured", value: "America/Toronto" },
        }),
      },
      prepared.cursor,
    ),
  ).rejects.toHaveProperty("code", "Invalid");
});
it.each([403, 409, 400])(
  "preserves finite rejected response %i instead of clearing original",
  async (status) => {
    const prepared = await createStoreSetupClient().prepare(input());
    await expect(
      createStoreSetupClient(async () => response({}, status)).execute(prepared, { csrf }),
    ).rejects.toHaveProperty(
      "code",
      status === 403 ? "Denied" : status === 409 ? "Conflict" : "Invalid",
    );
  },
);
it("network or aborted dispatched POST remains unknown", async () => {
  const prepared = await createStoreSetupClient().prepare(input());
  await expect(
    createStoreSetupClient(async () => {
      throw new Error("synthetic network");
    }).execute(prepared, { csrf }),
  ).rejects.toHaveProperty("code", "OutcomeUnknown");
  const signal = new AbortController();
  const client = createStoreSetupClient(async () => {
    signal.abort();
    return response(await receipt());
  });
  await expect(client.execute(prepared, { csrf, signal: signal.signal })).rejects.toHaveProperty(
    "code",
    "OutcomeUnknown",
  );
});
it("invalid prepared identity cannot dispatch even with matching claimed digest", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createStoreSetupClient(fetcher),
    prepared = await client.prepare(input());
  await expect(
    client.execute(
      { ...prepared, command: { ...prepared.command, actorReference: id(8) } },
      { csrf },
    ),
  ).rejects.toHaveProperty("code", "ScopeChanged");
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => parseStoreSetupCursor({ ...prepared.cursor, content: content() })).toThrow();
});
it("rejects drifted actual scope and expired current observation", async () => {
  await expect(
    createStoreSetupClient(async () =>
      response({ ...workspace(), scope: { ...scope, actorReference: id(8) } }),
    ).load({ storeReference: id(3), expectedScope: scope }),
  ).rejects.toHaveProperty("code", "ScopeChanged");
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(until));
  await expect(
    createStoreSetupClient(async () => response(workspace())).load({ storeReference: id(3) }),
  ).rejects.toHaveProperty("code", "Stale");
});
it("late old-scope read is suppressed after another store request", async () => {
  let release: ((value: Response) => void) | undefined;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(response({}));
  const client = createStoreSetupClient(fetcher),
    old = client.load({ storeReference: id(3) });
  await expect(client.load({ storeReference: id(8) })).rejects.toThrow();
  if (!release) throw new Error("missing controlled response");
  release(response(workspace()));
  await expect(old).rejects.toHaveProperty("code", "ScopeChanged");
});

it("CSRF session context mutation suppresses a late result", async () => {
  let release: ((value: Response) => void) | undefined;
  const client = createStoreSetupClient(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const options = { storeReference: id(3), csrf };
  const pending = client.load(options);
  options.csrf = "B".repeat(43);
  if (!release) throw new Error("missing controlled request");
  release(response(workspace()));
  await expect(pending).rejects.toHaveProperty("code", "ScopeChanged");
});
it("a malformed committed response remains unknown and a pre-aborted POST does not dispatch", async () => {
  const prepared = await createStoreSetupClient().prepare(input());
  await expect(
    createStoreSetupClient(async () => response({})).execute(prepared, { csrf }),
  ).rejects.toHaveProperty("code", "OutcomeUnknown");
  const signal = new AbortController();
  signal.abort();
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createStoreSetupClient(fetcher).execute(prepared, { csrf, signal: signal.signal }),
  ).rejects.toHaveProperty("code", "Unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["GET", "POST"] as const)(
  "%s cancels an oversized chunked response before reading its remaining chunks",
  async (method) => {
    let pulls = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls === 1 ? 4194304 : 1).fill(32));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const client = createStoreSetupClient(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const prepared = await client.prepare(input());
    await expect(
      method === "GET"
        ? client.load({ storeReference: id(3) })
        : client.execute(prepared, { csrf }),
    ).rejects.toHaveProperty("code", method === "GET" ? "Unavailable" : "OutcomeUnknown");
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it.each(["GET", "POST"] as const)(
  "%s rejects invalid UTF-8 and cancels the response",
  async (method) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([0xc3, 0x28]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const client = createStoreSetupClient(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const prepared = await client.prepare(input());
    await expect(
      method === "GET"
        ? client.load({ storeReference: id(3) })
        : client.execute(prepared, { csrf }),
    ).rejects.toHaveProperty("code", method === "GET" ? "Unavailable" : "OutcomeUnknown");
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it.each(["GET", "POST"] as const)(
  "%s cancels an aborted response reader without accepting a late result",
  async (method) => {
    const signal = new AbortController(),
      cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          signal.abort();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const client = createStoreSetupClient(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    const prepared = await client.prepare(input());
    await expect(
      method === "GET"
        ? client.load({ storeReference: id(3), signal: signal.signal })
        : client.execute(prepared, { csrf, signal: signal.signal }),
    ).rejects.toHaveProperty("code", method === "GET" ? "Unavailable" : "OutcomeUnknown");
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it("preserves legacy content and binds each snapshot/save profile to its exact content generation", async () => {
  const legacy = content(),
    modern = createUnconfiguredStoreSetupContentV2();
  expect(Object.keys(legacy)).toHaveLength(15);
  expect(Object.keys(modern)).toHaveLength(16);
  expect(modern.feeContexts).toEqual({ state: "Unconfigured" });
  expect(normalizeStoreSetupContentV2(legacy)).toEqual(modern);
  expect(Object.hasOwn(legacy, "feeContexts")).toBe(false);
  expect(parseStoreSetupSnapshot(snapshot(legacy)).profile).toBe("StoreSetupDraftV1");
  expect(
    parseStoreSetupSnapshot({ ...snapshot(modern), profile: "StoreSetupDraftV2" }).content,
  ).toEqual(modern);
  expect(() => parseStoreSetupSnapshot(snapshot(modern))).toThrow();
  expect(() =>
    parseStoreSetupSnapshot({ ...snapshot(legacy), profile: "StoreSetupDraftV2" }),
  ).toThrow();
  const client = createStoreSetupClient(vi.fn<typeof fetch>());
  expect((await client.prepare(input())).command.profile).toBe("StoreSetupSaveV1");
  expect((await client.prepare({ ...input(), content: modern })).command.profile).toBe(
    "StoreSetupSaveV2",
  );
});
it("parses canonical three fee contexts without inserting disabled states or losing Delivery", () => {
  const fees = [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(20),
      orderTypes: ["Delivery", "DineIn"],
    },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Unconfigured" },
  ];
  const parsed = parseStoreSetupContent({
    ...content(),
    feeContexts: { state: "Configured", value: fees },
  });
  expect(parsed).toEqual(
    parseStoreSetupDraftContent({
      ...content(),
      feeContexts: { state: "Configured", value: fees },
    }),
  );
  expect(parsed.feeContexts).toEqual({
    state: "Configured",
    value: [{ ...fees[0], orderTypes: ["DineIn", "Delivery"] }, fees[1], fees[2]],
  });
  for (const value of [
    fees.slice(0, 2),
    [fees[1], fees[0], fees[2]],
    [{ ...fees[0], orderTypes: [] }, fees[1], fees[2]],
    [{ ...fees[0], rate: "0.13" }, fees[1], fees[2]],
    [fees[0], { ...fees[1], taxClassificationReference: id(21) }, fees[2]],
  ]) {
    expect(() =>
      parseStoreSetupContent({ ...content(), feeContexts: { state: "Configured", value } }),
    ).toThrow();
  }
  const get = vi.fn(() => id(20)),
    entry = { ...fees[0] };
  Object.defineProperty(entry, "taxClassificationReference", { enumerable: true, get });
  expect(() =>
    parseStoreSetupContent({
      ...content(),
      feeContexts: { state: "Configured", value: [entry, fees[1], fees[2]] },
    }),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("verifies V2 originals and immutable receipts with their V2 hash while retaining exact V1 recovery", async () => {
  const client = createStoreSetupClient(vi.fn<typeof fetch>());
  for (const value of [content(), createUnconfiguredStoreSetupContentV2()]) {
    const p = await client.prepare({ ...input(), content: value });
    const r = {
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: p.cursor.operationReference,
      expectedSetupReference: null,
      expectedRevision: 0,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: p.intentDigest,
      outcome: "Committed",
      snapshot: {
        ...snapshot(value),
        profile:
          p.command.profile === "StoreSetupSaveV2" ? "StoreSetupDraftV2" : "StoreSetupDraftV1",
      },
      auditReference: id(7),
      occurredAt: at,
    };
    expect((await validateStoreSetupReceipt(r, p.cursor)).snapshot?.content).toEqual(value);
    const altered = {
      ...r,
      snapshot: {
        ...r.snapshot,
        content: createUnconfiguredStoreSetupContentV2(),
        profile: "StoreSetupDraftV2",
      },
    };
    if (p.command.profile === "StoreSetupSaveV1")
      await expect(validateStoreSetupReceipt(altered, p.cursor)).rejects.toThrow();
  }
});
function feeChoices() {
  return {
    profile: "TaxConfigClassificationChoicesV1",
    ...scope,
    registryReference: id(30),
    versionReference: id(31),
    registryVersion: 1,
    snapshotDigest: "sha256:" + "a".repeat(64),
    defaultLocale: "en-CA",
    choices: [
      {
        classificationReference: id(20),
        code: "SYNTH_CLASS",
        localizedNames: { "en-CA": "Synthetic classification" },
        lifecycle: "Active",
      },
    ],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated",
  };
}
it("loads optional fee choices with the actual selected scope header, fresh closed source and no CSRF/body", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(feeChoices()));
  const result = await createStoreSetupClient(fetcher).classifications({
    storeReference: id(3),
    expectedScope: scope,
  });
  expect(result.choices[0]?.code).toBe("SYNTH_CLASS");
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe(
    `/merchant/store-setup/fee-context-classifications?storeReference=${id(3)}`,
  );
  expect(call?.[1]).toEqual(
    expect.objectContaining({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: expect.objectContaining({
        "X-BOP-Store-Setup-Scope": btoa(
          JSON.stringify({
            actorReference: scope.actorReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            tenantReference: scope.tenantReference,
          }),
        )
          .replace(/\+/gu, "-")
          .replace(/\//gu, "_")
          .replace(/=+$/u, ""),
      }),
    }),
  );
  expect(call?.[1]?.body).toBeUndefined();
  for (const changed of [{ actorReference: id(8) }, { validUntil: at }, { qualified: true }]) {
    await expect(
      createStoreSetupClient(async () => response({ ...feeChoices(), ...changed })).classifications(
        { storeReference: id(3), expectedScope: scope },
      ),
    ).rejects.toThrow();
  }
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    createStoreSetupClient(fetcher).classifications({
      storeReference: id(3),
      expectedScope: scope,
      signal: aborted.signal,
    }),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects forged save generation before dispatch and suppresses stale fee choices after Actor switch", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(feeChoices()));
  const client = createStoreSetupClient(fetcher),
    prepared = await client.prepare({
      ...input(),
      content: createUnconfiguredStoreSetupContentV2(),
    });
  await expect(
    client.execute(
      { ...prepared, command: { ...prepared.command, profile: "StoreSetupSaveV1" } },
      { csrf },
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  let release: (value: Response) => void = () => undefined;
  const delayed = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const nextScope = { ...scope, actorReference: id(8) },
    request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => delayed)
      .mockImplementationOnce(async () => response({ ...feeChoices(), ...nextScope }));
  const actual = createStoreSetupClient(request);
  const old = actual.classifications({ storeReference: id(3), expectedScope: scope });
  const oldFailure = expect(old).rejects.toMatchObject({ code: "ScopeChanged" });
  await actual.classifications({ storeReference: id(3), expectedScope: nextScope });
  release(response(feeChoices()));
  await oldFailure;
});
