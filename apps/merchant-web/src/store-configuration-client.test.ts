import { expect, it, vi } from "vitest";
import {
  createStoreConfigurationClient,
  parseStoreConfigurationView,
  parseStoreConfigurationSnapshot,
} from "./store-configuration-client.js";
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

const view = {
  screenId: "STORE-HOURS-SERVICE",
  storeReference: id(3),
  current: configuration("Published"),
  latest: configuration("Draft"),
  expectedVersion: 1,
  observedAt: at,
};
it("keeps current publication and draft separate", () => {
  const value = parseStoreConfigurationView(view, id(3));
  expect(value.current?.lifecycle).toBe("Published");
  expect(value.latest?.lifecycle).toBe("Draft");
});
it.each([
  { ...view, storeReference: id(99) },
  { ...view, expectedVersion: 2 },
  { ...view, current: configuration("Draft") },
  { ...view, latest: { ...configuration("Draft"), storeReference: id(99) } },
  { ...view, latest: { ...configuration("Draft"), weeklySchedule: [] } },
])("rejects unsafe or inconsistent management view", (raw) => {
  expect(() => parseStoreConfigurationView(raw, id(3))).toThrow();
});
it("uses same-origin no-store transport and CSRF for a stable command", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "Applied",
        resultingVersion: 2,
      }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    ),
  );
  const client = createStoreConfigurationClient(fetcher);
  const command = {
    command: "SaveDraft" as const,
    operationReference: id(20),
    auditReference: id(21),
    expectedVersion: 1,
    configuration: parseStoreConfigurationView(view, id(3)).latest as NonNullable<
      ReturnType<typeof parseStoreConfigurationView>["latest"]
    >,
  };
  await client.execute(command, "synthetic-csrf", new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/store-configuration",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(command),
      headers: expect.objectContaining({ "X-BOP-CSRF": "synthetic-csrf" }),
    }),
  );
});

const setupBasis = () => ({
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(30),
  setupDraftReference: id(31),
  sourceRevision: 7,
  sourceSnapshotDigest: "sha256:" + "a".repeat(64),
  feeContexts: [
    {
      chargeType: "ServiceCharge",
      state: "Enabled",
      taxClassificationReference: id(32),
      orderTypes: ["Pickup"],
    },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
});
it("accepts the two closed complete configuration shapes and preserves detached Setup basis without legacy defaults", () => {
  const legacy = parseStoreConfigurationSnapshot(configuration("Draft"), id(3));
  expect(legacy).not.toHaveProperty("setupBasis");
  const raw = setupBasis(),
    next = parseStoreConfigurationSnapshot({ ...configuration("Draft"), setupBasis: raw }, id(3));
  expect(next.setupBasis).toEqual(raw);
  expect(Object.isFrozen(next.setupBasis?.feeContexts)).toBe(true);
  raw.feeContexts[0]?.orderTypes?.push("DineIn");
  expect(next.setupBasis?.feeContexts[0]).toMatchObject({ orderTypes: ["Pickup"] });
  const full = parseStoreConfigurationView(
    {
      ...view,
      current: { ...configuration("Published"), setupBasis: setupBasis() },
      latest: { ...configuration("Draft"), setupBasis: setupBasis() },
    },
    id(3),
  );
  expect(full.current?.setupBasis).toEqual(full.latest?.setupBasis);
  expect(full.current?.lifecycle).toBe("Published");
  expect(full.latest?.lifecycle).toBe("Draft");
});
it("rejects incomplete fee materialization, foreign modes and malformed open Setup provenance", () => {
  const basis = setupBasis();
  for (const change of [
    { profile: "StoreSetupConfigurationBasisV1" },
    { sourceRevision: 0 },
    { sourceSnapshotDigest: "a".repeat(64) },
    { tenantReference: "arbitrary" },
    { extra: true },
    {
      feeContexts: [
        { chargeType: "ServiceCharge", state: "Unconfigured" },
        basis.feeContexts[1],
        basis.feeContexts[2],
      ],
    },
    {
      feeContexts: [
        { ...basis.feeContexts[0], orderTypes: ["Delivery"] },
        basis.feeContexts[1],
        basis.feeContexts[2],
      ],
    },
    {
      feeContexts: [
        { ...basis.feeContexts[0], rate: "0.13" },
        basis.feeContexts[1],
        basis.feeContexts[2],
      ],
    },
  ])
    expect(() =>
      parseStoreConfigurationSnapshot(
        { ...configuration("Draft"), setupBasis: { ...basis, ...change } },
        id(3),
      ),
    ).toThrow();
  expect(() =>
    parseStoreConfigurationSnapshot({ ...configuration("Draft"), setupBasis: null }, id(3)),
  ).toThrow();
});
it("rejects accessor Setup basis without executing caller getters", () => {
  const get = vi.fn(() => setupBasis()),
    raw = { ...configuration("Draft"), setupBasis: setupBasis() };
  Object.defineProperty(raw, "setupBasis", { get, enumerable: true });
  expect(() => parseStoreConfigurationSnapshot(raw, id(3))).toThrow();
  expect(get).not.toHaveBeenCalled();
  const nested = { ...configuration("Draft"), setupBasis: setupBasis() };
  Object.defineProperty(nested.setupBasis, "sourceSnapshotDigest", { get, enumerable: true });
  expect(() => parseStoreConfigurationSnapshot(nested, id(3))).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("retains the entire fee basis in Save and lifecycle transport rather than dropping the extension", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { command: string; configuration: unknown };
    expect(parseStoreConfigurationSnapshot(body.configuration, id(3)).setupBasis).toEqual(
      setupBasis(),
    );
    return new Response(
      JSON.stringify({ status: "Applied", resultingVersion: body.command === "SaveDraft" ? 2 : 1 }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  });
  const client = createStoreConfigurationClient(fetcher);
  for (const command of ["SaveDraft", "Validate", "Submit", "Approve", "Publish"] as const) {
    await client.execute(
      {
        command,
        operationReference: id(20),
        auditReference: id(21),
        expectedVersion: 1,
        configuration: parseStoreConfigurationSnapshot(
          {
            ...configuration(command === "Publish" ? "Approved" : "Draft"),
            setupBasis: setupBasis(),
          },
          id(3),
        ),
      },
      "synthetic-csrf",
      new AbortController().signal,
    );
  }
  expect(fetcher).toHaveBeenCalledTimes(5);
});
