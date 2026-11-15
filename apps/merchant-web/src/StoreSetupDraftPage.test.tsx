import {
  createStoreSetupReferenceClient,
  parseStoreSetupReferencesCurrent,
  type StoreSetupReferenceCursor,
} from "./store-setup-reference-client.js";
import type { StoreSetupReferencePendingJournal } from "./store-setup-reference-pending-journal.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { MemoryRouter } from "react-router";
import { setLanguageForTest } from "./i18n/i18n.js";
import type { StoreConfigurationSnapshot } from "./store-configuration-client.js";
import {
  StoreSetupDraftPage,
  StoreSetupHeader,
  storeSetupPlaceHref,
  storeSetupPlaceOf,
  storeSetupPlaces,
  storeSetupPlaceText,
  storeSetupChangeSummary,
  clockField,
  wordGap,
  storeSetupOwnerOnly,
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
  type StoreSetupHourInput,
  savedWaitText,
  waitMinutesText,
} from "./StoreSetupDraftPage.js";
import {
  createStoreSetupClient,
  createUnconfiguredStoreSetupContent,
  createUnconfiguredStoreSetupContentV2,
  normalizeStoreSetupContentV2,
  parseStoreSetupContent,
  parseStoreSetupWorkspace,
  StoreSetupClientError,
  type StoreSetupCursor,
  type StoreSetupSnapshot,
  type StoreSetupContent,
} from "./store-setup-client.js";
import { type StoreSetupPendingJournal } from "./store-setup-pending-journal.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
import { StoreConfigurationFeeBasisView } from "./StoreConfigurationEditor.js";
import { storeSetupCreatedFromSaved } from "./StoreConfigurationOrdinaryPanel.js";
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
          cutoff: "10",
          lead: "15",
        },
      ],
      ...Array.from({ length: 6 }, () => []),
    ],
  });
  expect(result.businessDayStartLocalTime).toEqual({ state: "Configured", value: "04:00:00" });
  expect(result.weeklySchedule.state).toBe("Configured");
  // Staff enter minutes; the stored contract keeps seconds.
  const interval =
    result.weeklySchedule.state === "Configured"
      ? result.weeklySchedule.value[0]?.intervals[0]
      : undefined;
  expect(interval?.orderCutoffSeconds).toBe(600);
  expect(interval?.leadTimeSeconds).toBe(900);
});
const waitHours = (cutoff: string, lead: string, saved: Partial<StoreSetupHourInput> = {}) => ({
  timeZone: "",
  businessStart: "",
  serviceModes: [] as const,
  hours: [
    [
      {
        start: "09:00",
        end: "17:00",
        followingDay: false,
        modes: ["Pickup"] as const,
        cutoff,
        lead,
        ...saved,
      },
    ],
    ...Array.from({ length: 6 }, () => []),
  ],
});
const savedWaits = (content: StoreSetupContent) =>
  content.weeklySchedule.state === "Configured"
    ? [
        content.weeklySchedule.value[0]?.intervals[0]?.orderCutoffSeconds,
        content.weeklySchedule.value[0]?.intervals[0]?.leadTimeSeconds,
      ]
    : [];
