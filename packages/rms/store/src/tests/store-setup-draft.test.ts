import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStoreConfigurationVersion } from "../contracts/store-configuration-administration.js";
import {
  createStoreSetupDraft,
  parseStoreSetupDraft,
  parseStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContentV2,
  parseStoreSetupFeeContexts,
  replaceStoreSetupDraftContent,
  assessStoreSetupDraftCompleteness,
  materializeStoreSetupConfigurationVersion,
  materializeStoreSetupConfigurationVersionV2,
  storeSetupDraftContentFields,
  type StoreSetupActualScope,
} from "../contracts/store-setup-draft.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-05T10:01:00.000Z";
const scope = (actor = id(4)): StoreSetupActualScope => ({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: actor,
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  baseConfigurationReference: null,
});
const configured = <T>(value: T) => ({ state: "Configured" as const, value });
const envelope = () => ({
  profile: "StoreSetupDraftV1",
  setupDraftReference: id(5),
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  revision: 1,
  authoredByReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  baseConfigurationReference: null,
  content: createUnconfiguredStoreSetupDraftContent(),
  createdAt: at,
  updatedAt: at,
  purposeCode: "STORE_SETUP_DRAFT",
  dataClassification: "ConfigurationMetadata",
});
const schedule = () =>
  Array.from({ length: 7 }, (_, i) => ({
    isoWeekday: i + 1,
    intervals:
      i === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 600,
              leadTimeSeconds: 900,
            },
          ]
        : [],
  }));
const complete = () => ({
  source: configured("StoreOverride"),
  brandBaseVersionReference: configured(id(6)),
  timeZone: configured("America/Toronto"),
  businessDayStartLocalTime: configured("04:00:00"),
  addressReference: configured(id(7)),
  contactReference: configured(id(8)),
  receiptReference: configured(id(9)),
  taxConfigurationReference: configured(id(10)),
  paymentConfigurationReference: configured(id(11)),
  capacityConfigurationReference: configured(null),
  enabledServiceModes: configured(["Pickup"]),
  weeklySchedule: configured(schedule()),
  exceptions: configured([]),
  effectiveFrom: configured("2026-10-06T00:00:00.000Z"),
  effectiveUntil: configured(null),
});
const metadata = () => ({
  configurationReference: id(20),
  configurationVersion: 1,
  reasonCode: "AUTHORIZED_OPERATION",
  createdAt: later,
  updatedAt: later,
});

