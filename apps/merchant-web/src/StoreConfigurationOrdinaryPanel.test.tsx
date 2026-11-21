// Controlled workflow boundary behavior, not native IAM/Publishing qualification.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import {
  StoreConfigurationOrdinaryPanel,
  recoverStoreConfigurationOriginal,
  executeStoreConfigurationOriginal,
  StoreConfigurationHistoryView,
  appendStoreConfigurationHistory,
  storeConfigurationPendingText,
  storeConfigurationNextStep,
  storeConfigurationResultStands,
} from "./StoreConfigurationOrdinaryPanel.js";
import { setLanguageForTest } from "./i18n/i18n.js";
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
import { StoreSetupClientError } from "./store-setup-client.js";
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
  expect(html).toContain("Approval and publishing");
  expect(findInternalText([staticText(html)])).toEqual([]);
  expect(html).toContain("Loading Store configuration");
  expect(html).not.toContain("Publish to the Store");
  // b19 (v3): earlier changes are folded away; no boxed refresh buttons up front.
  expect(html).toContain("<details");
  expect(html).not.toContain("Refresh Store configuration");
});
it("b19: offers one solid next step for each state, with the same commands as before", () => {
  const base = {
    saved: true,
    setupIncomplete: false,
    setupOutdated: false,
    openByAnother: false,
    openYours: false,
    lifecycle: null,
    ownChange: false,
    soleOperator: false,
  } as const;
  const step = (change: Partial<Parameters<typeof storeConfigurationNextStep>[0]>) =>
    storeConfigurationNextStep({ ...base, ...change });
  // Nothing open: create the change from the saved setup, when it is complete and current.
  expect(step({})?.action).toBe("Materialize");
  expect(step({})?.alternative).toBeUndefined();
  expect(step({ setupIncomplete: true })).toBeNull();
  expect(step({ setupOutdated: true })).toBeNull();
  expect(step({ saved: false })).toBeNull();
  // Your draft, created from the setup as saved: send it for approval.
  expect(step({ lifecycle: "Draft", openYours: true, setupOutdated: true })?.action).toBe("Submit");
  expect(step({ lifecycle: "Draft", openByAnother: true, setupOutdated: true })).toBeNull();
  expect(step({ lifecycle: "Draft", openByAnother: true })).toBeNull();
  // Waiting for approval: someone else's is approved here; your own alone as sole operator.
  expect(step({ lifecycle: "PendingApproval", setupOutdated: true })?.action).toBe("Approve");
  expect(
    step({ lifecycle: "PendingApproval", ownChange: true, soleOperator: true, setupOutdated: true })
      ?.action,
  ).toBe("SoleOperator");
  expect(
    step({ lifecycle: "PendingApproval", openYours: true, ownChange: true, setupOutdated: true }),
  ).toBeNull();
  // Approved: publish.
  const publish = step({ lifecycle: "Approved", openYours: true, setupOutdated: true });
  expect(publish?.action).toBe("Publish");
  expect(publish?.label).toBe("Publish to the Store");
  expect(publish?.effect).toMatch(/live at once/u);
  // b19 review: as before, the setup saved again over your own open change can be created again
  // in every state (it replaces that change), and the change's own step stays offered beside it.
  const draft = step({ lifecycle: "Draft", openYours: true });
  expect(draft?.action).toBe("Materialize");
  expect(draft?.alternative?.action).toBe("Submit");
  expect(draft?.alternative?.label).toBe("Or send this change for approval as it is");
  const waiting = step({ lifecycle: "PendingApproval", openYours: true, ownChange: true });
  expect(waiting?.action).toBe("Materialize");
  expect(waiting?.alternative).toBeUndefined();
  expect(waiting?.effect).toMatch(/not in the change waiting for approval/u);
  expect(waiting?.effect).toMatch(/sent for approval again/u);
  const alone = step({
    lifecycle: "PendingApproval",
    openYours: true,
    ownChange: true,
    soleOperator: true,
  });
  expect(alone?.action).toBe("Materialize");
  expect(alone?.alternative?.action).toBe("SoleOperator");
  const approved = step({ lifecycle: "Approved", openYours: true });
  expect(approved?.action).toBe("Materialize");
  expect(approved?.alternative?.action).toBe("Publish");
  expect(approved?.effect).toMatch(/approved again before it is published/u);
  for (const lifecycle of ["Draft", "PendingApproval", "Approved", null] as const) {
    for (const setupOutdated of [true, false]) {
      const next = step({
        lifecycle,
        openYours: lifecycle !== null,
        ownChange: lifecycle === "PendingApproval",
        setupOutdated,
      });
      const words = [next?.label ?? "", next?.effect ?? "", next?.alternative?.label ?? ""];
      expect(findInternalText(words)).toEqual([]);
      expect(words.join(" ")).not.toMatch(/[Vv]ersion \d/u);
    }
  }
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
/** b22: n, n-1, … down to `to` (a page of Earlier changes is 20 steps). */
const steps = (from: number, to: number) =>
  Array.from({ length: from - to + 1 }, (_, i) => from - i);
it("displays recorded changes in staff words without actor, audit or purpose codes", () => {
  const page = recordedPage(null, steps(40, 21), true),
    html = renderToStaticMarkup(<StoreConfigurationHistoryView entries={page.entries} />);
  expect(html).toContain("Checked");
  // b19: what was done and when, without version numbers.
  expect(html).not.toContain("Version");
  expect(html).not.toContain(id(40));
  expect(html).not.toContain("Original author");
  expect(findInternalText([staticText(html)], [/\bUTC\b/u])).toEqual([]);
  expect(html).not.toContain(page.entries[0]?.intentDigest ?? "missing digest");
});
it("appends only the correct strictly older immutable page and refuses wrong selectors or duplicate operations", () => {
  const first = recordedPage(null, steps(40, 21), true),
    second = recordedPage(21, steps(20, 1), false);
  expect(
    appendStoreConfigurationHistory(first.entries, second).map((e) => e.sequenceNumber),
  ).toEqual(steps(40, 1));
  expect(() =>
    appendStoreConfigurationHistory(first.entries, { ...second, beforeSequence: 22 }),
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
it("dispatches the Owner's own approval as sole operator only when asked (WP-2423)", async () => {
  const cursor = await original(id(94), "Approve"),
    receipt = await terminal(cursor),
    fresh = await workspace(cursor);
  const actual = createStoreConfigurationOrdinaryClient(),
    prepared = await actual.prepare({
      profile: "StoreConfigurationOrdinaryCommandV1",
      ...scope,
      operationReference: cursor.operationReference,
      action: "Approve",
      expectedHead: cursor.expectedHead,
    });
  const journal = { load: vi.fn(async () => cursor), reserve: vi.fn(), complete: vi.fn() };
  const execute = vi.fn(async () => receipt);
  const client = { ...actual, execute, refreshOriginal: vi.fn(async () => fresh) };
  const run = (approvalMode?: "SoleOperator") =>
    executeStoreConfigurationOriginal({
      client,
      journal,
      prepared,
      csrf,
      signal: new AbortController().signal,
      isCurrent: () => true,
      canDispatch: () => true,
      onReserved: () => undefined,
      ...(approvalMode === undefined ? {} : { approvalMode }),
    });
  await run("SoleOperator");
  expect(execute).toHaveBeenLastCalledWith(
    prepared,
    expect.objectContaining({ csrf }),
    "SoleOperator",
  );
  await run();
  expect(execute).toHaveBeenLastCalledWith(prepared, expect.objectContaining({ csrf }), undefined);
});

it("WP-2423 store-service-controls (v15 M33): names the unconfirmed step in the staff's language", () => {
  try {
    setLanguageForTest("zh-Hans");
    expect(storeConfigurationPendingText("Publish")).toBe(
      "之前的发布请求未确认。再做其他更改前请先恢复它；已保存的设置会保留。",
    );
    expect(storeConfigurationPendingText("Approve")).toContain("之前的批准请求");
    expect(storeConfigurationPendingText("Publish")).not.toMatch(/[A-Za-z]/u);
  } finally {
    setLanguageForTest("en");
  }
  expect(storeConfigurationPendingText("Submit")).toBe(
    "An earlier send for approval request was not confirmed. Recover it before making another change; the saved setup is kept.",
  );
});
it("b25: a step the server refuses outright (Invalid, Denied, Conflict, a named refusal) lets its original go; an unknown outcome keeps it", async () => {
  const cursor = await original(id(95), "Approve");
  const actual = createStoreConfigurationOrdinaryClient(),
    prepared = await actual.prepare({
      profile: "StoreConfigurationOrdinaryCommandV1",
      ...scope,
      operationReference: cursor.operationReference,
      action: "Approve",
      expectedHead: cursor.expectedHead,
    });
  const run = async (code: StoreSetupClientError["code"]) => {
    let pending: StoreConfigurationOriginalCursor | null = null;
    const journal = {
      load: vi.fn(async () => pending),
      reserve: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const client = {
      ...actual,
      execute: vi.fn(async () => {
        throw new StoreSetupClientError(code);
      }),
    };
    await expect(
      executeStoreConfigurationOriginal({
        client,
        journal,
        prepared,
        csrf,
        signal: new AbortController().signal,
        isCurrent: () => true,
        canDispatch: () => true,
        onReserved: (value) => {
          pending = value;
        },
        onReleased: () => {
          pending = null;
        },
      }),
    ).rejects.toMatchObject({ code });
    return { journal, pending };
  };
  for (const code of ["Invalid", "Denied", "Conflict", "SetupIncomplete"] as const) {
    const { journal, pending } = await run(code);
    expect(journal.release).toHaveBeenCalledWith(prepared.cursor);
    expect(pending).toBeNull();
  }
  for (const code of ["OutcomeUnknown", "Unavailable", "ScopeChanged"] as const) {
    const { journal, pending } = await run(code);
    expect(journal.release).not.toHaveBeenCalled();
    expect(pending).toEqual(prepared.cursor);
  }
});

it("b28 (v15 live26): a re-read that finds the same change keeps the result just shown; a moved one drops it", async () => {
  const cursor = await original(id(96)),
    created = await workspace(cursor),
    again = await workspace(cursor),
    moved = await workspace(cursor, false, true);
  // The connection came back and the status was read again: nothing changed, so
  // "Change created from the saved setup, not yet sent for approval." still describes it.
  expect(storeConfigurationResultStands(created, again)).toBe(true);
  // Someone else's change (or a step on another device) moved it on: the result no longer applies.
  expect(storeConfigurationResultStands(created, moved)).toBe(false);
  expect(storeConfigurationResultStands(null, again)).toBe(false);
});
