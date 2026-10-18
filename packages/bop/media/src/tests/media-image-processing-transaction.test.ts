import { expect, it } from "vitest";
import { createMediaScope } from "../contracts/media.js";
import {
  createMediaImageProcessingTransaction,
  mediaImageProcessingRequiredFields,
  type MediaImageProcessingAuthorityInput,
  type MediaImageProcessingTransactionContext,
  type MediaImageProcessingTransactionIdentity,
  type MediaImageProcessingTransactionOptions,
} from "../infrastructure/persistence/media-image-processing-transaction.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";

const id = (n: number) => "019a2421-0022-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  time = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString(),
  intent = "sha256:" + "a".repeat(64),
  scan = "sha256:" + "b".repeat(64),
  unavailable = expect.objectContaining({ code: "MEDIA_COMMIT_FAILED" });
const input = (): MediaImageProcessingTransactionIdentity => ({
  phase: "Plan",
  sourceAssetVersionReference: id(4),
  scanEventDigest: scan,
  admissionReference: id(5),
});

it("preserves an uncertain commit result so callers recover the original operation instead of claiming rollback", async () => {
  const h = harness(),
    run = h.options.transactions.run.bind(h.options.transactions);
  h.options.transactions.run = async (work) => {
    await run(work);
    throw Object.assign(new Error("Synthetic lost commit acknowledgement"), {
      code: "COMMIT_OUTCOME_UNKNOWN",
    });
  };
  await expect(
    createMediaImageProcessingTransaction(h.options).run(input(), h.work),
  ).rejects.toThrow(expect.objectContaining({ code: "MEDIA_COMMIT_OUTCOME_UNKNOWN" }));
  expect(h.state.commits).toBe(1);
  expect(h.state.writes).toBe(1);
});
// Controlled authority and host transaction protocol; actual SQL, trusted scan
// ingress and IAM admission are owned by separate native/runtime acceptance.
function harness() {
  const holders: MediaImageProcessingAuthorityInput[] = [],
    statements: string[] = [],
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const state: {
    clock: string;
    writes: number;
    commits: number;
    savepoint: number;
    denied: boolean;
    shorten: boolean;
    lease?: "extend" | "observed" | "expired" | "extra";
    mode?:
      | "skip"
      | "async-only"
      | "final-only"
      | "unawaited"
      | "duplicate"
      | "replace"
      | "async-twice"
      | "final-twice"
      | "no-work";
    swallow?: boolean;
    beforeWork?: () => void;
    afterWork?: () => void;
    afterAsync?: () => void;
    onHold?: (input: MediaImageProcessingAuthorityInput) => Promise<void> | void;
  } = { clock: at, writes: 0, commits: 0, savepoint: 0, denied: false, shorten: false };
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string) {
      statements.push(sql);
      if (sql.includes("transaction_isolation"))
        return {
          rows: [{ isolation: "read committed" }] as unknown as readonly Row[],
          rowCount: 1,
          command: "SELECT",
          fields: [],
        };
      if (sql.startsWith("SAVEPOINT")) state.savepoint = state.writes;
      if (sql.startsWith("ROLLBACK TO")) state.writes = state.savepoint;
      if (sql === "INSERT SYNTHETIC_PROCESSING") state.writes++;
      if (sql === "FAIL SYNTHETIC_QUERY") throw Error("Synthetic SQL failure");
      return { rows: [] as unknown as readonly Row[], rowCount: 1 };
    },
  };
  const options: MediaImageProcessingTransactionOptions = {
    tenantReference: id(1),
    scope: createMediaScope({
      kind: "Brand",
      brandReference: id(2),
      storeReference: null,
    } as Parameters<typeof createMediaScope>[0]),
    systemActorReference: id(3),
    clock: { now: () => state.clock },
    async registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
    authority: {
      async holdUntilTransactionCompletes(actual, request) {
        expect(actual).toBe(tx);
        holders.push(request);
        await state.onHold?.(request);
        if (state.denied) throw Error("Synthetic current System/admission denial");
        return {
          observedAt: state.lease === "observed" ? time(1) : request.observedAt,
          validUntil:
            state.lease === "extend"
              ? time(5001)
              : state.lease === "expired"
                ? state.clock
                : state.shorten
                  ? time(2000)
                  : request.validUntil,
          ...(state.lease === "extra" ? { trusted: true } : {}),
        };
      },
    },
    transactions: {
      async run<T>(work: (actual: MediaPersistenceTransaction) => Promise<T>): Promise<T> {
        const before = state.writes;
        try {
          state.beforeWork?.();
          if (state.mode === "no-work") return undefined as T;
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (!state.swallow) throw error;
            for (const { guard } of guards) await guard();
            throw Error("Poisoned synthetic host unexpectedly continued", { cause: error });
          }
          if (state.mode === "duplicate") await work(tx);
          state.afterWork?.();
          if (state.mode === "skip") return result;
          if (state.mode === "final-only") {
            for (const { final } of guards) final();
            return result;
          }
          if (state.mode === "unawaited") {
            const pending = guards.map(({ guard }) => guard());
            try {
              for (const { final } of guards) final();
            } finally {
              await Promise.allSettled(pending);
            }
            return result;
          }
          for (const { guard } of guards) {
            await guard();
            if (state.mode === "async-twice") await guard();
          }
          if (state.mode === "async-only") return result;
          state.afterAsync?.();
          for (const { final } of guards) {
            final();
            if (state.mode === "final-twice") final();
          }
          if (state.mode === "replace") return { unexpected: true } as T;
          state.commits++;
          return result;
        } catch (error) {
          state.writes = before;
          throw error;
        }
      },
    },
  };
  const kernel = createMediaImageProcessingTransaction(options);
  const work = async (context: MediaImageProcessingTransactionContext) => {
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.tx)).toBe(true);
    await context.bind(id(6), intent);
    await context.tx.query("INSERT SYNTHETIC_PROCESSING", []);
    return Object.freeze({ receipt: id(7) });
  };
  return { state, tx, options, kernel, work, holders, statements, guards };
}

