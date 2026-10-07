// Controlled workflow boundary behavior, not native IAM/Publishing qualification.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StoreConfigurationOrdinaryPanel,
  recoverStoreConfigurationOriginal,
  executeStoreConfigurationOriginal,
  StoreConfigurationHistoryView,
  appendStoreConfigurationHistory,
} from "./StoreConfigurationOrdinaryPanel.js";
import {
  parseStoreConfigurationOrdinaryHistory,
  createStoreConfigurationOrdinaryClient,
} from "./store-configuration-ordinary-client.js";
import {
  validateStoreConfigurationOriginalCursor,
  validateStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryWorkspace,
  type StoreConfigurationOriginalCursor,
} from "./store-configuration-pending-journal.js";
import { publicationValueDigest } from "./product-publication-command-client-v2.js";
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
it("initial render declares saved source is not effective configuration and shows loading", () => {
  const html = renderToStaticMarkup(
    <StoreConfigurationOrdinaryPanel scope={scope} csrf={csrf} saved={null} freshDisabled />,
  );
  expect(html).toContain("Store configuration publication");
  expect(html).toContain("not effective Store configuration");
  expect(html).toContain("Loading Store configuration");
  expect(html).not.toContain("Publish Store configuration");
});
it("recovers terminal then owner-reobserved original before clearing and accepts successor head", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor),
    fresh = await workspace(cursor, false, true),
    calls: string[] = [];
  const client = {
    ...createStoreConfigurationOrdinaryClient(),
    resolve: vi.fn(async () => {
      calls.push("resolve");
      return receipt;
    }),
    refreshOriginal: vi.fn(async () => {
      calls.push("fresh original");
      return fresh;
    }),
  };
  const journal = {
    load: vi.fn(async () => cursor),
    reserve: vi.fn(),
    complete: vi.fn(async () => {
      calls.push("complete");
    }),
  };
  const result = await recoverStoreConfigurationOriginal({
    client,
    journal,
    cursor,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(calls).toEqual(["resolve", "fresh original", "complete"]);
  expect(result.workspace.latest?.configurationVersion).toBe(2);
  expect(journal.reserve).not.toHaveBeenCalled();
});
it("failed original refresh retains pending after a successful terminal receipt", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor);
  const client = {
    ...createStoreConfigurationOrdinaryClient(),
    resolve: vi.fn(async () => receipt),
    refreshOriginal: vi.fn(async () => {
      throw new Error("read unavailable");
    }),
  };
  const journal = { load: vi.fn(async () => cursor), reserve: vi.fn(), complete: vi.fn() };
  await expect(
    recoverStoreConfigurationOriginal({
      client,
      journal,
      cursor,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => true,
    }),
  ).rejects.toThrow();
  expect(journal.complete).not.toHaveBeenCalled();
});
it("late Actor or scope switch refuses recovery state and never deletes its old namespace", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor);
  let active = true;
  const client = {
    ...createStoreConfigurationOrdinaryClient(),
    resolve: vi.fn(async () => {
      active = false;
      return receipt;
    }),
    refreshOriginal: vi.fn(async () => workspace(cursor)),
  };
  const journal = { load: vi.fn(async () => cursor), reserve: vi.fn(), complete: vi.fn() };
  await expect(
    recoverStoreConfigurationOriginal({
      client,
      journal,
      cursor,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => active,
    }),
  ).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(client.refreshOriginal).not.toHaveBeenCalled();
  expect(journal.complete).not.toHaveBeenCalled();
});
it("Abandoned still requires authoritative fresh state before cleanup and has no new execution", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor, true),
    fresh = await workspace(cursor, true);
  const client = {
    ...createStoreConfigurationOrdinaryClient(),
    resolve: vi.fn(async () => receipt),
    refreshOriginal: vi.fn(async () => fresh),
    execute: vi.fn(),
  };
  const journal = {
    load: vi.fn(async () => cursor),
    reserve: vi.fn(),
    complete: vi.fn(async () => undefined),
  };
  const result = await recoverStoreConfigurationOriginal({
    client,
    journal,
    cursor,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.receipt.outcome).toBe("Abandoned");
  expect(result.workspace.latest).toBeNull();
  expect(journal.complete).toHaveBeenCalledWith(cursor, receipt, fresh);
  expect(client.execute).not.toHaveBeenCalled();
});