it("accepts waits up to 24 hours in minutes and converts them to seconds", () => {
  expect(
    savedWaits(
      buildStoreSetupEditedContent(createUnconfiguredStoreSetupContent(), waitHours("0", "1440")),
    ),
  ).toEqual([0, 86400]);
});
it("a saved wait that is not whole minutes is shown rounded but never changed unless edited", () => {
  expect(waitMinutesText(90)).toBe("2");
  expect(waitMinutesText(600)).toBe("10");
  expect(savedWaitText(90)).toBe("1 minute 30 seconds");
  expect(savedWaitText(45)).toBe("45 seconds");
  // Untouched prefilled fields keep the exact saved seconds.
  expect(
    savedWaits(
      buildStoreSetupEditedContent(
        createUnconfiguredStoreSetupContent(),
        waitHours("2", "1", { savedCutoffSeconds: 90, savedLeadSeconds: 59 }),
      ),
    ),
  ).toEqual([90, 59]);
  // Once staff edit a field (saved seconds cleared), exactly the typed minutes are saved.
  expect(
    savedWaits(
      buildStoreSetupEditedContent(
        createUnconfiguredStoreSetupContent(),
        waitHours("2", "3", { savedCutoffSeconds: null, savedLeadSeconds: 59 }),
      ),
    ),
  ).toEqual([120, 180]);
});
it.each(["", "1.5", "-1", "1441", "86400", "1e3"])(
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
  // b19: saved records are named as filled in, plain values are shown; no "already configured"
  // mixed into the values, and no "still needs validation" next to the status below.
  expect(html).toContain("Also filled in: Address.");
  expect(html).toContain("No order limits");
  expect(html).not.toContain("Already configured");
  expect(html).not.toContain("still need validation");
  expect(html).not.toContain(id(8));
});
it("review names the saved time zone in plain words, not its identifier", () => {
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview
      content={{
        ...createUnconfiguredStoreSetupContent(),
        timeZone: { state: "Configured", value: "America/Toronto" },
      }}
    />,
  );
  expect(html).toContain(
    "<dt>Time zone</dt><dd><span>Eastern Time (Toronto, Ottawa and Montréal)</span></dd>",
  );
  expect(html).not.toContain("America/Toronto");
  expect(findInternalText([staticText(html)])).toEqual([]);
});
it("b19: the business day start field shows hours and minutes, never seconds of zero", () => {
  expect(clockField("04:00:00")).toBe("04:00");
  expect(clockField("04:00")).toBe("04:00");
  // A saved time with seconds (never entered here) is kept whole rather than changed unseen.
  expect(clockField("04:00:30")).toBe("04:00:30");
  expect(clockField("")).toBe("");
});
it("b19: Review says what publishing changes against the live Store, in plain values", () => {
  const schedule = (end: string) =>
    Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i < 5
          ? [
              {
                startLocalTime: "11:00:00",
                endLocalTime: end,
                endsNextDay: false,
                serviceModes: ["DineIn"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    }));
  const current = {
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    enabledServiceModes: ["DineIn"],
    weeklySchedule: schedule("21:00:00"),
    capacityConfigurationReference: null,
    addressReference: id(8),
    contactReference: id(9),
    paymentConfigurationReference: id(10),
    receiptReference: id(11),
    taxConfigurationReference: id(12),
  } as unknown as StoreConfigurationSnapshot;
  const content = {
    ...createUnconfiguredStoreSetupContentV2(),
    timeZone: { state: "Configured" as const, value: "America/Toronto" },
    businessDayStartLocalTime: { state: "Configured" as const, value: "05:30:00" },
    enabledServiceModes: { state: "Configured" as const, value: ["DineIn", "Pickup"] as never },
    weeklySchedule: { state: "Configured" as const, value: schedule("22:00:00") as never },
    capacityConfigurationReference: { state: "Configured" as const, value: null },
    addressReference: { state: "Configured" as const, value: id(8) },
    contactReference: { state: "Configured" as const, value: id(13) },
    feeContexts: {
      state: "Configured" as const,
      value: [
        { chargeType: "ServiceCharge", state: "Disabled" },
        { chargeType: "DeliveryFee", state: "Disabled" },
        {
          chargeType: "Tip",
          state: "Enabled",
          taxClassificationReference: null,
          orderTypes: ["DineIn"],
        },
      ] as never,
    },
  };
  const summary = storeSetupChangeSummary(content, current);
  expect(summary.changed.map((item) => item.label)).toEqual([
    "Business day start",
    "Service modes",
    "Opening hours",
    "Fees",
    "Contact details",
  ]);
  expect(summary.changed[0]?.value).toEqual(["05:30"]);
  expect(summary.changed[2]?.value).toContain("Monday: 11:00\u201321:00 becomes 11:00\u201322:00");
  expect(summary.changed[3]?.value).toEqual([
    "Service charge: off",
    "Delivery fee: off",
    "Tip: on (Dine-in)",
  ]);
  expect(summary.unchanged).toEqual(["Time zone", "Order limits", "Address"]);
  const text = staticText(
    renderToStaticMarkup(<StoreSetupDraftReview content={content} current={current} />),
  );
  expect(text).toContain("What changes when it is published");
  expect(text).toContain("Staying as they are: Time zone, Order limits, Address.");
  // No seconds, no English plural inserted into the sentence, no references.
  expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}/u);
  expect(text).not.toContain(id(13));
  expect(findInternalText([text])).toEqual([]);
  // Nothing published to compare with: every value, with the open days counted in words.
  const alone = storeSetupChangeSummary(content, null);
  expect(alone.changed.find((item) => item.label === "Opening hours")?.value[0]).toBe(
    "Open 5 days a week",
  );
  expect(alone.filledIn).toEqual(["Address", "Contact details"]);
  setLanguageForTest("zh-Hans");
  try {
    const zh = storeSetupChangeSummary(content, null);
    expect(zh.changed.find((item) => item.label === "营业时间")?.value[0]).toBe("每周营业 5 天");
    expect(zh.changed.find((item) => item.label === "营业日开始时间")?.value).toEqual(["05:30"]);
    expect(JSON.stringify(zh)).not.toMatch(/days|closed/u);
    expect(zh.changed.find((item) => item.label === "营业时间")?.value[1]).toMatch(/：/u);
  } finally {
    setLanguageForTest("en");
  }
});
it("b18 review: a setting filled in here but not in the saved draft is named as not saved yet", () => {
  const saved = createUnconfiguredStoreSetupContent();
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview
      content={{
        ...saved,
        timeZone: { state: "Configured", value: "America/Toronto" },
        businessDayStartLocalTime: { state: "Configured", value: "04:00:00" },
      }}
      saved={saved}
      layout="Open"
    />,
  );
  expect(html).toContain('aria-label="Filled in, not saved yet"');
  expect(html).toContain("<li>Time zone</li>");
  expect(html).toContain("<li>Business day start</li>");
  expect(html).toContain("publishing below counts them as not set");
  expect(html).not.toContain("Time zone: set it in");
  // Nothing unsaved: no such section.
  const same = renderToStaticMarkup(
    <StoreSetupDraftReview content={saved} saved={saved} layout="Open" />,
  );
  expect(same).not.toContain("Filled in, not saved yet");
});
it("b18 review: an open Store's review names only its approval steps and where the rest is set", () => {
  const html = renderToStaticMarkup(
    <StoreSetupDraftReview content={createUnconfiguredStoreSetupContent()} layout="Open" />,
  );
  // Opening hours are changed in Hours & ordering; address and phone come from Store details.
  expect(html).toContain("Weekly hours: set it in Hours &amp; ordering");
  expect(html).toContain("Order limits: set it in step 2, Services");
  expect(html).toContain("Payment settings: set it in step 3, Fees, tax and payment");
  expect(html).toContain("Contact details: set it in step 4, Review and publish");
  for (const opening of [
    "Identity",
    "Capacity",
    "Contacts",
    "step 5",
    "step 6",
    "step 7",
    "step 8",
  ])
    expect(html).not.toContain(opening);
  expect(findInternalText([staticText(html)])).toEqual([]);
});
it("the ordinary route shell offers refresh without fake Store facts", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreSetupDraftPage storeReference={id(3)} csrf={csrf} />
    </MemoryRouter>,
  );
  // b18: before anything is read the page is a draft page (a first Store, or the approval place).
  expect(html).toContain("Restore the last saved draft");
  expect(html).not.toContain("Saving a draft does not change the live Store");
  expect(html).not.toContain("Synthetic store");
});
it("b18: an open Store's setup is a few places, each saying when a change takes effect", () => {
  expect(storeSetupPlaceOf("?section=receipts", "")).toBe("receipts");
  expect(storeSetupPlaceOf("", "#kitchen-setup")).toBe("kitchen");
  expect(storeSetupPlaceOf("", "#support-access")).toBe("access");
  expect(storeSetupPlaceOf("", "#sole-operator")).toBe("access");
  expect(storeSetupPlaceOf("", "#store-public-profile")).toBe("profile");
  expect(storeSetupPlaceOf("?section=unknown", "")).toBeNull();
  expect(storeSetupPlaceOf("?section=changes", "#kitchen-setup")).toBe("changes");
  expect(storeSetupPlaceHref(id(3), "profile")).toBe(`/app/organization/stores/${id(3)}/setup`);
  expect(storeSetupPlaceHref(id(3), "access")).toBe(
    `/app/organization/stores/${id(3)}/setup?section=access`,
  );
  for (const place of storeSetupPlaces) {
    const { name, lead } = storeSetupPlaceText(place);
    expect(name).not.toBe("");
    // Every place says plainly whether a change is live at once or a draft that needs approval.
    expect(lead).toMatch(place === "changes" ? /draft first.*approved/u : /live/u);
    expect(findInternalText([name, lead])).toEqual([]);
  }
  // Only the draft place talks about drafts.
  const live = renderToStaticMarkup(
    <StoreSetupHeader
      ownerOnly={false}
      displayName="Synthetic store"
      refreshDisabled={false}
      onRefresh={() => undefined}
      draft={false}
    />,
  );
  expect(live).not.toContain("draft");
});
it("b19: a reader who cannot save is not told a change is live once saved; zh links sit in the sentence", () => {
  for (const place of ["profile", "receipts", "kitchen"] as const) {
    const { lead } = storeSetupPlaceText(place, true);
    expect(lead).not.toMatch(/live|save/u);
    expect(lead).not.toBe("");
  }
  setLanguageForTest("zh-Hans");
  try {
    expect(storeSetupPlaceText("profile", true).lead).toBe("顾客看到的店名、地址和电话。");
    expect(wordGap()).toBe("");
  } finally {
    setLanguageForTest("en");
  }
  expect(wordGap()).toBe(" ");
});
it("a Store Manager refused the setup read sees the page read-only, not a permission error (v15)", async () => {
  // The real client turns the server's 403 on the setup read into Denied.
  const denied = createStoreSetupClient(
    vi.fn(async () => new Response(JSON.stringify({ error: "request_denied" }), { status: 403 })),
  );
  const refused = await denied
    .load({ storeReference: id(3), signal: new AbortController().signal })
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(StoreSetupClientError);
  const code = (refused as StoreSetupClientError).code;
  expect(code).toBe("Denied");
  expect(storeSetupOwnerOnly(code, null, true)).toBe(true);
  // Only a refused first read is read-only: an Owner's later refusal, a failed read, or another
  // Store keep their own messages.
  expect(storeSetupOwnerOnly(code, workspace(), true)).toBe(false);
  expect(storeSetupOwnerOnly("Unavailable", null, true)).toBe(false);
  expect(storeSetupOwnerOnly(code, null, false)).toBe(false);
  const html = renderToStaticMarkup(
    <StoreSetupHeader
      ownerOnly
      displayName={null}
      refreshDisabled={false}
      onRefresh={() => undefined}
    />,
  );
  expect(html).toContain("Only the Owner can change Store setup.");
  expect(html).not.toContain("Restore the last saved draft");
  expect(html).not.toContain("Saving a draft");
  expect(html).not.toContain("does not allow");
  expect(findInternalText([staticText(html)])).toEqual([]);
  const owner = renderToStaticMarkup(
    <StoreSetupHeader ownerOnly={false} displayName="Synthetic store" />,
  );
  // b18 review (v3): the title row ends with the language switch, as on Orders; reloading the
  // draft sits with the draft.
  expect(owner).toContain("workspace-page__language");
  expect(owner).not.toContain("Restore the last saved draft");
  expect(owner).not.toContain("Only the Owner");
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
    "payment provider account",
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
  expect(html).toContain('aria-label="Fees"');
  for (const kind of ["Service charge", "Delivery fee", "Tip"])
    expect(html).toContain(`aria-label="${kind}"`);
  expect(html).toContain("Not set");
  expect(html).toContain(">Off<");
  // Staff read fee names, never the charge codes (WP-2423 internal-text guard).
  expect(findInternalText([staticText(html)])).toEqual([]);
  expect(html).toContain(
    "Saving the setup draft keeps these choices. It does not set fee amounts or tax rates",
  );
  expect(html).not.toMatch(/Fee contexts|Draft configuration|effective policy/u);
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
const tipOnly = (taxClassificationReference: string | null) => ({
  ...createUnconfiguredStoreSetupContentV2(),
  feeContexts: {
    state: "Configured" as const,
    value: [
      { chargeType: "ServiceCharge" as const, state: "Disabled" as const },
      { chargeType: "DeliveryFee" as const, state: "Disabled" as const },
      {
        chargeType: "Tip" as const,
        state: "Enabled" as const,
        taxClassificationReference,
        orderTypes: ["Pickup" as const],
      },
    ],
  },
});
it("WP-2423 v15 D7: a Tip may be On with no tax classification; a service charge may not", () => {
  const choices = {
    profile: "TaxConfigClassificationChoicesV1" as const,
    ...scope,
    registryReference: id(30),
    versionReference: id(31),
    registryVersion: 1,
    snapshotDigest: "sha256:" + "a".repeat(64),
    defaultLocale: "en-CA",
    choices: [],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated" as const,
  };
  expect(() => validateStoreSetupFeeSelections(tipOnly(null), choices)).not.toThrow();
  expect(parseStoreSetupContent(tipOnly(null)).feeContexts).toEqual(tipOnly(null).feeContexts);
  const charged = tipOnly(null);
  expect(() =>
    parseStoreSetupContent({
      ...charged,
      feeContexts: {
        state: "Configured",
        value: [
          {
            chargeType: "ServiceCharge",
            state: "Enabled",
            taxClassificationReference: null,
            orderTypes: ["Pickup"],
          },
          charged.feeContexts.value[1],
          charged.feeContexts.value[2],
        ],
      },
    }),
  ).toThrow();
  // A named classification on a Tip is still checked against the choices.
  expect(() => validateStoreSetupFeeSelections(tipOnly(id(20)), choices)).toThrow();
});
it("WP-2423 v15 D5/D7: fee classification choices load on entry; a Tip needs none", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <StoreSetupFeeContextEditor
        scope={scope}
        csrf={csrf}
        value={tipOnly(null).feeContexts}
        disabled={false}
        onChange={vi.fn()}
        client={
          {
            classifications: () => new Promise(() => undefined),
          } as unknown as ReturnType<typeof createStoreSetupClient>
        }
      />
    </MemoryRouter>,
  );
  // Before the first answer: a loading state, never "press Refresh first".
  expect(html).toContain("Loading tax classification choices");
  expect(html).toContain("No tax classification (tips are not taxed)");
  const tipSelect = /<select aria-label="Tip tax classification"[^>]*>/u.exec(html)?.[0] ?? "";
  expect(tipSelect).not.toContain("disabled");
  const serviceSelect =
    /<select aria-label="Service charge tax classification"[^>]*>/u.exec(html)?.[0] ?? "";
  expect(serviceSelect).toContain("disabled");
  expect(html).toContain("generally not subject to GST/HST");
  expect(findInternalText([staticText(html)])).toEqual([]);
});
it("WP-2423 v15 D6: step 8 texts come from the current configuration, not earlier actions", () => {
  const saved = { setupDraftReference: id(50), revision: 3 };
  const basis = {
    profile: "StoreSetupConfigurationBasisV2" as const,
    tenantReference: id(1),
    setupDraftReference: id(50),
    sourceRevision: 3,
    sourceSnapshotDigest: "sha256:" + "b".repeat(64),
    feeContexts: [
      { chargeType: "ServiceCharge" as const, state: "Disabled" as const },
      { chargeType: "DeliveryFee" as const, state: "Disabled" as const },
      {
        chargeType: "Tip" as const,
        state: "Enabled" as const,
        taxClassificationReference: null,
        orderTypes: ["Pickup" as const],
      },
    ],
  };
  expect(storeSetupCreatedFromSaved(saved, { setupBasis: basis })).toBe(true);
  expect(storeSetupCreatedFromSaved({ ...saved, revision: 4 }, { setupBasis: basis })).toBe(false);
  expect(storeSetupCreatedFromSaved(saved, {})).toBe(false);
  expect(storeSetupCreatedFromSaved(null, { setupBasis: basis })).toBe(false);
  const configuration = {
    lifecycle: "Draft",
    storeReference: id(3),
    setupBasis: basis,
  } as unknown as Parameters<typeof StoreConfigurationFeeBasisView>[0]["configuration"];
  const render = (withdrawal?: "Withdrawn" | "Declined") =>
    renderToStaticMarkup(
      <MemoryRouter>
        <StoreConfigurationFeeBasisView configuration={configuration} withdrawal={withdrawal} />
      </MemoryRouter>,
    );
  expect(render()).toContain("Draft, not yet sent for approval");
  expect(render("Withdrawn")).toContain("Withdrawn, will not be published");
  expect(render("Withdrawn")).not.toContain("not yet sent");
  expect(render("Declined")).toContain("Declined, will not be published");
  expect(render()).toContain("no tax classification (tips are not taxed)");
});
