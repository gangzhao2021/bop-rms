import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createStoreConfigurationVersion } from "@rms/store";
import { parseMerchantStoreConfigurationOrdinaryWorkspace as parse } from "./merchant-store-configuration-ordinary-values.js";
import { parseMerchantStoreConfigurationHistoryPage as history } from "./merchant-store-configuration-ordinary-values.js";
const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const configuration = createStoreConfigurationVersion({
  configurationReference: id(10),
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  configurationVersion: 1,
  lifecycle: "Draft",
  source: "StoreOverride",
  brandBaseVersionReference: id(11),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(12),
  contactReference: id(13),
  receiptReference: id(14),
  taxConfigurationReference: id(15),
  paymentConfigurationReference: id(16),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "INTERNAL_TEST",
  authoredByReference: scope.actorReference,
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  liveGateEvidenceReference: null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});
const head = {
  configurationReference: configuration.configurationReference,
  configurationVersion: 1,
  contentDigest: `sha256:${sha256Hex(canonicalizeRfc8785(configuration))}`,
};
const workspace = () => ({
  profile: "StoreConfigurationOrdinaryWorkspaceV1",
  scope,
  latest: configuration,
  current: null,
  expectedHead: head,
  original: null,
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
  businessReferenceValidation: "NotEvaluated",
});
const denied = (value: unknown) => expect(() => parse(value, scope)).toThrow();
it("accepts recorded head and an empty workspace without inventing eligibility", () => {
  expect(parse(workspace(), scope).expectedHead).toEqual(head);
  expect(
    parse(
      {
        ...workspace(),
        latest: null,
        expectedHead: {
          configurationReference: null,
          configurationVersion: 0,
          contentDigest: null,
        },
      },
      scope,
    ).latest,
  ).toBeNull();
});
it("refuses scope, current-state and entire-envelope digest substitution", () => {
  for (const key of Object.keys(scope))
    denied({ ...workspace(), scope: { ...scope, [key]: id(90) } });
  denied({ ...workspace(), current: configuration });
  denied({ ...workspace(), expectedHead: { ...head, contentDigest: `sha256:${"a".repeat(64)}` } });
  denied({ ...workspace(), latest: { ...configuration, updatedAt: "2026-10-05T09:59:59.000Z" } });
});
it("refuses expired-shape leases, future source timestamps and fabricated eligibility", () => {
  for (const validUntil of [at, "2026-10-05T10:00:05.001Z"]) denied({ ...workspace(), validUntil });
  denied({ ...workspace(), observedAt: "2026-10-05T09:59:59.000Z", validUntil: at });
  denied({ ...workspace(), businessReferenceValidation: "Validated" });
  denied({ ...workspace(), permission: true });
});
it("retains historic terminal recovery independently of the latest head", () => {
  const original = {
    profile: "StoreConfigurationOrdinaryReceiptV1",
    ...scope,
    operationReference: id(20),
    action: "Validate",
    expectedHead: head,
    intentDigest: `sha256:${"b".repeat(64)}`,
    outcome: "Abandoned",
    operation: null,
    auditReference: id(21),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  expect(parse({ ...workspace(), original }, scope).original?.outcome).toBe("Abandoned");
  denied({ ...workspace(), original: { ...original, actorReference: id(99) } });
  denied({ ...workspace(), original: { ...original, occurredAt: "2026-10-05T10:00:00.001Z" } });
});

const historicalEntry = (sequenceNumber: number) => ({
  sequenceNumber,
  operationReference: id(sequenceNumber + 50),
  command: "Validate",
  configuration,
  intentDigest: `sha256:${"b".repeat(64)}`,
  actorReference: id(90),
  purposeCode: "LEGACY_STORE_CONFIGURATION",
  auditReference: id(sequenceNumber + 60),
  occurredAt: at,
  expectedVersion: 1,
});
const historicalPage = () => ({
  tenantReference: scope.tenantReference,
  brandReference: scope.brandReference,
  storeReference: scope.storeReference,
  readerActorReference: scope.actorReference,
  beforeSequence: null,
  entries: [historicalEntry(5), historicalEntry(4)],
  nextBeforeSequence: 4,
  observedAt: at,
  validUntil: "2026-10-05T10:00:05.000Z",
});
it("history preserves original authors and legacy stored intent without inventing its preimage", () => {
  const page = history(historicalPage(), scope, null);
  expect(page.entries[0]?.actorReference).toBe(id(90));
  expect(page.entries[0]?.intentDigest).toBe(`sha256:${"b".repeat(64)}`);
  expect(page.nextBeforeSequence).toBe(4);
  expect(
    history({ ...historicalPage(), entries: [], nextBeforeSequence: null }, scope, null).entries,
  ).toEqual([]);
});
it("history refuses changed reader, cursor, ordering, record tuple and extra authority", () => {
  const page = historicalPage(),
    entry = historicalEntry(5);
  for (const poisoned of [
    { ...page, readerActorReference: id(91) },
    { ...page, beforeSequence: 6 },
    { ...page, nextBeforeSequence: 5 },
    { ...page, entries: [...page.entries].reverse() },
    { ...page, entries: [...page.entries, historicalEntry(3)] },
    { ...page, entries: [{ ...entry, expectedVersion: 0 }], nextBeforeSequence: null },
    { ...page, entries: [{ ...entry, command: "Submit" }], nextBeforeSequence: null },
    {
      ...page,
      entries: [{ ...entry, occurredAt: "2026-10-05T10:00:00.001Z" }],
      nextBeforeSequence: null,
    },
    { ...page, permission: true },
    { ...page, validUntil: at },
  ])
    expect(() => history(poisoned, scope, null)).toThrow();
  expect(() => history(page, scope, 4)).toThrow();
});