it.each(["Plan", "Complete"] as const)(
  "holds exact System and admission authority for %s through the original commit deadline",
  async (phase) => {
    const h = harness(),
      result = await h.kernel.run({ ...input(), phase }, h.work);
    expect(result).toEqual({ receipt: id(7) });
    expect(h.state.writes).toBe(1);
    expect(h.state.commits).toBe(1);
    expect(h.holders).toHaveLength(3);
    expect(h.holders[0]).toEqual({
      ...input(),
      phase,
      tenantReference: id(1),
      scope: h.options.scope,
      systemActorReference: id(3),
      actorKind: "System",
      action: "media.asset.promote",
      purposeCode: "MEDIA_IMAGE_PROMOTION",
      requiredFields: mediaImageProcessingRequiredFields,
      operationReference: null,
      originalIntentDigest: null,
      observedAt: at,
      validUntil: time(5000),
    });
    expect(
      h.holders
        .slice(1)
        .every(
          (r) =>
            r.operationReference === id(6) &&
            r.originalIntentDigest === intent &&
            r.observedAt === at,
        ),
    ).toBe(true);
    expect(h.statements[0]).toContain("transaction_isolation");
    expect(h.statements[1]).toContain("'statement_timeout','5000'");
    expect(h.statements[1]).toContain("bop.tenant_id");
    expect(h.statements.indexOf("SAVEPOINT media_image_processing")).toBeLessThan(
      h.statements.indexOf("INSERT SYNTHETIC_PROCESSING"),
    );
  },
);