function recordedPage(
  beforeSequence: number | null,
  sequenceNumbers: readonly number[],
  more: boolean,
) {
  return parseStoreConfigurationOrdinaryHistory(
    {
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      readerActorReference: scope.actorReference,
      beforeSequence,
      entries: sequenceNumbers.map((n) => ({
        sequenceNumber: n,
        operationReference: id(200 + n),
        command: "Validate",
        configuration: configuration("Draft"),
        intentDigest: "sha256:" + "b".repeat(64),
        actorReference: id(40),
        purposeCode: "STORE_CONFIGURATION",
        auditReference: id(300 + n),
        occurredAt: at,
        expectedVersion: 1,
      })),
      nextBeforeSequence: more ? sequenceNumbers.at(-1) : null,
      observedAt: at,
      validUntil: until,
    },
    scope,
    beforeSequence,
  );
}
it("displays actual recorded operations separately with author and audit details collapsed", () => {
  const page = recordedPage(null, [4, 3], true),
    html = renderToStaticMarkup(<StoreConfigurationHistoryView entries={page.entries} />);
  expect(html).toContain("Validate");
  expect(html).toContain("Version 1");
  expect(html).toContain(id(40));
  expect(html).toContain("Original author");
  expect(html).toContain("<details>");
  expect(html).not.toContain("open=");
  expect(html).not.toContain(page.entries[0]?.intentDigest ?? "missing digest");
});
it("appends only the correct strictly older immutable page and refuses wrong selectors or duplicate operations", () => {
  const first = recordedPage(null, [4, 3], true),
    second = recordedPage(3, [2, 1], false);
  expect(
    appendStoreConfigurationHistory(first.entries, second).map((e) => e.sequenceNumber),
  ).toEqual([4, 3, 2, 1]);
  expect(() =>
    appendStoreConfigurationHistory(first.entries, { ...second, beforeSequence: 4 }),
  ).toThrow();
  const old = first.entries[0];
  if (!old) throw new Error("history absent");
  expect(() =>
    appendStoreConfigurationHistory(first.entries, {
      ...second,
      entries: [{ ...second.entries[0], ...old }],
    }),
  ).toThrow();
});

it("parent dirty while durable reserve is pending blocks dispatch but retains an original that can resolve", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor, true),
    fresh = await workspace(cursor, true);
  const actual = createStoreConfigurationOrdinaryClient();
  const prepared = await actual.prepare({
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope,
    operationReference: cursor.operationReference,
    action: "Materialize",
    expectedHead: cursor.expectedHead,
    setupSelector,
    reasonCode: "SETUP_MATERIALIZATION",
  });
  let release: () => void = () => undefined,
    arrive: () => void = () => undefined,
    disabled = false,
    pending: StoreConfigurationOriginalCursor | null = null;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const journal = {
    load: vi.fn(async () => cursor),
    reserve: vi.fn(async () => {
      arrive();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }),
    complete: vi.fn(async () => undefined),
  };
  const client = {
    ...actual,
    execute: vi.fn(async () => receipt),
    resolve: vi.fn(async () => receipt),
    refreshOriginal: vi.fn(async () => fresh),
  };
  const task = executeStoreConfigurationOriginal({
    client,
    journal,
    prepared,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
    canDispatch: () => !disabled,
    onReserved: (cursor) => {
      pending = cursor;
    },
  });
  await arrived;
  disabled = true;
  release();
  await expect(task).rejects.toMatchObject({ code: "Conflict" });
  expect(pending).toEqual(prepared.cursor);
  expect(client.execute).not.toHaveBeenCalled();
  expect(journal.complete).not.toHaveBeenCalled();
  const result = await recoverStoreConfigurationOriginal({
    client,
    journal,
    cursor: prepared.cursor,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.receipt.outcome).toBe("Abandoned");
  expect(client.resolve).toHaveBeenCalled();
  expect(journal.complete).toHaveBeenCalledWith(prepared.cursor, receipt, fresh);
});
it("unchanged dispatch permission still sends only after reserve and clears only after original refresh", async () => {
  const cursor = await original(),
    receipt = await terminal(cursor),
    fresh = await workspace(cursor),
    calls: string[] = [];
  const actual = createStoreConfigurationOrdinaryClient(),
    prepared = await actual.prepare({
      profile: "StoreConfigurationOrdinaryCommandV1",
      ...scope,
      operationReference: cursor.operationReference,
      action: "Materialize",
      expectedHead: cursor.expectedHead,
      setupSelector,
      reasonCode: "SETUP_MATERIALIZATION",
    });
  const journal = {
    load: vi.fn(async () => cursor),
    reserve: vi.fn(async () => {
      calls.push("reserve");
    }),
    complete: vi.fn(async () => {
      calls.push("complete");
    }),
  };
  const client = {
    ...actual,
    execute: vi.fn(async () => {
      calls.push("execute");
      return receipt;
    }),
    refreshOriginal: vi.fn(async () => {
      calls.push("original refresh");
      return fresh;
    }),
  };
  await executeStoreConfigurationOriginal({
    client,
    journal,
    prepared,
    csrf,
    signal: new AbortController().signal,
    isCurrent: () => true,
    canDispatch: () => true,
    onReserved: () => {
      calls.push("pending");
    },
  });
  expect(calls).toEqual(["reserve", "pending", "execute", "original refresh", "complete"]);
});
