import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  materializeFullOptionSetCreation,
  parseCatalogReference,
  parseCatalogInstant,
  createCatalogOptionSetAuthoringIdentity,
  createCatalogOptionSetAuthoringResolution,
  parseCatalogOptionSetAuthoringResolutionCommand,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createOptionSetAuthoringClient,
  type OptionSetAuthoringCursor,
  type OptionSetAuthoringScope,
} from "./option-set-authoring-client.js";
import { createOptionSetAuthoringRecovery } from "./option-set-authoring-recovery.js";
import type {
  OptionSetAuthoringJournalScope,
  OptionSetAuthoringPendingJournal,
} from "./option-set-authoring-pending-journal.js";
const id = (n: number) =>
    parseCatalogReference("01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-10-05T12:00:00.000Z"),
  csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const after = (ms: number) => parseCatalogInstant(new Date(Date.parse(at) + ms).toISOString());
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
    operationReference: id(7),
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [
        {
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  };
}
function owningCreate(value = creation(), brandReference = scope.brandReference) {
  return materializeFullOptionSetCreation(
    {
      ...value,
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
    },
    {
      brandReference,
      actorReference: scope.actorReference,
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  );
}
function current() {
  const source = owningCreate();
  return {
    profile: "CatalogOptionSetCurrentEditorResultV1",
    ...scope,
    content: source.content,
    sourceDigest: source.sourceDigest,
    contentDigest: source.contentDigest,
    configurationDigest: source.configurationDigest,
    referenceEligibility: "NotEvaluated",
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function recovery(outcome: "Committed" | "Abandoned") {
  const cursor = createOptionSetAuthoringClient().prepareCreate(creation(), scope).cursor,
    command = parseCatalogOptionSetAuthoringResolutionCommand({
      profile: "CatalogOptionSetAuthoringResolutionCommandV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      actorReference: scope.actorReference,
      action: "Create" as const,
      reasonCode: "AUTHORIZED_OPERATION",
      operationReference: id(7),
      optionSetReference: null,
      expectedAggregateVersion: null,
    });
  const source = owningCreate(),
    identity =
      outcome === "Abandoned"
        ? null
        : createCatalogOptionSetAuthoringIdentity({
            command,
            sourceOperationReference: id(7),
            optionSetReference: id(6),
            versionReference: id(8),
            aggregateVersion: 1,
            originalOccurredAt: at,
            auditReference: id(12),
            originalIntentDigest: "sha256:" + "1".repeat(64),
            sourceDigest: source.sourceDigest,
            contentDigest: source.contentDigest,
            configurationDigest: source.configurationDigest,
          }),
    resolution = createCatalogOptionSetAuthoringResolution({
      outcome,
      command,
      identity,
      recordedAt: at,
    });
  return {
    cursor,
    result: {
      profile: "CatalogOptionSetAuthoringResolutionResultV1",
      storeReference: scope.storeReference,
      resolution,
      content: identity ? source.content : null,
    },
  };
}

function durable() {
  const rows = new Map<string, OptionSetAuthoringCursor>();
  let rejectReserve = false,
    rejectCleanup = false,
    actor = scope.actorReference,
    deny = false,
    failWrite = false,
    failRead = false;
  let mutationCount = 0;
  let epoch = 0;
  const requests: string[] = [];
  let outcome: "Committed" | "Abandoned" = "Abandoned";
  const journal = (s: OptionSetAuthoringJournalScope): OptionSetAuthoringPendingJournal => {
    const key = JSON.stringify(s);
    return {
      async load() {
        return rows.get(key) ?? null;
      },
      async reserve(cursor) {
        if (rejectReserve) throw Error("storage failed");
        const old = rows.get(key);
        if (old && JSON.stringify(old) !== JSON.stringify(cursor)) throw Error("CAS conflict");
        rows.set(key, cursor);
      },
      async complete(cursor) {
        if (rejectCleanup || JSON.stringify(rows.get(key)) !== JSON.stringify(cursor))
          throw Error("CAS failed");
        rows.delete(key);
      },
    };
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    void init;
    const path = String(url);
    requests.push(path);
    if (path.endsWith("/context"))
      return response({
        profile: "CatalogOptionSetAuthoringContextV1",
        action: "Create",
        ...scope,
        actorReference: actor,
        observedAt: at,
        validUntil: after(5000),
      });
    if (path.endsWith("/create")) {
      expect(rows.size).toBe(1);
      mutationCount++;
      if (failWrite) throw Error("reply lost");
      if (deny) return response({ error: "request_denied" }, 403);
      const x = owningCreate();
      return response({
        profile: "CatalogOptionSetAuthoringCommandResultV1",
        action: "Create",
        status: "Applied",
        operationReference: id(7),
        content: x.content,
        contentDigest: x.contentDigest,
        configurationDigest: x.configurationDigest,
        storeReference: scope.storeReference,
        referenceEligibility: "NotEvaluated",
      });
    }
    if (path.endsWith("/current-editor")) {
      if (failRead) throw Error("read unavailable");
      return response(current());
    }
    if (path.endsWith("/resolve")) {
      if (deny) return response({ error: "request_denied" }, 403);
      return response(recovery(outcome).result);
    }
    throw Error("unexpected route");
  });
  const client = createOptionSetAuthoringClient(fetcher),
    mounted = () =>
      createOptionSetAuthoringRecovery({
        action: "Create",
        optionSetReference: null,
        currentContext: () => epoch,
        client,
        journal,
      });
  return {
    rows,
    fetcher,
    mounted,
    requests,
    get mutationCount() {
      return mutationCount;
    },
    set rejectReserve(v: boolean) {
      rejectReserve = v;
    },
    set rejectCleanup(v: boolean) {
      rejectCleanup = v;
    },
    set failWrite(v: boolean) {
      failWrite = v;
    },
    set failRead(v: boolean) {
      failRead = v;
    },
    set deny(v: boolean) {
      deny = v;
    },
    set actor(v: OptionSetAuthoringScope["actorReference"]) {
      actor = parseCatalogReference(v);
    },
    set outcome(v: "Committed" | "Abandoned") {
      outcome = v;
    },
    advance() {
      epoch++;
    },
  };
}
const selected = { brandReference: scope.brandReference, storeReference: scope.storeReference },
  signal = () => new AbortController().signal;
it("requires successful durable reservation before any mutation and refreshes actual current root", async () => {
  const d = durable(),
    m = d.mounted();
  expect(m.view().checked).toBe(false);
  d.rejectReserve = true;
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toThrow();
  expect(d.mutationCount).toBe(0);
  d.rejectReserve = false;
  const result = await m.write(creation(), selected, csrf, undefined, signal());
  expect(result.current.content).toEqual(owningCreate().content);
  expect(d.rows.size).toBe(0);
  expect(d.requests.at(-1)).toMatch(/current-editor$/u);
});
it("Unknown then Denied preserves exact original and prevents replacement through reload", async () => {
  const d = durable(),
    m = d.mounted();
  d.failWrite = true;
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const cursor = [...d.rows.values()][0];
  expect(cursor).toBeDefined();
  expect(cursor).not.toHaveProperty("draft");
  expect(cursor).not.toHaveProperty("csrf");
  d.failWrite = false;
  d.deny = true;
  await expect(m.retry(selected, csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  const bodies = d.fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("/create"))
    .map(([, init]) => init?.body);
  expect(bodies[0]).toBe(bodies[1]);
  const reload = d.mounted();
  await reload.inspect(selected, csrf, signal());
  expect(reload.view()).toMatchObject({ pending: true, canRetry: false });
  await expect(
    reload.write(
      { ...creation(), operationReference: id(88) },
      selected,
      csrf,
      undefined,
      signal(),
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  await expect(reload.resolve(selected, csrf, signal())).rejects.toMatchObject({ code: "Denied" });
  expect(reload.view().pending).toBe(true);
  expect(d.mutationCount).toBe(2);
});
it.each(["Committed", "Abandoned"] as const)(
  "reload explicitly resolves %s before clearing original; never redispatches",
  async (outcome) => {
    const d = durable();
    d.failWrite = true;
    await expect(
      d.mounted().write(creation(), selected, csrf, undefined, signal()),
    ).rejects.toThrow();
    d.outcome = outcome;
    const reload = d.mounted();
    await reload.inspect(selected, csrf, signal());
    const result = await reload.resolve(selected, csrf, signal());
    expect(result.result.resolution.outcome).toBe(outcome);
    expect(d.mutationCount).toBe(1);
    expect(d.rows.size).toBe(0);
    expect(reload.view().pending).toBe(false);
    expect(result.current?.content ?? null).toEqual(
      outcome === "Committed" ? owningCreate().content : null,
    );
  },
);
it("CAS cleanup failure remains locked even with a real committed receipt", async () => {
  const d = durable(),
    m = d.mounted();
  d.rejectCleanup = true;
  await m.write(creation(), selected, csrf, undefined, signal());
  expect(m.view()).toMatchObject({ pending: true, cleanupFailed: true });
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toMatchObject({
    code: "Conflict",
  });
  expect(d.mutationCount).toBe(1);
});
it("actual Actor change cannot overwrite original cursor and new login uses isolated slot", async () => {
  const d = durable(),
    m = d.mounted();
  d.failWrite = true;
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toThrow();
  d.actor = id(99);
  await expect(m.resolve(selected, csrf, signal())).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(d.rows.size).toBe(1);
  const next = d.mounted();
  await next.inspect(selected, csrf, signal());
  expect(next.view().pending).toBe(false);
  expect(d.rows.size).toBe(1);
});
it("mounted scope/CSRF epoch and aborted reads cannot unlock or dispatch", async () => {
  const d = durable(),
    m = d.mounted();
  await m.inspect(selected, csrf, signal());
  d.advance();
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toMatchObject({
    code: "ScopeChanged",
  });
  expect(d.mutationCount).toBe(0);
  const a = new AbortController();
  a.abort();
  await expect(d.mounted().inspect(selected, csrf, a.signal)).rejects.toMatchObject({
    code: "ScopeChanged",
  });
});
it("failed post-confirmation current refresh never reuses a stale editable root", async () => {
  const d = durable(),
    m = d.mounted();
  d.outcome = "Committed";
  d.failRead = true;
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toThrow();
  expect(m.view()).toMatchObject({ checked: false, pending: true });
  expect(d.rows.size).toBe(1);
  const reload = d.mounted();
  await reload.inspect(selected, csrf, signal());
  expect(reload.view().pending).toBe(true);
  await expect(
    reload.write(
      { ...creation(), operationReference: id(88) },
      selected,
      csrf,
      undefined,
      signal(),
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  d.failRead = false;
  await reload.resolve(selected, csrf, signal());
  expect(d.rows.size).toBe(0);
  expect(d.mutationCount).toBe(1);
});
it("rejects reentry while real context is awaiting", async () => {
  const d = durable(),
    m = d.mounted();
  const original = m.inspect(selected, csrf, signal());
  await expect(m.inspect(selected, csrf, signal())).rejects.toMatchObject({ code: "Unavailable" });
  await original;
});

it("late mutation response after scope rotation leaves durable original and rejects old result", async () => {
  const d = durable();
  const original = d.fetcher.getMockImplementation();
  if (!original) throw Error("missing actual transport");
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  d.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (String(url).endsWith("/create")) {
      entered();
      await waiting;
    }
    return response;
  });
  const m = d.mounted(),
    pending = m.write(creation(), selected, csrf, undefined, signal());
  await started;
  d.advance();
  release();
  await expect(pending).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(d.rows.size).toBe(1);
  expect(m.view().pending).toBe(true);
  expect(d.requests.some((p) => p.endsWith("/current-editor"))).toBe(false);
});

it("Committed resolve retains durable original when fresh read fails and survives reload", async () => {
  const d = durable(),
    m = d.mounted();
  d.outcome = "Committed";
  d.failWrite = true;
  await expect(m.write(creation(), selected, csrf, undefined, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  d.failWrite = false;
  d.failRead = true;
  await expect(m.resolve(selected, csrf, signal())).rejects.toMatchObject({ code: "Unavailable" });
  expect(d.rows.size).toBe(1);
  const reload = d.mounted();
  await reload.inspect(selected, csrf, signal());
  expect(reload.view().pending).toBe(true);
  d.failRead = false;
  await reload.resolve(selected, csrf, signal());
  expect(d.rows.size).toBe(0);
  expect(d.mutationCount).toBe(1);
});