it("does not refresh a shorter authority lease at binding or commit", async () => {
  const h = harness();
  h.state.shorten = true;
  h.state.afterAsync = () => {
    expect(h.state.writes).toBe(1);
    h.state.clock = time(2000);
  };
  await expect(h.kernel.run(input(), h.work)).rejects.toThrow(unavailable);
  expect(h.holders.map((r) => r.validUntil)).toEqual([time(5000), time(2000), time(2000)]);
  expect(h.state.writes).toBe(0);
  expect(h.state.commits).toBe(0);
});

it.each(["extend", "observed", "expired", "extra"] as const)(
  "rejects an invalid %s authority lease before business work",
  async (lease) => {
    const h = harness();
    h.state.lease = lease;
    await expect(h.kernel.run(input(), h.work)).rejects.toThrow(unavailable);
    expect(h.statements).toHaveLength(0);
    expect(h.guards).toHaveLength(1);
    expect(h.state.commits).toBe(0);
  },
);

it.each(["phase", "source", "digest", "admission", "getter", "clock"])(
  "registers poison protection before rejecting malformed %s",
  async (fault) => {
    const h = harness(),
      candidate: Record<string, unknown> = { ...input() };
    let getterCalls = 0;
    h.state.swallow = true;
    if (fault === "phase") candidate.phase = "User";
    if (fault === "source") candidate.sourceAssetVersionReference = "not-a-version";
    if (fault === "digest") candidate.scanEventDigest = "not-a-digest";
    if (fault === "admission") candidate.admissionReference = "not-an-admission";
    if (fault === "getter")
      Object.defineProperty(candidate, "scanEventDigest", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return scan;
        },
      });
    if (fault === "clock") h.state.clock = "invalid";
    await expect(
      h.kernel.run(candidate as unknown as MediaImageProcessingTransactionIdentity, h.work),
    ).rejects.toThrow(unavailable);
    expect(getterCalls).toBe(0);
    expect(h.guards).toHaveLength(1);
    expect(h.holders).toHaveLength(0);
    expect(h.statements).toHaveLength(0);
  },
);

it.each(["missing", "duplicate", "invalid"])(
  "refuses %s operation binding and rolls back tentative work",
  async (fault) => {
    const h = harness();
    h.state.swallow = true;
    await expect(
      h.kernel.run(input(), async (context) => {
        await context.tx.query("INSERT SYNTHETIC_PROCESSING", []);
        if (fault !== "missing") {
          await context
            .bind(fault === "invalid" ? "invalid" : id(6), intent)
            .catch(() => undefined);
          if (fault === "duplicate") await context.bind(id(6), intent).catch(() => undefined);
        }
        return "value";
      }),
    ).rejects.toThrow(unavailable);
    expect(h.statements).toContain("ROLLBACK TO SAVEPOINT media_image_processing");
    expect(h.state.writes).toBe(0);
    expect(h.state.commits).toBe(0);
  },
);

it.each([
  "work-error",
  "query-error",
  "query-substitution",
  "late-authority",
  "late-final",
  "clock-backward",
])("refuses %s after tentative work without letting a swallowed failure commit", async (fault) => {
  const h = harness();
  h.state.swallow = true;
  if (fault === "late-authority")
    h.state.afterWork = () => {
      expect(h.state.writes).toBe(1);
      h.state.denied = true;
    };
  if (fault === "late-final")
    h.state.afterAsync = () => {
      expect(h.state.writes).toBe(1);
      h.state.clock = time(5000);
    };
  await expect(
    h.kernel.run(input(), async (context) => {
      const result = await h.work(context);
      if (fault === "work-error") throw Error("Synthetic owning failure");
      if (fault === "query-error")
        await context.tx.query("FAIL SYNTHETIC_QUERY", []).catch(() => undefined);
      if (fault === "query-substitution") h.tx.query = async () => ({ rows: [] });
      if (fault === "clock-backward") h.state.clock = time(-1);
      return result;
    }),
  ).rejects.toThrow(unavailable);
  expect(h.state.writes).toBe(0);
  expect(h.state.commits).toBe(0);
});