describe("ordinary Store setup partial draft contract", () => {
  it("first empty save is a closed resumable draft with all steps explicitly missing", () => {
    const draft = createStoreSetupDraft(envelope(), scope());
    expect(parseStoreSetupDraft(draft)).toEqual(draft);
    const completeness = assessStoreSetupDraftCompleteness(draft);
    expect(completeness.missingPaths).toEqual(
      storeSetupDraftContentFields.map((field) => "content." + field),
    );
    expect(completeness.businessReferenceValidation).toBe("NotEvaluated");
    expect(completeness).not.toHaveProperty("valid");
    expect(() => materializeStoreSetupConfigurationVersion(draft, scope(), metadata())).toThrow(
      expect.objectContaining({ code: "STORE_SETUP_INCOMPLETE" }),
    );
  });
  it("saves partial steps without silently inheriting references or replacing identity", () => {
    const original = createStoreSetupDraft(envelope(), scope());
    const content = {
      ...original.content,
      timeZone: configured("America/Toronto"),
      addressReference: configured(id(7)),
      businessDayStartLocalTime: configured("04:00:00"),
    };
    const changed = replaceStoreSetupDraftContent(original, content, scope(), {
      expectedRevision: 1,
      observedAt: later,
    });
    expect(changed.revision).toBe(2);
    expect(changed.createdAt).toBe(original.createdAt);
    expect(changed.setupDraftReference).toBe(original.setupDraftReference);
    expect(changed.content.paymentConfigurationReference).toEqual({ state: "Unconfigured" });
    expect(assessStoreSetupDraftCompleteness(changed).missingPaths).not.toContain(
      "content.timeZone",
    );
    expect(assessStoreSetupDraftCompleteness(original).missingPaths).toHaveLength(15);
  });
  it("authorized resume can record a different actual writer without rewriting original history", () => {
    const old = createStoreSetupDraft(envelope(), scope()),
      actual = scope(id(30));
    const next = replaceStoreSetupDraftContent(old, complete(), actual, {
      expectedRevision: 1,
      observedAt: later,
    });
    expect(next.authoredByReference).toBe(actual.actorReference);
    expect(old.authoredByReference).toBe(id(4));
    expect(parseStoreSetupDraft(old).authoredByReference).toBe(id(4));
    expect(
      materializeStoreSetupConfigurationVersion(next, actual, metadata()).authoredByReference,
    ).toBe(actual.actorReference);
  });
  it("complete shape materializes through unchanged full constructor with every explicit reference and no approval", () => {
    const draft = replaceStoreSetupDraftContent(
      createStoreSetupDraft(envelope(), scope()),
      complete(),
      scope(),
      { expectedRevision: 1, observedAt: later },
    );
    const final = materializeStoreSetupConfigurationVersion(draft, scope(), metadata());
    expect(createStoreConfigurationVersion(final)).toEqual(final);
    expect(final.lifecycle).toBe("Draft");
    expect(final.addressReference).toBe(id(7));
    expect(final.contactReference).toBe(id(8));
    expect(final.receiptReference).toBe(id(9));
    expect(final.taxConfigurationReference).toBe(id(10));
    expect(final.paymentConfigurationReference).toBe(id(11));
    expect(final.brandBaseVersionReference).toBe(id(6));
    expect(final.approvedByReference).toBeNull();
    expect(final.approvalEvidenceReference).toBeNull();
    expect(final.publicationReference).toBeNull();
    expect(final.liveGateEvidenceReference).toBeNull();
    expect(final.defaultLocale).toBe(scope().defaultLocale);
    expect(final.currencyCode).toBe("CAD");
    expect(assessStoreSetupDraftCompleteness(draft)).toEqual({
      missingPaths: [],
      businessReferenceValidation: "NotEvaluated",
    });
  });
  it("preserves actual complete base without asserting it is published or changing it", () => {
    const previous = createStoreConfigurationVersion({
      ...Object.fromEntries(Object.entries(complete()).map(([key, v]) => [key, v.value])),
      configurationReference: id(40),
      configurationVersion: 1,
      brandReference: id(2),
      storeReference: id(3),
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Draft",
      supersedesConfigurationReference: null,
      reasonCode: "AUTHORIZED_OPERATION",
      authoredByReference: id(4),
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
      liveGateEvidenceReference: null,
      createdAt: at,
      updatedAt: at,
      dataClassification: "ConfigurationMetadata",
    });
    const actual = { ...scope(), baseConfigurationReference: previous.configurationReference },
      first = {
        ...envelope(),
        baseConfigurationReference: previous.configurationReference,
        content: complete(),
      };
    const draft = createStoreSetupDraft(first, actual),
      final = materializeStoreSetupConfigurationVersion(draft, actual, {
        ...metadata(),
        configurationVersion: 2,
      });
    expect(final.supersedesConfigurationReference).toBe(previous.configurationReference);
    expect(previous.lifecycle).toBe("Draft");
    expect(previous.configurationVersion).toBe(1);
    expect(final.configurationReference).not.toBe(previous.configurationReference);
  });
  it.each(["capacityConfigurationReference", "effectiveUntil"] as const)(
    "distinguishes explicit none/open-ended from unfinished %s",
    (field) => {
      const initial = envelope(),
        content = { ...complete(), [field]: { state: "Unconfigured" } },
        draft = parseStoreSetupDraft({ ...initial, content });
      expect(assessStoreSetupDraftCompleteness(draft).missingPaths).toEqual(["content." + field]);
      const filled = parseStoreSetupDraft({
        ...initial,
        content: { ...content, [field]: configured(null) },
      });
      expect(assessStoreSetupDraftCompleteness(filled).missingPaths).toEqual([]);
    },
  );
  it.each([
    "addressReference",
    "contactReference",
    "receiptReference",
    "taxConfigurationReference",
    "paymentConfigurationReference",
    "brandBaseVersionReference",
    "timeZone",
    "enabledServiceModes",
    "weeklySchedule",
    "exceptions",
    "effectiveFrom",
  ] as const)("does not turn required %s null into configuration", (field) => {
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), [field]: configured(null) }),
    ).toThrow();
  });
  it("absent fields, absent configured values and unknown state payloads are invalid", () => {
    const { timeZone, ...absent } = complete();
    void timeZone;
    expect(() => parseStoreSetupDraftContent(absent)).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), timeZone: { state: "Configured" } }),
    ).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({
        ...complete(),
        timeZone: { state: "Unconfigured", value: "America/Toronto" },
      }),
    ).toThrow();
  });
  it.each([
    { timeZone: configured("EST") },
    { timeZone: configured("Invalid/Zone") },
    { businessDayStartLocalTime: configured("24:00:00") },
    { enabledServiceModes: configured([]) },
    { enabledServiceModes: configured(["Pickup", "Pickup"]) },
    { enabledServiceModes: configured(["Flying"]) },
    { addressReference: configured("not-a-reference") },
    { effectiveFrom: configured("2026-10-06T00:00:00Z") },
    { effectiveUntil: configured("2026-10-05T00:00:00.000Z") },
  ])("rejects malformed configured content instead of deferring structural failures", (patch) => {
    expect(() => parseStoreSetupDraftContent({ ...complete(), ...patch })).toThrow();
  });
  it("uses original schedule and exception overlap/date validation while saving a step", () => {
    const overlap = schedule();
    overlap[0]?.intervals.push({
      startLocalTime: "10:00:00",
      endLocalTime: "18:00:00",
      endsNextDay: false,
      serviceModes: ["Pickup"],
      orderCutoffSeconds: 0,
      leadTimeSeconds: 0,
    });
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), weeklySchedule: configured(overlap) }),
    ).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({
        ...complete(),
        exceptions: configured([{ localDate: "2026-02-30", kind: "Holiday", intervals: [] }]),
      }),
    ).toThrow();
  });
  it("denies mismatched Tenant/Brand/Store/Actor/locale/currency/base and authored identity overrides", () => {
    for (const patch of [
      { tenantReference: id(60) },
      { brandReference: id(60) },
      { storeReference: id(60) },
      { actorReference: id(60) },
      { defaultLocale: "fr-CA" },
      { currencyCode: "USD" },
      { baseConfigurationReference: id(60) },
    ]) {
      const actual = scope();
      Object.assign(actual, patch);
      expect(() => createStoreSetupDraft(envelope(), actual)).toThrow();
    }
    expect(() =>
      createStoreSetupDraft({ ...envelope(), authoredByReference: id(90) }, scope()),
    ).toThrow();
  });
  it("rejects stale revision, backward time, noncanonical time and injected server metadata", () => {
    const draft = createStoreSetupDraft(envelope(), scope());
    expect(() =>
      replaceStoreSetupDraftContent(draft, complete(), scope(), {
        expectedRevision: 2,
        observedAt: later,
      }),
    ).toThrow(expect.objectContaining({ code: "STORE_SETUP_VERSION_CONFLICT" }));
    expect(() =>
      replaceStoreSetupDraftContent(draft, complete(), scope(), {
        expectedRevision: 1,
        observedAt: "2026-10-05T09:59:59.000Z",
      }),
    ).toThrow();
    expect(() =>
      parseStoreSetupDraft({ ...envelope(), updatedAt: "2026-10-05T10:00:00Z" }),
    ).toThrow();
    const injectedMetadata = { ...metadata(), publicationReference: id(90) };
    expect(() =>
      materializeStoreSetupConfigurationVersion(
        { ...envelope(), content: complete() },
        scope(),
        injectedMetadata,
      ),
    ).toThrow();
  });
  it("refuses getter, sparse/prototype arrays, private PII and approval/live-gate content", () => {
    let getterRan = false;
    const raw = { ...envelope() };
    Object.defineProperty(raw, "content", {
      enumerable: true,
      get() {
        getterRan = true;
        return complete();
      },
    });
    expect(() => parseStoreSetupDraft(raw)).toThrow();
    expect(getterRan).toBe(false);
    expect(() => parseStoreSetupDraft({ ...envelope(), address: "private address" })).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), contactName: "private contact" }),
    ).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), approvedByReference: id(90) }),
    ).toThrow();
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), liveGateEvidenceReference: id(90) }),
    ).toThrow();
    const sparse = new Array(7);
    expect(() =>
      parseStoreSetupDraftContent({ ...complete(), weeklySchedule: configured(sparse) }),
    ).toThrow();
  });
  it("retains bounded explicit closed days and exceptions without fabricating opening hours", () => {
    const days = schedule().map((day) => ({ ...day, intervals: [] })),
      draft = parseStoreSetupDraft({
        ...envelope(),
        content: { ...complete(), weeklySchedule: configured(days), exceptions: configured([]) },
      });
    const final = materializeStoreSetupConfigurationVersion(draft, scope(), metadata());
    expect(final.weeklySchedule.every((day) => day.intervals.length === 0)).toBe(true);
    expect(final.exceptions).toEqual([]);
  });
});

