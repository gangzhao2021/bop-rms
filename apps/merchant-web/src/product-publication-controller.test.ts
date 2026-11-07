import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createProductPublicationController,
  type ProductPublicationIntent,
} from "./product-publication-controller.js";
import { createProductPublicationManagementClient } from "./product-publication-management-client.js";
import {
  createProductPublicationCommandClient,
  productPublicationUserActions,
  type ProductPublicationUserCommand,
} from "./product-publication-command-client.js";
import type { PublicationPendingJournal } from "./product-publication-pending-journal.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
const id = (n: number) => "01902443-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z",
  hash = "sha256:" + "1".repeat(64);
const request = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    expectedAggregateVersion: 7,
  },
  input = { request, csrf: "c".repeat(43) };
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
function seal(v: Record<string, unknown>) {
  const { digest, ...body } = v;
  void digest;
  return {
    ...body,
    digest: "sha256:" + createHash("sha256").update(canonical(body)).digest("hex"),
  };
}
function row() {
  return {
    versionReference: id(6),
    publicationVersion: 2,
    state: "Scheduled",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Store", reference: id(3), channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: at,
        localDateTime: "2026-09-30T18:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    scheduleReference: id(20),
    scheduleVersion: 2,
    recordedAt: at,
  };
}
function fixture() {
  return {
    profile: "CatalogProductPublicationManagementV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    aggregateVersion: 7,
    observedAt: at,
    validUntil: "2026-09-30T22:00:05.000Z",
    coverage: "CompleteRecordedPublicationManagement",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    draft: {
      versionReference: id(6),
      contentDigest: hash,
      configurationDigest: hash,
      contentStatus: "Present",
    },
    versions: [row()],
  };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
function setup(journal?: PublicationPendingJournal, currentRoot = 7) {
  let stored: unknown | null = null;
  let time = Date.parse(at),
    context = 0,
    denied = false,
    unknown = false,
    commandDenied = false,
    changed = false,
    absent = false,
    unavailableDraft = false,
    sourceReads = 0,
    gateReads = 0,
    expireOnGate = 0;
  const bodies: string[] = [],
    headers: unknown[] = [];
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  let blockSource = false,
    blockCommand = false;
  const send = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "/merchant/store-capability") {
      gateReads++;
      if (expireOnGate === gateReads) time += 5000;
      if (denied) return response({ error: "request_denied" }, 403);
      return response({
        brandReference: id(2),
        storeReference: id(3),
        capabilityKey: "catalog.cat_product_edit",
        controlKey: "catalog.product.edit",
        backendExecution: "Allow",
        frontendVisibility: "Show",
        reason: "Enabled",
        source: "StoreOverride",
        controlReference: id(20),
        controlVersion: 1,
        observedAt: new Date(time).toISOString(),
      });
    }
    if (url === "/merchant/catalog/products/publication/management") {
      sourceReads++;
      if (blockSource) {
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const raw = fixture();
      raw.observedAt = new Date(time).toISOString();
      raw.validUntil = new Date(time + 5000).toISOString();
      if (changed) {
        const v = raw.versions[0];
        if (v) v.scheduleVersion++;
      }
      if (absent) raw.versions = [];
      if (unavailableDraft) raw.draft.contentStatus = "Unavailable";
      return response(seal(raw));
    }
    if (url === "/merchant/catalog/products/publication") {
      bodies.push(String(init?.body));
      headers.push(init?.headers);
      if (blockCommand) {
        entered?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (commandDenied) return response({ error: "request_denied" }, 403);
      if (unknown) throw Error("Synthetic lost reply after native-compatible commit");
      const c = JSON.parse(String(init?.body)) as ProductPublicationUserCommand;
      const states = {
        Validate: "Draft",
        SubmitReview: "InReview",
        Approve: "Approved",
        Reject: "Draft",
        Publish: "Published",
        SchedulePublish: "Scheduled",
        ReschedulePublish: "Scheduled",
        CancelScheduledPublish: "Draft",
      };
      return response({
        status: bodies.length > 1 ? "Replayed" : "Applied",
        operationReference: c.operationReference,
        productReference: c.productReference,
        versionReference: c.versionReference,
        aggregateVersion: c.expectedProductAggregateVersion + 1,
        publicationVersion: c.expectedPublicationVersion + 1,
        state: states[c.action],
        scheduleVersion: c.scheduleReference ? 3 : 0,
        effectiveFrom: c.effectivePeriod.effectiveFrom.instant,
        successorDraftVersionReference: c.successorDraftVersionReference,
      });
    }
    throw Error("Unexpected synthetic route");
  });
  const { expectedAggregateVersion, ...scope } = request;
  void expectedAggregateVersion;
  const commands = createProductPublicationCommandClient(send),
    prepare = vi.fn(commands.prepare);
  const controller = createProductPublicationController({
    request: { ...request, expectedAggregateVersion: currentRoot },
    currentScope: () => scope,
    currentContext: () => context,
    now: () => time,
    reads: createProductPublicationManagementClient(send, () => time),
    capabilities: createStoreCapabilityClient(send, () => time),
    commands: { prepare, recover: commands.recover },
    journal: journal ?? {
      async load() {
        return stored;
      },
      async reserve(record) {
        stored = record;
      },
      async complete() {
        stored = null;
      },
    },
  });
  const signal = () => new AbortController().signal;
  return {
    controller,
    signal,
    bodies,
    headers,
    prepare,
    reads: () => sourceReads,
    gates: () => gateReads,
    setTime: (v: number) => {
      time = v;
    },
    setDenied: (v: boolean) => {
      denied = v;
    },
    setUnknown: (v: boolean) => {
      unknown = v;
    },
    setCommandDenied: (v: boolean) => {
      commandDenied = v;
    },
    setChanged: () => {
      changed = true;
    },
    setAbsent: () => {
      absent = true;
    },
    setUnavailableDraft: () => {
      unavailableDraft = true;
    },
    expireGate: (n: number) => {
      expireOnGate = n;
    },
    changeContext: () => context++,
    block: (kind: "source" | "command") =>
      new Promise<void>((resolve) => {
        entered = resolve;
        if (kind === "source") blockSource = true;
        else blockCommand = true;
      }),
    release: () => {
      release?.();
    },
  };
}
function intent(action: ProductPublicationIntent["action"] = "Validate"): ProductPublicationIntent {
  const v = row();
  return {
    operationReference: id(30),
    versionReference: id(6),
    action,
    scopeSet: v.scopeSet,
    effectivePeriod: v.effectivePeriod,
    scheduleReference: ["SchedulePublish", "ReschedulePublish", "CancelScheduledPublish"].includes(
      action,
    )
      ? v.scheduleReference
      : null,
    successorDraftVersionReference: action === "Publish" ? id(40) : null,
    occurredAt: at,
    reasonCode: "USER_REQUEST",
  };
}
it.each(productPublicationUserActions)(
  "prepares exact owning %s intent without promoting recorded metadata",
  async (action) => {
    const s = setup();
    await s.controller.refresh(input.csrf, s.signal());
    const view = s.controller.view();
    expect(view.source?.publishValidation).toBe("Incomplete");
    const r = await s.controller.act(intent(action), input.csrf, s.signal());
    expect(r.aggregateVersion).toBe(8);
    expect(s.prepare).toHaveBeenCalledTimes(1);
    const raw = JSON.parse(s.bodies[0] ?? "null");
    expect(raw).toMatchObject({
      action,
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 2,
      contentDigest: hash,
      configurationDigest: hash,
    });
    expect(s.controller.view()).toMatchObject({
      status: "NeedsRefresh",
      revision: 8,
      pendingOperation: false,
      source: null,
    });
  },
);
it("locks new intents/refresh after unknown and retries exact original bytes after current permission restore", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  s.setUnknown(true);
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const beforeReads = s.reads();
  await expect(s.controller.refresh(input.csrf, s.signal())).rejects.toMatchObject({
    code: "PendingOperation",
  });
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "PendingOperation",
  });
  s.setTime(Date.parse(at) + 10000);
  s.setDenied(true);
  await expect(s.controller.retry(input.csrf, s.signal())).rejects.toMatchObject({
    code: "Denied",
  });
  expect(s.controller.view()).toMatchObject({ pendingOperation: true, source: null });
  s.setDenied(false);
  s.setUnknown(false);
  s.setChanged();
  const result = await s.controller.retry(input.csrf, s.signal());
  expect(result.status).toBe("Replayed");
  expect(s.bodies).toHaveLength(2);
  expect(s.bodies[1]).toBe(s.bodies[0]);
  expect(s.headers[1]).toEqual(s.headers[0]);
  expect(s.reads()).toBe(beforeReads);
  expect(s.prepare).toHaveBeenCalledTimes(1);
});
it("keeps unknown after subsequent native denial and explicit retry remains original", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  s.setUnknown(true);
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  s.setUnknown(false);
  s.setCommandDenied(true);
  await expect(s.controller.retry(input.csrf, s.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(s.controller.view().pendingOperation).toBe(true);
  s.setCommandDenied(false);
  await s.controller.retry(input.csrf, s.signal());
  expect(new Set(s.bodies).size).toBe(1);
});
it("refuses changed current schedule counter before preparing any new operation", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  s.setChanged();
  await expect(
    s.controller.act(intent("ReschedulePublish"), input.csrf, s.signal()),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.prepare).not.toHaveBeenCalled();
  expect(s.bodies).toEqual([]);
});
it("uses absent publication zero only for current complete Draft Validate and refuses later action", async () => {
  const s = setup();
  s.setAbsent();
  await s.controller.refresh(input.csrf, s.signal());
  await expect(s.controller.act(intent("Approve"), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Unavailable",
  });
  await s.controller.refresh(input.csrf, s.signal());
  await s.controller.act(intent(), input.csrf, s.signal());
  expect(JSON.parse(s.bodies[0] ?? "null").expectedPublicationVersion).toBe(0);
});
it("refuses unavailable complete content before initial Validate", async () => {
  const s = setup();
  s.setUnavailableDraft();
  await s.controller.refresh(input.csrf, s.signal());
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(s.prepare).not.toHaveBeenCalled();
});
it("refuses exclusive expiry and hidden/offline source until explicit refresh", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  s.controller.hide();
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Stale",
  });
  await s.controller.refresh(input.csrf, s.signal());
  s.setTime(Date.parse(at) + 5000);
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Stale",
  });
  expect(s.bodies).toEqual([]);
});
it("rechecks original management deadline after final capability and retains unsent original", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  s.expireGate(4);
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Stale",
  });
  expect(s.bodies).toEqual([]);
  expect(s.controller.view().pendingOperation).toBe(true);
  s.expireGate(0);
  await s.controller.retry(input.csrf, s.signal());
  expect(s.prepare).toHaveBeenCalledTimes(1);
});
it.each(["source", "command"] as const)(
  "permanently refuses late %s after context replacement",
  async (kind) => {
    const s = setup();
    await s.controller.refresh(input.csrf, s.signal());
    const entered = s.block(kind);
    const result = s.controller.act(intent(), input.csrf, s.signal());
    const refusal = expect(result).rejects.toMatchObject({ code: "ScopeChanged" });
    await entered;
    s.changeContext();
    s.release();
    await refusal;
    expect(s.controller.view()).toMatchObject({
      status: "ScopeChanged",
      source: null,
      pendingOperation: false,
    });
    await expect(s.controller.refresh(input.csrf, s.signal())).rejects.toMatchObject({
      code: "ScopeChanged",
    });
  },
);
it("rejects forged command authority and current schedule rebound without preparing", async () => {
  const s = setup();
  await s.controller.refresh(input.csrf, s.signal());
  const extra = { ...intent(), actorReference: id(99) };
  await expect(s.controller.act(extra, input.csrf, s.signal())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(s.prepare).not.toHaveBeenCalled();
  await s.controller.refresh(input.csrf, s.signal());
  await expect(
    s.controller.act(
      { ...intent("CancelScheduledPublish"), scheduleReference: id(99) },
      input.csrf,
      s.signal(),
    ),
  ).rejects.toMatchObject({ code: "Conflict" });
  expect(s.prepare).not.toHaveBeenCalled();
});
it("hides source on current permission denial and never sends a command", async () => {
  const s = setup();
  s.setDenied(true);
  await expect(s.controller.refresh(input.csrf, s.signal())).rejects.toMatchObject({
    code: "Denied",
  });
  expect(s.controller.view().source).toBeNull();
  expect(s.bodies).toEqual([]);
});

it("refuses failed or corrupt local journal before any management read or dispatch", async () => {
  for (const value of ["failed", { profile: "Forged", csrf: input.csrf }]) {
    const s = setup({
      async load() {
        if (value === "failed") throw Error("synthetic storage refusal");
        return value;
      },
      async reserve() {
        throw Error("unreachable");
      },
      async complete() {
        throw Error("unreachable");
      },
    });
    await expect(s.controller.refresh(input.csrf, s.signal())).rejects.toMatchObject({
      code: "Unavailable",
    });
    expect(s.reads()).toBe(0);
    expect(s.bodies).toEqual([]);
    expect(s.controller.view().source).toBeNull();
  }
});
it("storage reservation failure prevents send and forces scoped journal reread", async () => {
  const load = vi.fn(async () => null);
  const s = setup({
    load,
    async reserve() {
      throw Error("synthetic collision");
    },
    async complete() {
      throw Error("unreachable");
    },
  });
  await s.controller.refresh(input.csrf, s.signal());
  await expect(s.controller.act(intent(), input.csrf, s.signal())).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(s.bodies).toEqual([]);
  expect(s.controller.view().pendingOperation).toBe(false);
  await s.controller.refresh(input.csrf, s.signal());
  expect(load).toHaveBeenCalledTimes(2);
});
it("restores original without a source read, retains current refusal, and only clears after bound replay", async () => {
  let stored: unknown | null = null,
    failCleanup = true;
  const journal: PublicationPendingJournal = {
    async load() {
      return stored;
    },
    async reserve(v) {
      stored = v;
    },
    async complete() {
      if (failCleanup) throw Error("synthetic cleanup failure");
      stored = null;
    },
  };
  const first = setup(journal);
  await first.controller.refresh(input.csrf, first.signal());
  first.setUnknown(true);
  await expect(first.controller.act(intent(), input.csrf, first.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const second = setup(journal, 16);
  await second.controller.refresh(input.csrf, second.signal());
  expect(second.reads()).toBe(0);
  expect(second.prepare).not.toHaveBeenCalled();
  expect(second.controller.view()).toMatchObject({
    status: "OutcomeUnknown",
    pendingOperation: true,
    source: null,
  });
  second.setCommandDenied(true);
  await expect(second.controller.retry(input.csrf, second.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  second.setCommandDenied(false);
  await expect(second.controller.retry(input.csrf, second.signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(stored).not.toBeNull();
  failCleanup = false;
  await second.controller.retry(input.csrf, second.signal());
  expect(stored).toBeNull();
  expect(second.controller.view()).toMatchObject({
    pendingOperation: false,
    status: "NeedsRefresh",
    revision: 16,
  });
  expect(new Set([...first.bodies, ...second.bodies]).size).toBe(1);
  expect(second.reads()).toBe(0);
});