it.each([
  "skip",
  "async-only",
  "final-only",
  "unawaited",
  "duplicate",
  "replace",
  "async-twice",
  "final-twice",
  "no-work",
] as const)("does not return an accepted result from a %s host", async (mode) => {
  const h = harness();
  h.state.mode = mode;
  await expect(h.kernel.run(input(), h.work)).rejects.toThrow(unavailable);
  expect(h.state.commits).toBe(0);
});

it("poisons the actual transaction when owning work catches a reentrant call", async () => {
  const h = harness();
  h.state.swallow = true;
  await expect(
    h.kernel.run(input(), async (context) => {
      await context.bind(id(6), intent);
      await h.kernel.run(input(), h.work).catch(() => undefined);
      return "caught";
    }),
  ).rejects.toThrow(unavailable);
  expect(h.guards).toHaveLength(1);
  expect(h.state.commits).toBe(0);
});

it("refuses facade access after work and retains poison through outer guards", async () => {
  const h = harness();
  let captured: MediaImageProcessingTransactionContext | undefined;
  h.state.afterWork = () => {
    if (!captured) throw Error("Missing captured work context");
    expect(() => captured?.now()).toThrow(unavailable);
  };
  await expect(
    h.kernel.run(input(), async (context) => {
      captured = context;
      return h.work(context);
    }),
  ).rejects.toThrow(unavailable);
  expect(h.state.writes).toBe(0);
  expect(h.state.commits).toBe(0);
});

it("refuses an escaped query before it reaches the underlying transaction", async () => {
  const h = harness();
  let captured: MediaImageProcessingTransactionContext | undefined,
    escaped: Promise<unknown> = Promise.resolve();
  h.state.afterWork = () => {
    if (!captured) throw Error("Missing captured work context");
    escaped = captured.tx.query("INSERT ESCAPED", []).catch((error: unknown) => error);
  };
  await expect(
    h.kernel.run(input(), async (context) => {
      captured = context;
      return h.work(context);
    }),
  ).rejects.toThrow(unavailable);
  expect(await escaped).toMatchObject({ code: "MEDIA_COMMIT_FAILED" });
  expect(h.statements).not.toContain("INSERT ESCAPED");
  expect(h.state.writes).toBe(0);
});

it("rejects owning work that returns while a guarded query is still pending", async () => {
  const h = harness(),
    original = h.tx.query.bind(h.tx);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pending: Promise<unknown> = Promise.resolve();
  h.tx.query = async <Row>(sql: string, values: readonly unknown[]) => {
    if (sql === "SELECT PENDING") await gate;
    return original<Row>(sql, values);
  };
  try {
    await expect(
      h.kernel.run(input(), async (context) => {
        const result = await h.work(context);
        pending = context.tx.query("SELECT PENDING", []).catch((error: unknown) => error);
        return result;
      }),
    ).rejects.toThrow(unavailable);
  } finally {
    release();
  }
  expect(await pending).toMatchObject({ code: "MEDIA_COMMIT_FAILED" });
  expect(h.state.writes).toBe(0);
  expect(h.state.commits).toBe(0);
});

it("captures descriptor data and configured authority before the host yields", async () => {
  const h = harness(),
    candidate = { ...input() };
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("Replaced holder");
  };
  h.state.beforeWork = () => {
    candidate.scanEventDigest = "sha256:" + "f".repeat(64);
    candidate.admissionReference = id(99);
  };
  expect(await h.kernel.run(candidate, h.work)).toEqual({ receipt: id(7) });
  expect(h.holders.every((r) => r.scanEventDigest === scan && r.admissionReference === id(5))).toBe(
    true,
  );
});

it("retains the entry deadline when the host waits before opening work", async () => {
  const h = harness();
  h.state.beforeWork = () => {
    h.state.clock = time(5000);
  };
  await expect(h.kernel.run(input(), h.work)).rejects.toThrow(unavailable);
  expect(h.guards).toHaveLength(1);
  expect(h.holders).toHaveLength(0);
  expect(h.state.writes).toBe(0);
});