describe("Store Setup V2 explicit fee contexts", () => {
  const entries = () => [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(30),
      orderTypes: ["Pickup", "DineIn"],
    },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Unconfigured" },
  ];
  it("preserves V1 content and makes V2 unconfigured explicit without a disabled default", () => {
    expect(Object.keys(createUnconfiguredStoreSetupDraftContent())).toHaveLength(15);
    expect(Object.keys(createUnconfiguredStoreSetupDraftContentV2())).toHaveLength(16);
    const draft = parseStoreSetupDraft({
      ...envelope(),
      profile: "StoreSetupDraftV2",
      content: createUnconfiguredStoreSetupDraftContentV2(),
    });
    expect(assessStoreSetupDraftCompleteness(draft).missingPaths).toContain("content.feeContexts");
    expect(() => parseStoreSetupDraft({ ...draft, profile: "StoreSetupDraftV1" })).toThrow();
    expect(() => parseStoreSetupDraft({ ...envelope(), profile: "StoreSetupDraftV2" })).toThrow();
  });
  it("canonicalizes real enabled modes and reports only unconfigured fee entries", () => {
    const raw = entries();
    const parsed = parseStoreSetupFeeContexts(raw);
    const first = raw[0];
    if (!first) throw new Error("Missing fee");
    first.orderTypes?.push("Delivery");
    expect(parsed[0]).toMatchObject({ orderTypes: ["DineIn", "Pickup"] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    const draft = parseStoreSetupDraft({
      ...envelope(),
      profile: "StoreSetupDraftV2",
      content: { ...complete(), feeContexts: configured(entries()) },
    });
    expect(assessStoreSetupDraftCompleteness(draft).missingPaths).toEqual([
      "content.feeContexts.Tip",
    ]);
  });
  it("allows V1-to-V2 authoring but forbids downgrade and legacy materialization even when complete", () => {
    const old = createStoreSetupDraft(envelope(), scope());
    const content = {
      ...complete(),
      feeContexts: configured(
        entries().map((entry) =>
          entry.state === "Unconfigured" ? { ...entry, state: "Disabled" } : entry,
        ),
      ),
    };
    const next = replaceStoreSetupDraftContent(old, content, scope(id(40)), {
      expectedRevision: 1,
      observedAt: later,
    });
    expect(next.profile).toBe("StoreSetupDraftV2");
    expect(next.authoredByReference).toBe(id(40));
    expect(assessStoreSetupDraftCompleteness(next).missingPaths).toEqual([]);
    expect(() =>
      replaceStoreSetupDraftContent(next, complete(), scope(), {
        expectedRevision: 2,
        observedAt: later,
      }),
    ).toThrow();
    expect(() => materializeStoreSetupConfigurationVersion(next, scope(), metadata())).toThrowError(
      expect.objectContaining({ code: "STORE_SETUP_INCOMPLETE" }),
    );
  });
  it.each(
    [
      [],
      [...entries(), { chargeType: "Tip", state: "Disabled" }],
      entries().reverse(),
      [{ chargeType: "ServiceCharge", state: "Disabled", rate: "0" }, ...entries().slice(1)],
      [{ ...entries()[0], taxClassificationReference: null }, ...entries().slice(1)],
      [{ ...entries()[0], orderTypes: [] }, ...entries().slice(1)],
      [{ ...entries()[0], orderTypes: ["Pickup", "Pickup"] }, ...entries().slice(1)],
    ].map((value) => ({ value })),
  )("rejects malformed fee content $value", ({ value }) => {
    expect(() => parseStoreSetupFeeContexts(value)).toThrow();
  });
  it("rejects fee getters and sparse arrays without evaluating them", () => {
    const raw = entries();
    const first = raw[0];
    if (!first) throw new Error("Missing fee");
    let calls = 0;
    Object.defineProperty(first, "state", {
      get() {
        calls++;
        return "Enabled";
      },
    });
    expect(() => parseStoreSetupFeeContexts(raw)).toThrow();
    expect(calls).toBe(0);
    expect(() => parseStoreSetupFeeContexts(new Array(3))).toThrow();
  });
});

const canonicalSetup = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalSetup).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalSetup(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
          )
          .join(",")}}`
      : JSON.stringify(value);
const setupReferences = {
  canonicalize: canonicalSetup,
  hashIntent: (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
const completeV2 = () =>
  parseStoreSetupDraft({
    ...envelope(),
    profile: "StoreSetupDraftV2",
    content: {
      ...complete(),
      feeContexts: configured([
        {
          chargeType: "ServiceCharge",
          state: "Enabled",
          taxClassificationReference: id(40),
          orderTypes: ["Pickup"],
        },
        { chargeType: "DeliveryFee", state: "Disabled" },
        { chargeType: "Tip", state: "Disabled" },
      ]),
    },
  });
describe("V2 complete configuration materialization", () => {
  it("binds the full immutable draft digest and records the current writer", () => {
    const draft = completeV2(),
      result = materializeStoreSetupConfigurationVersionV2(
        draft,
        scope(id(41)),
        metadata(),
        setupReferences,
      );
    expect(result.authoredByReference).toBe(id(41));
    expect(result.setupBasis).toMatchObject({
      tenantReference: id(1),
      setupDraftReference: id(5),
      sourceRevision: 1,
      sourceSnapshotDigest: setupReferences.hashIntent(canonicalSetup(draft)),
    });
    expect(result.lifecycle).toBe("Draft");
    expect(result.approvedByReference).toBeNull();
    expect(() => materializeStoreSetupConfigurationVersion(draft, scope(), metadata())).toThrow(
      expect.objectContaining({ code: "STORE_SETUP_INCOMPLETE" }),
    );
  });
  it("retains the actual prior complete reference and rejects unfinished fee intent", () => {
    const actual = { ...scope(), baseConfigurationReference: id(45) };
    const draft = parseStoreSetupDraft({ ...completeV2(), baseConfigurationReference: id(45) });
    expect(
      materializeStoreSetupConfigurationVersionV2(
        draft,
        actual,
        { ...metadata(), configurationVersion: 2 },
        setupReferences,
      ).supersedesConfigurationReference,
    ).toBe(id(45));
    expect(() =>
      materializeStoreSetupConfigurationVersionV2(
        { ...draft, content: { ...draft.content, feeContexts: { state: "Unconfigured" } } },
        actual,
        { ...metadata(), configurationVersion: 2 },
        setupReferences,
      ),
    ).toThrow();
  });
  it("rejects altered serialization and source port getters", () => {
    expect(() =>
      materializeStoreSetupConfigurationVersionV2(completeV2(), scope(), metadata(), {
        ...setupReferences,
        canonicalize: () => "{}",
      }),
    ).toThrow();
    const refs = { ...setupReferences };
    let called = false;
    Object.defineProperty(refs, "hashIntent", {
      enumerable: true,
      get() {
        called = true;
        return setupReferences.hashIntent;
      },
    });
    expect(() =>
      materializeStoreSetupConfigurationVersionV2(completeV2(), scope(), metadata(), refs),
    ).toThrow();
    expect(called).toBe(false);
  });
});
