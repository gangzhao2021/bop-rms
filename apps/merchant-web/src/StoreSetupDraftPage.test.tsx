import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferencesCurrent,
  type StoreSetupReferenceCursor,
} from "./store-setup-reference-client.js";
import type { StoreSetupReferencePendingJournal } from "./store-setup-reference-pending-journal.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  StoreSetupDraftPage,
  StoreSetupFeeContextEditor,
  validateStoreSetupFeeSelections,
  StoreSetupReferenceEditor,
  dispatchStoreSetupReference,
  recoverStoreSetupReference,
  StoreSetupDraftReview,
  buildStoreSetupEditedContent,
  dispatchStoreSetupDraft,
  recoverStoreSetupDraft,
  type StoreSetupEditorInputs,
} from "./StoreSetupDraftPage.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  createUnconfiguredStoreSetupContentV2,
  normalizeStoreSetupContentV2,
  parseStoreSetupWorkspace,
  StoreSetupClientError,
  type StoreSetupCursor,
  type StoreSetupSnapshot,
} from "./store-setup-client.js";
import { type StoreSetupPendingJournal } from "./store-setup-pending-journal.js";
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
const empty = (): StoreSetupEditorInputs => ({
  timeZone: "",
  businessStart: "",
  serviceModes: [],
  hours: null,
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const workspace = (saved: StoreSetupSnapshot | null = null) =>
  parseStoreSetupWorkspace(
    {
      profile: "StoreSetupWorkspaceV1",
      scope,
      store: {
        storeReference: id(3),
        code: "SYNTH",
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
        snapshot: saved,
        observedAt: at,
        validUntil: until,
        businessReferenceValidation: "NotEvaluated",
      },
    },
    id(3),
    scope,
  );
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse(at)));
afterEach(() => vi.restoreAllMocks());
// Real browser client parsing/hash, controlled HTTP and durable-storage boundary.
// These tests do not claim current IAM, native SQL or rendered browser interaction.
function fixture() {
  let saved: StoreSetupSnapshot | null = null,
    pending: StoreSetupCursor | null = null,
    receipt: unknown;
  const sequence: string[] = [],
    bodies: Record<string, unknown>[] = [];
  const journal: StoreSetupPendingJournal = {
    load: async () => pending,
    reserve: vi.fn(async (cursor) => {
      sequence.push("reserve");
      if (pending && pending.operationReference !== cursor.operationReference)
        throw new StoreSetupClientError("Unavailable");
      pending = cursor;
    }),
    complete: vi.fn(async () => {
      sequence.push("complete");
      pending = null;
    }),
  };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") {
      sequence.push("read");
      return response(workspace(saved));
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    sequence.push(String(body.command));
    if (body.command === "ResolveOriginal") return response(receipt);
    const content = body.content as StoreSetupSnapshot["content"],
      revision = Number(body.expectedRevision) + 1;
    saved = {
      profile: Object.hasOwn(content, "feeContexts") ? "StoreSetupDraftV2" : "StoreSetupDraftV1",
      ...{
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      setupDraftReference: id(6),
      revision,
      authoredByReference: id(4),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: null,
      content,
      createdAt: at,
      updatedAt: at,
      purposeCode: "STORE_SETUP_DRAFT",
      dataClassification: "ConfigurationMetadata",
    };
    const command = {
      profile: Object.hasOwn(content, "feeContexts") ? "StoreSetupSaveV2" : "StoreSetupSaveV1",
      ...scope,
      operationReference: body.operationReference,
      expectedSetupReference: body.expectedSetupReference,
      expectedRevision: body.expectedRevision,
      content,
      purposeCode: "STORE_SETUP_DRAFT",
    };
    receipt = {
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: body.operationReference,
      expectedSetupReference: body.expectedSetupReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest: await publicationValueDigest(command),
      outcome: "Committed",
      snapshot: saved,
      auditReference: id(7),
      occurredAt: at,
    };
    return response(receipt);
  });
  return {
    journal,
    fetcher,
    client: createStoreSetupClient(fetcher),
    sequence,
    bodies,
    pending: () => pending,
    view: () => workspace(saved),
  };
}
it("ordinary partial fields remain unconfigured instead of inheriting current Store settings", () => {
  const result = buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), empty());
  expect(result.timeZone.state).toBe("Unconfigured");
  expect(result.weeklySchedule.state).toBe("Unconfigured");
  expect(result.capacityConfigurationReference.state).toBe("Unconfigured");
});
it("author-authored timezone, modes and weekly intervals use ordinary controls with exact numbers", () => {
  const result = buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), {
    timeZone: "America/Toronto",
    businessStart: "04:00",
    serviceModes: ["Pickup"],
    hours: [
      [
        {
          start: "09:00",
          end: "17:00",
          followingDay: false,
          modes: ["Pickup"],
          cutoff: "600",
          lead: "900",
        },
      ],
      ...Array.from({ length: 6 }, () => []),
    ],
  });
  expect(result.businessDayStartLocalTime).toEqual({ state: "Configured", value: "04:00:00" });
  expect(result.weeklySchedule.state).toBe("Configured");
});
it.each(["", "1.5", "-1", "86401", "1e3"])(
  "invalid raw wait %s cannot be coerced into a Save",
  (raw) => {
    const fields = {
      ...empty(),
      hours: [
        [
          {
            start: "09:00",
            end: "17:00",
            followingDay: false,
            modes: ["Pickup"] as const,
            cutoff: raw,
            lead: "0",
          },
        ],
        ...Array.from({ length: 6 }, () => []),
      ],
    };
    expect(() =>
      buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), fields),
    ).toThrow();
    expect(fields.hours[0]?.[0]?.cutoff).toBe(raw);
  },
);
it("overlapping weekly intervals and missing per-interval modes are refused", () => {
  const interval = {
    start: "09:00",
    end: "17:00",
    followingDay: false,
    modes: ["Pickup"] as const,
    cutoff: "0",
    lead: "0",
  };
  expect(() =>
    buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), {
      ...empty(),
      hours: [[interval, { ...interval, start: "16:00" }], ...Array.from({ length: 6 }, () => [])],
    }),
  ).toThrow();
  expect(() =>
    buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), {
      ...empty(),
      hours: [[{ ...interval, modes: [] }], ...Array.from({ length: 6 }, () => [])],
    }),
  ).toThrow();
});
it("ordinary edits preserve saved source selections and exception records", () => {
  const base = {
    ...createUnconfiguredStoreSetupContent(),
    addressReference: { state: "Configured" as const, value: id(8) },
    contactReference: { state: "Configured" as const, value: id(9) },
    exceptions: {
      state: "Configured" as const,
      value: [{ localDate: "2026-12-25", kind: "Holiday" as const, intervals: [] }],
    },
    effectiveUntil: { state: "Configured" as const, value: null },
  };
  const result = buildStoreSetupEditedContent(base, {
    ...empty(),
    timeZone: "America/Toronto",
    serviceModes: ["Pickup"],
  });
  expect(result.addressReference).toEqual(base.addressReference);
  expect(result.contactReference).toEqual(base.contactReference);
  expect(result.exceptions).toEqual(base.exceptions);
  expect(result.effectiveUntil).toEqual(base.effectiveUntil);
});
it("review never shows opaque references or asserts approval/publication", () => {
  const content = {
    ...createUnconfiguredStoreSetupContent(),
    addressReference: { state: "Configured" as const, value: id(8) },
    capacityConfigurationReference: { state: "Configured" as const, value: null },
  };
  const html = renderToStaticMarkup(<StoreSetupDraftReview content={content} />);
  expect(html).toContain("Already configured");
  expect(html).toContain("No capacity configuration");
  expect(html).toContain("not approved, published, or live");
  expect(html).not.toContain(id(8));
});
it("the ordinary route shell offers refresh without fake Store facts", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreSetupDraftPage storeReference={id(3)} csrf={csrf} />
    </MemoryRouter>,
  );
  expect(html).toContain("Refresh saved setup");
  expect(html).toContain("Saving a draft does not change the live Store");
  expect(html).not.toContain("Synthetic store");
});
it("normal save reacquires exact current root and reserves before its first write, then refreshes before cleanup", async () => {
  const f = fixture();
  let reserved: StoreSetupCursor | undefined;
  const result = await dispatchStoreSetupDraft({
    client: f.client,
    journal: f.journal,
    baseline: workspace(),
    content: createUnconfiguredStoreSetupContent(),
    csrf,
    signal: new AbortController().signal,
    onReserved: (cursor) => {
      reserved = cursor;
    },
  });
  expect(f.sequence).toEqual(["read", "reserve", "SaveDraft", "read", "complete"]);
  expect(result.workspace.setup.snapshot?.revision).toBe(1);
  expect(f.pending()).toBeNull();
  expect(reserved?.operationReference).toMatch(/^[0-9a-f-]{14}7/u);
  expect(f.bodies[0]).not.toHaveProperty("actorReference");
});
it("storage reservation failure never sends a write", async () => {
  const f = fixture();
  f.journal.reserve = async () => {
    throw new StoreSetupClientError("Unavailable");
  };
  await expect(
    dispatchStoreSetupDraft({
      client: f.client,
      journal: f.journal,
      baseline: workspace(),
      content: createUnconfiguredStoreSetupContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: () => {
        throw new Error("must not reserve");
      },
    }),
  ).rejects.toThrow();
  expect(f.bodies).toHaveLength(0);
});
it("unknown response retains original; recovery sends only its payload-free original identity", async () => {
  const f = fixture(),
    controlled = createStoreSetupClient(async (url, init) => {
      const result = await f.fetcher(url, init);
      if (init?.method === "POST" && JSON.parse(String(init.body)).command === "SaveDraft")
        throw new Error("synthetic lost reply");
      return result;
    });
  await expect(
    dispatchStoreSetupDraft({
      client: controlled,
      journal: f.journal,
      baseline: workspace(),
      content: createUnconfiguredStoreSetupContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toHaveProperty("code", "OutcomeUnknown");
  const cursor = f.pending();
  if (!cursor) throw new Error("missing actual reserved original");
  expect(f.journal.complete).not.toHaveBeenCalled();
  const result = await recoverStoreSetupDraft({
    client: f.client,
    journal: f.journal,
    cursor,
    csrf,
    signal: new AbortController().signal,
  });
  expect(result.receipt.operationReference).toBe(cursor.operationReference);
  expect(f.bodies[1]).toEqual({
    command: "ResolveOriginal",
    operationReference: cursor.operationReference,
    expectedSetupReference: cursor.expectedSetupReference,
    expectedRevision: cursor.expectedRevision,
    intentDigest: cursor.intentDigest,
  });
  expect(f.pending()).toBeNull();
});
it("cleanup failure retains original even after a real committed result and current refresh", async () => {
  const f = fixture();
  f.journal.complete = async () => {
    throw new StoreSetupClientError("Unavailable");
  };
  await expect(
    dispatchStoreSetupDraft({
      client: f.client,
      journal: f.journal,
      baseline: workspace(),
      content: createUnconfiguredStoreSetupContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toThrow();
  expect(f.pending()).not.toBeNull();
  expect(f.view().setup.snapshot?.revision).toBe(1);
});
it("fresh changed root rejects before UUID, storage or write", async () => {
  const f = fixture();
  await dispatchStoreSetupDraft({
    client: f.client,
    journal: f.journal,
    baseline: workspace(),
    content: createUnconfiguredStoreSetupContent(),
    csrf,
    signal: new AbortController().signal,
    onReserved: () => undefined,
  });
  f.sequence.length = 0;
  await expect(
    dispatchStoreSetupDraft({
      client: f.client,
      journal: f.journal,
      baseline: workspace(),
      content: createUnconfiguredStoreSetupContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toHaveProperty("code", "Conflict");
  expect(f.sequence).toEqual(["read"]);
  expect(f.bodies).toHaveLength(1);
});

// Synthetic reference transport; native source/IAM and browser IDB are separate gates.
const referenceContent = () => ({
  countryCode: "CA",
  regionCode: "ON",
  locality: "Toronto",
  postalCode: "M5V 1A1",
  addressLines: ["100 Synthetic Street"],
});
function referenceSnapshot() {
  return {
    profile: "StoreSetupReferenceVersionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    kind: "Address",
    reference: id(40),
    revision: 1,
    authoredByReference: id(4),
    previousReference: null,
    content: referenceContent(),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
function referenceCurrent(saved = false) {
  return {
    profile: "StoreSetupReferencesCurrentV1",
    ...scope,
    address: saved ? referenceSnapshot() : null,
    contact: null,
    observedAt: at,
    validUntil: until,
    businessReferenceValidation: "NotEvaluated",
  };
}
it("ordinary reference editor exposes business fields and explicit save/use actions without opaque identity input", () => {
  const addressHtml = renderToStaticMarkup(
      <StoreSetupReferenceEditor
        scope={scope}
        csrf={csrf}
        kind="Address"
        onSelect={() => undefined}
      />,
    ),
    contactHtml = renderToStaticMarkup(
      <StoreSetupReferenceEditor
        scope={scope}
        csrf={csrf}
        kind="Contact"
        onSelect={() => undefined}
      />,
    );
  for (const label of [
    "Country code",
    "Province or region code",
    "City",
    "Postal code",
    "Address line 1",
    "Save address configuration",
  ])
    expect(addressHtml).toContain(label);
  for (const label of [
    "Contact name",
    "Business phone with country code",
    "Website (optional)",
    "Save contact configuration",
  ])
    expect(contactHtml).toContain(label);
  expect(addressHtml).not.toContain("<form");
  expect(addressHtml).not.toContain("Reference ID");
  expect(contactHtml).not.toContain("email");
});
it("reference configuration save reserves before dispatch and cleans only after terminal plus fresh current", async () => {
  const order: string[] = [],
    fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (!init?.body) {
        order.push("read");
        return new Response(JSON.stringify(referenceCurrent(order.includes("post"))), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      order.push("post");
      const body = JSON.parse(String(init.body)) as { operationReference: string };
      const original = {
        profile: "StoreSetupReferenceSaveV1",
        ...scope,
        kind: "Address",
        operationReference: body.operationReference,
        expectedReference: null,
        expectedRevision: 0,
        content: referenceContent(),
        purposeCode: "STORE_SETUP_REFERENCE",
      };
      return new Response(
        JSON.stringify({
          profile: "StoreSetupReferenceReceiptV1",
          ...scope,
          kind: "Address",
          operationReference: body.operationReference,
          expectedReference: null,
          expectedRevision: 0,
          intentDigest: await publicationValueDigest(original),
          outcome: "Committed",
          snapshot: referenceSnapshot(),
          auditReference: id(41),
          occurredAt: at,
        }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    });
  const client = createStoreSetupReferenceClient(fetcher),
    journal: StoreSetupReferencePendingJournal = {
      load: async () => null,
      reserve: async () => {
        order.push("reserve");
      },
      complete: async () => {
        order.push("complete");
      },
    };
  const result = await dispatchStoreSetupReference({
    client,
    journal,
    scope,
    kind: "Address",
    baseline: parseStoreSetupReferencesCurrent(referenceCurrent(), id(3), scope),
    content: referenceContent(),
    csrf,
    signal: new AbortController().signal,
    onReserved: () => {
      order.push("expose");
    },
  });
  expect(order).toEqual(["read", "reserve", "expose", "post", "read", "complete"]);
  expect(result.current.address?.reference).toBe(id(40));
});
it("reference reservation failure prevents POST and leaves partial setup untouched", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(referenceCurrent()), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    ),
    client = createStoreSetupReferenceClient(fetcher),
    journal: StoreSetupReferencePendingJournal = {
      load: async () => null,
      reserve: async () => {
        throw new StoreSetupClientError("Unavailable");
      },
      complete: vi.fn(),
    };
  await expect(
    dispatchStoreSetupReference({
      client,
      journal,
      scope,
      kind: "Address",
      baseline: parseStoreSetupReferencesCurrent(referenceCurrent(), id(3), scope),
      content: referenceContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(journal.complete).not.toHaveBeenCalled();
});
it("lost reference reply retains original and recovery resolves same operation without form content or new ID", async () => {
  const first = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    if (init?.body) throw new Error("synthetic lost reply");
    return new Response(JSON.stringify(referenceCurrent()), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  });
  const held: { cursor: StoreSetupReferenceCursor | null } = { cursor: null };
  const journal: StoreSetupReferencePendingJournal = {
      load: async () => held.cursor,
      reserve: async (c) => {
        held.cursor = c;
      },
      complete: vi.fn(),
    },
    client = createStoreSetupReferenceClient(first);
  await expect(
    dispatchStoreSetupReference({
      client,
      journal,
      scope,
      kind: "Address",
      baseline: parseStoreSetupReferencesCurrent(referenceCurrent(), id(3), scope),
      content: referenceContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const original = held.cursor;
  if (!original) throw new Error("Missing protected original");
  const replay = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify(
          init?.body
            ? {
                profile: "StoreSetupReferenceReceiptV1",
                ...scope,
                kind: "Address",
                operationReference: original.operationReference,
                expectedReference: null,
                expectedRevision: 0,
                intentDigest: original.intentDigest,
                outcome: "Committed",
                snapshot: referenceSnapshot(),
                auditReference: id(41),
                occurredAt: at,
              }
            : referenceCurrent(true),
        ),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      ),
  );
  await recoverStoreSetupReference({
    client: createStoreSetupReferenceClient(replay),
    journal,
    cursor: original,
    csrf,
    signal: new AbortController().signal,
  });
  const body = JSON.parse(String(replay.mock.calls[0]?.[1]?.body));
  expect(body).toEqual({
    command: "ResolveOriginal",
    operationReference: original.operationReference,
    expectedReference: null,
    expectedRevision: 0,
    intentDigest: original.intentDigest,
  });
  expect(journal.complete).toHaveBeenCalledTimes(1);
});
it("changed reference head refuses dispatch without overwriting local entered content", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(referenceCurrent(true)), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    ),
    reserve = vi.fn();
  await expect(
    dispatchStoreSetupReference({
      client: createStoreSetupReferenceClient(fetcher),
      journal: { load: async () => null, reserve, complete: vi.fn() },
      scope,
      kind: "Address",
      baseline: parseStoreSetupReferencesCurrent(referenceCurrent(), id(3), scope),
      content: referenceContent(),
      csrf,
      signal: new AbortController().signal,
      onReserved: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(reserve).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

// Payment rules use independent immutable originals; no Provider/readiness proof.
import {
  StorePaymentConfigurationEditor,
  dispatchStorePaymentConfiguration,
  recoverStorePaymentConfiguration,
} from "./StoreSetupDraftPage.js";
import {
  createStorePaymentConfigurationClient,
  parseStorePaymentConfigurationCurrent,
  type StorePaymentConfigurationCursor,
} from "./store-payment-configuration-client.js";
import type { StorePaymentConfigurationPendingJournal } from "./store-payment-configuration-pending-journal.js";
const paymentContent = {
  customerOnlineCardEnabled: false,
  staffTerminalCardPresentEnabled: true,
  staffTerminalInteracEnabled: true,
};
function paymentFixture() {
  let snapshot: unknown = null,
    pending: StorePaymentConfigurationCursor | null = null;
  const calls: string[] = [];
  const f = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST")
      return response({
        profile: "StorePaymentConfigurationCurrentV1",
        ...scope,
        snapshot,
        observedAt: at,
        validUntil: until,
        providerReadiness: "NotEvaluated",
      });
    calls.push("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (body.command === "SaveConfiguration")
      snapshot = {
        profile: "StorePaymentConfigurationV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        configurationReference: id(70),
        revision: 1,
        authoredByReference: id(4),
        previousConfigurationReference: null,
        content: body.content,
        currencyCode: "CAD",
        createdAt: at,
        updatedAt: at,
        dataClassification: "Internal",
      };
    const original = {
      profile: "StorePaymentConfigurationSaveV1",
      ...scope,
      operationReference: body.operationReference,
      expectedConfigurationReference: null,
      expectedRevision: 0,
      content: paymentContent,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    };
    return response({
      profile: "StorePaymentConfigurationReceiptV1",
      ...scope,
      operationReference: body.operationReference,
      intentDigest: await publicationValueDigest(original),
      expectedConfigurationReference: null,
      expectedRevision: 0,
      outcome: "Committed",
      snapshot,
      auditReference: id(71),
      occurredAt: at,
    });
  });
  const client = createStorePaymentConfigurationClient(f),
    journal: StorePaymentConfigurationPendingJournal = {
      load: async () => pending,
      reserve: async (c) => {
        calls.push("RESERVE");
        pending = c;
      },
      complete: async () => {
        calls.push("COMPLETE");
        pending = null;
      },
    };
  const baseline = parseStorePaymentConfigurationCurrent(
    {
      profile: "StorePaymentConfigurationCurrentV1",
      ...scope,
      snapshot: null,
      observedAt: at,
      validUntil: until,
      providerReadiness: "NotEvaluated",
    },
    id(3),
    scope,
  );
  return { client, journal, baseline, calls, fetcher: f, pending: () => pending };
}
it("Payment editor presents three actual channel controls and explicit readiness/selection boundary", () => {
  const html = renderToStaticMarkup(
    <StorePaymentConfigurationEditor scope={scope} csrf={csrf} onSelect={() => undefined} />,
  );
  for (const label of [
    "Customer online card",
    "Staff terminal card present",
    "Staff terminal Interac",
    "Save payment configuration",
    "Provider readiness",
  ])
    expect(html).toContain(label);
  expect(html).not.toContain("ProviderReady");
});
it("Payment Save reserves before POST and fresh current before clearing; selection remains separate", async () => {
  const f = paymentFixture(),
    selected = vi.fn();
  const result = await dispatchStorePaymentConfiguration({
    client: f.client,
    journal: f.journal,
    scope,
    baseline: f.baseline,
    content: paymentContent,
    csrf,
    signal: new AbortController().signal,
    onReserved: selected,
  });
  expect(f.calls).toEqual(["RESERVE", "POST", "COMPLETE"]);
  expect(selected).toHaveBeenCalledTimes(1);
  expect(result.current.snapshot?.configurationReference).toBe(id(70));
  expect(f.pending()).toBeNull();
});
it("Payment storage failure prevents network mutation", async () => {
  const f = paymentFixture();
  f.journal.reserve = async () => {
    throw new StoreSetupClientError("Unavailable");
  };
  await expect(
    dispatchStorePaymentConfiguration({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: f.baseline,
      content: paymentContent,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.calls).toEqual([]);
});
it("Payment unknown and denied recovery keep same original pending; explicit resolution clears after fresh read", async () => {
  const f = paymentFixture(),
    actual = f.fetcher.getMockImplementation();
  if (!actual) throw new Error("fixture missing");
  let lose = true;
  f.fetcher.mockImplementation(async (...args) => {
    const r = await actual(...args);
    if (args[1]?.method === "POST" && lose) {
      lose = false;
      throw new Error("synthetic lost reply");
    }
    return r;
  });
  await expect(
    dispatchStorePaymentConfiguration({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: f.baseline,
      content: paymentContent,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
  const cursor = f.pending();
  if (!cursor) throw new Error("cursor missing");
  f.fetcher.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: "request_denied" }), { status: 403 }),
  );
  await expect(
    recoverStorePaymentConfiguration({
      client: f.client,
      journal: f.journal,
      cursor,
      csrf,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(f.pending()).toEqual(cursor);
  const result = await recoverStorePaymentConfiguration({
    client: f.client,
    journal: f.journal,
    cursor,
    csrf,
    signal: new AbortController().signal,
  });
  expect(result.receipt.operationReference).toBe(cursor.operationReference);
  expect(f.pending()).toBeNull();
});
it("Payment cleanup failure preserves pending even after confirmed write/current", async () => {
  const f = paymentFixture();
  f.journal.complete = async () => {
    throw new StoreSetupClientError("Unavailable");
  };
  await expect(
    dispatchStorePaymentConfiguration({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: f.baseline,
      content: paymentContent,
      csrf,
      signal: new AbortController().signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.pending()).not.toBeNull();
});
it("Payment scope cancellation after original reservation prevents dispatch and clearing", async () => {
  const f = paymentFixture(),
    c = new AbortController();
  f.journal.reserve = async (cursor) => {
    await Promise.resolve();
    f.journal.load = async () => cursor;
    c.abort();
  };
  await expect(
    dispatchStorePaymentConfiguration({
      client: f.client,
      journal: f.journal,
      scope,
      baseline: f.baseline,
      content: paymentContent,
      csrf,
      signal: c.signal,
      onReserved: () => undefined,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(f.calls).toEqual([]);
  expect(await f.journal.load()).not.toBeNull();
});

it("renders three explicit fee configurations, actual order types and honest preparation status", () => {
  const modern = createUnconfiguredStoreSetupContentV2();
  const html = renderToStaticMarkup(
    <StoreSetupFeeContextEditor
      scope={scope}
      csrf={csrf}
      value={modern.feeContexts ?? { state: "Unconfigured" }}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(html).toContain('aria-label="Fee contexts"');
  for (const kind of ["ServiceCharge", "DeliveryFee", "Tip"])
    expect(html).toContain(`${kind} configuration`);
  expect(html).toContain("Unconfigured");
  expect(html).toContain("Disabled");
  expect(html).toContain("These selections do not set fees, rates or effective policy");
  expect(html).not.toContain('type="text"');
});
it("saves a new V2 with explicit incomplete fee policy while preserving every legacy field and the durable original sequence", async () => {
  const f = fixture();
  const legacy = createUnconfiguredStoreSetupContent();
  const modern = normalizeStoreSetupContentV2({
    ...legacy,
    timeZone: { state: "Configured", value: "America/Toronto" },
  });
  const result = await dispatchStoreSetupDraft({
    client: f.client,
    journal: f.journal,
    baseline: workspace(),
    content: modern,
    csrf,
    signal: new AbortController().signal,
    onReserved: vi.fn(),
  });
  expect(result.receipt.snapshot?.profile).toBe("StoreSetupDraftV2");
  expect(result.receipt.snapshot?.content).toEqual(modern);
  expect(result.receipt.snapshot?.content.feeContexts).toEqual({ state: "Unconfigured" });
  expect(f.sequence.indexOf("reserve")).toBeLessThan(f.sequence.indexOf("SaveDraft"));
});
it("requires active, fresh actual classification choices for enabled entries without treating Disabled as zero fee", () => {
  const choices = {
    profile: "TaxConfigClassificationChoicesV1" as const,
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
        lifecycle: "Active" as const,
      },
    ],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated" as const,
  };
  const content = {
    ...createUnconfiguredStoreSetupContentV2(),
    feeContexts: {
      state: "Configured" as const,
      value: [
        {
          chargeType: "ServiceCharge" as const,
          state: "Enabled" as const,
          taxClassificationReference: id(20),
          orderTypes: ["Pickup" as const],
        },
        { chargeType: "DeliveryFee" as const, state: "Disabled" as const },
        { chargeType: "Tip" as const, state: "Unconfigured" as const },
      ],
    },
  };
  expect(() => validateStoreSetupFeeSelections(content, choices)).not.toThrow();
  expect(() => validateStoreSetupFeeSelections(content, { ...choices, choices: [] })).toThrow();
  expect(() =>
    validateStoreSetupFeeSelections(content, {
      ...choices,
      choices: [
        {
          ...choices.choices[0],
          classificationReference: id(20),
          code: "SYNTH_CLASS",
          localizedNames: { "en-CA": "Synthetic classification" },
          lifecycle: "Inactive",
        },
      ],
    }),
  ).toThrow();
  expect(() => validateStoreSetupFeeSelections(content, { ...choices, validUntil: at })).toThrow();
});
