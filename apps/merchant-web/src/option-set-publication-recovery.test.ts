// Controlled transport/context ports test the durable browser state machine, not IAM/SQL.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createOptionSetPublicationRecovery } from "./option-set-publication-recovery.js";
import {
  OptionSetPublicationClientError,
  parseOptionSetPublicationCursor,
  type OptionSetPublicationClient,
  type OptionSetPublicationContext,
  type OptionSetPublicationCursor,
  type OptionSetPublicationReceipt,
} from "./option-set-publication-client.js";
import type { OptionSetPublicationPendingJournal } from "./option-set-publication-pending-journal.js";
const id = (n: number) => "01902421-7a00-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  hash = "sha256:" + "a".repeat(64),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  anchor = { brandReference: id(2), storeReference: id(3) },
  csrf = "A".repeat(43);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
function fixture() {
  let stored: OptionSetPublicationCursor | null = null,
    authoringPending = false,
    epoch = 0,
    writeMode = "Unknown",
    resolveMode = "Committed",
    readFail = false,
    claimFail = false,
    cleanupFail = false,
    actor = id(4);
  const context = (action: OptionSetPublicationContext["action"]): OptionSetPublicationContext => ({
    profile: "CatalogOptionSetPublicationContextV1",
    action,
    scope: { ...scope, actorReference: actor },
    observedAt: at,
    validUntil: "2026-10-04T12:00:05.000Z",
    draft: {
      optionSetReference: id(6),
      versionReference: id(8),
      expectedAggregateVersion: 1,
      sourceOperationReference: id(7),
      sourceDigest: hash,
      contentDigest: hash,
      configurationDigest: hash,
    },
    review: { kind: "AbsentForCurrentDraft" },
  });
  const receipt = (
    c: OptionSetPublicationCursor,
    outcome: "Committed" | "Abandoned",
  ): OptionSetPublicationReceipt => ({
    profile: "CatalogOptionSetPublicationReceiptV1",
    storeReference: id(3),
    operationReference: c.command.operationReference,
    action: c.command.action,
    outcome,
    recordedAt: at,
  });
  let uncertain = false;
  const execute = vi.fn(async (c: OptionSetPublicationCursor) => {
    if (writeMode === "Unknown") {
      uncertain = true;
      throw new OptionSetPublicationClientError("OutcomeUnknown");
    }
    if (writeMode === "Denied")
      throw new OptionSetPublicationClientError(
        uncertain ? "OutcomeUnknown" : "Denied",
        uncertain ? "Denied" : undefined,
      );
    return receipt(c, "Committed");
  });
  const journal: OptionSetPublicationPendingJournal = {
    load: vi.fn(async () => stored),
    reserve: vi.fn(async (c) => {
      if (claimFail) throw new OptionSetPublicationClientError("Unavailable");
      if (stored && JSON.stringify(stored) !== JSON.stringify(c))
        throw new OptionSetPublicationClientError("Conflict");
      stored = c;
    }),
    complete: vi.fn(async (c) => {
      if (cleanupFail || JSON.stringify(c) !== JSON.stringify(stored))
        throw new OptionSetPublicationClientError("Unavailable");
      stored = null;
    }),
  };
  const client: OptionSetPublicationClient = {
      context: vi.fn(async (c) => context(c.action)),
      prepare: vi.fn((c, action, op) => {
        const cursor = parseOptionSetPublicationCursor({
          profile: "CatalogOptionSetPublicationCursorV1",
          scope: c.scope,
          command: {
            profile: "CatalogOptionSetPublicationCommandRequestV1",
            action,
            operationReference: op,
            optionSetReference: id(6),
            versionReference: id(8),
            expectedAggregateVersion: 1,
            sourceDigest: hash,
            contentDigest: hash,
            configurationDigest: hash,
            expectedReview: null,
            expectedLifecycle: null,
          },
        });
        return Object.freeze({
          cursor,
          command: cursor.command,
          body: JSON.stringify(cursor.command),
          execute: async () => execute(cursor),
        });
      }),
      validate: vi.fn(async () => {
        throw new OptionSetPublicationClientError("Unavailable");
      }),
      resolve: vi.fn(async (c) => {
        const cursor = parseOptionSetPublicationCursor(c);
        if (resolveMode === "Disabled") throw new OptionSetPublicationClientError("Disabled");
        if (resolveMode === "Denied") throw new OptionSetPublicationClientError("Denied");
        return receipt(cursor, resolveMode === "Abandoned" ? "Abandoned" : "Committed");
      }),
    },
    refresh = vi.fn(async () => {
      if (readFail) throw new OptionSetPublicationClientError("Unavailable");
    }),
    create = () =>
      createOptionSetPublicationRecovery({
        optionSetReference: id(6),
        currentContext: () => epoch,
        refreshCurrent: refresh,
        client,
        authoringPending: async () => authoringPending,
        journal: () => journal,
      });
  return {
    client,
    journal,
    execute,
    refresh,
    create,
    get stored() {
      return stored;
    },
    set authoringPending(v: boolean) {
      authoringPending = v;
    },
    set writeMode(v: string) {
      writeMode = v;
    },
    set resolveMode(v: string) {
      resolveMode = v;
    },
    set readFail(v: boolean) {
      readFail = v;
    },
    set claimFail(v: boolean) {
      claimFail = v;
    },
    set cleanupFail(v: boolean) {
      cleanupFail = v;
    },
    set actor(v: string) {
      actor = v;
    },
    advance() {
      epoch++;
    },
  };
}
const signal = () => new AbortController().signal;
it("requires actual context and durable committed claim before dispatch", async () => {
  const h = fixture(),
    m = h.create();
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.execute).not.toHaveBeenCalled();
  await m.inspect(anchor, csrf, signal());
  h.claimFail = true;
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.execute).not.toHaveBeenCalled();
});
it("Unknown then Denied preserves exact original identity through reload and prevents replacement", async () => {
  const h = fixture(),
    m = h.create();
  await m.inspect(anchor, csrf, signal());
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  const original = h.stored;
  h.writeMode = "Denied";
  await expect(m.retry(anchor, csrf, signal())).rejects.toMatchObject({
    code: "OutcomeUnknown",
    attemptCode: "Denied",
  });
  expect(h.stored).toEqual(original);
  const reloaded = h.create();
  await reloaded.inspect(anchor, csrf, signal());
  expect(reloaded.view()).toMatchObject({ pending: true, canRetry: false });
  await expect(reloaded.write("SubmitReview", id(51), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.execute).toHaveBeenCalledTimes(2);
  h.resolveMode = "Denied";
  await expect(reloaded.resolve(anchor, csrf, signal())).rejects.toMatchObject({ code: "Denied" });
  expect(h.stored).toEqual(original);
});
it.each(["Committed", "Abandoned"])(
  "only actual %s plus refreshed current clears original",
  async (outcome) => {
    const h = fixture(),
      m = h.create();
    await m.inspect(anchor, csrf, signal());
    await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
    h.resolveMode = outcome;
    const restored = h.create();
    await restored.inspect(anchor, csrf, signal());
    expect(await restored.resolve(anchor, csrf, signal())).toMatchObject({ receipt: { outcome } });
    expect(h.stored).toBeNull();
    expect(h.refresh).toHaveBeenCalledOnce();
  },
);
it("confirmed write with fresh-read failure remains durable across reload until explicit recovery", async () => {
  const h = fixture(),
    m = h.create();
  await m.inspect(anchor, csrf, signal());
  h.writeMode = "Committed";
  h.readFail = true;
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.stored).not.toBeNull();
  const restored = h.create();
  await restored.inspect(anchor, csrf, signal());
  await expect(restored.write("SubmitReview", id(51), 1, anchor, csrf, signal())).rejects.toThrow();
  h.readFail = false;
  await restored.resolve(anchor, csrf, signal());
  expect(h.stored).toBeNull();
  expect(h.execute).toHaveBeenCalledOnce();
});
it("scope epoch/Actor change discards replies and never clears or replaces pending", async () => {
  const h = fixture(),
    m = h.create();
  await m.inspect(anchor, csrf, signal());
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  h.actor = id(99);
  await expect(m.resolve(anchor, csrf, signal())).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(h.stored).not.toBeNull();
  h.advance();
  await expect(m.retry(anchor, csrf, signal())).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(h.execute).toHaveBeenCalledOnce();
});
it("failed durable cleanup retains locked original and no new dispatch", async () => {
  const h = fixture(),
    m = h.create();
  await m.inspect(anchor, csrf, signal());
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  h.cleanupFail = true;
  await m.resolve(anchor, csrf, signal());
  expect(m.view()).toMatchObject({ pending: true, cleanupFailed: true, checked: false });
  await expect(m.write("SubmitReview", id(51), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.stored).not.toBeNull();
});
it("actual Disabled during original resolution leaves durable barrier intact", async () => {
  const h = fixture(),
    m = h.create();
  await m.inspect(anchor, csrf, signal());
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  h.resolveMode = "Disabled";
  const restored = h.create();
  await restored.inspect(anchor, csrf, signal());
  await expect(restored.resolve(anchor, csrf, signal())).rejects.toMatchObject({
    code: "Disabled",
  });
  expect(h.stored).not.toBeNull();
  expect(restored.view().pending).toBe(true);
});
it("actual local Edit pending blocks new publication even on Detail, but original publication resolution remains possible", async () => {
  const h = fixture(),
    m = h.create();
  h.authoringPending = true;
  await m.inspect(anchor, csrf, signal());
  expect(m.view().authoringPending).toBe(true);
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  expect(h.execute).not.toHaveBeenCalled();
  h.authoringPending = false;
  await m.inspect(anchor, csrf, signal());
  await expect(m.write("SubmitReview", id(50), 1, anchor, csrf, signal())).rejects.toThrow();
  h.authoringPending = true;
  await m.resolve(anchor, csrf, signal());
  expect(h.stored).toBeNull();
});
