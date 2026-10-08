import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryResolve,
} from "@rms/store";
import {
  createMerchantStoreConfigurationOrdinary,
  type MerchantStoreConfigurationOrdinaryOptions,
  type MerchantStoreConfigurationOrdinarySourceHost,
} from "./merchant-store-configuration-ordinary.js";
const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.scope }));
const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
const scope4 = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
beforeEach(() => vi.clearAllMocks());
/** Controlled Session-scope boundary; real transaction host and Store source and
 * original parsers/factories run. This is not native encrypted Session/IAM proof. */
function fixture(
  sourceHook?: (
    tx: Parameters<MerchantStoreConfigurationOrdinaryOptions["configure"]>[0],
    host: MerchantStoreConfigurationOrdinarySourceHost,
  ) => void,
) {
  const state = {
    allowed: true,
    clock: at,
    until,
    allowedCalls: 0,
    denyAt: Infinity,
    driftAt: Infinity,
    committed: false,
  };
  const selected = { tenantReference: scope4.tenantReference };
  const scope = {
    selected,
    context: { brand: { brandReference: scope4.brandReference } },
    store: { storeReference: scope4.storeReference, locale: "en-CA", currencyCode: "CAD" },
    actorReference: scope4.actorReference,
    sessionReference: id(5),
    allowed: async () => {
      state.allowedCalls++;
      if (state.allowedCalls === state.driftAt) scope.actorReference = id(99);
      return state.allowed && state.allowedCalls < state.denyAt;
    },
    authorizationValidUntil: () => state.until,
  };
  mocks.scope.mockResolvedValue(scope);
  const queries: string[] = [],
    row: Record<string, unknown>[] = [],
    auditParameters: (readonly unknown[])[] = [];
  let auditSequence = 1;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    queries.push(sql);
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          { next_sequence: String(auditSequence), previous_hash: null, recorded_at: state.clock },
        ],
        rowCount: 1,
      };
    if (sql.startsWith("INSERT INTO platform_audit.audit_record")) {
      auditParameters.push([...values]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
      auditSequence++;
      return { rows: [{ next_sequence: String(auditSequence) }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO rms_store.store_configuration_original_operation")) {
      row.push({
        operation_id: values[0],
        tenant_id: values[1],
        brand_id: values[2],
        store_id: values[3],
        actor_id: values[4],
        action_code: values[5],
        intent_digest: values[6],
        command_json: JSON.parse(String(values[7])),
        outcome: values[8],
        committed_operation_id: values[9],
        legacy_input_json: values[10] === null ? null : JSON.parse(String(values[10])),
        legacy_intent_digest: values[11],
        receipt_json: JSON.parse(String(values[12])),
        receipt_digest: values[13],
        audit_reference: values[14],
        occurred_at: values[15],
        data_classification: "ConfigurationMetadata",
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed" }], rowCount: 1 };
    if (sql.includes("FROM rms_store.store_configuration_original_operation"))
      return { rows: row, rowCount: row.length };
    return { rows: [], rowCount: 0 };
  });
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) => {
    const result = await work({ query });
    state.committed = true;
    return result;
  });
  const baseline = vi.fn(async () => null),
    configure = vi.fn(
      (
        tx: Parameters<MerchantStoreConfigurationOrdinaryOptions["configure"]>[0],
        _scope: Parameters<MerchantStoreConfigurationOrdinaryOptions["configure"]>[1],
        sourceHost: MerchantStoreConfigurationOrdinarySourceHost,
      ) => {
        sourceHook?.(tx, sourceHost);
        return {
          publishedBaseline: baseline,
          ports: () => {
            throw new Error("fresh qualification not configured in this read fixture");
          },
          appendAudit: async () => {
            throw new Error("no write expected");
          },
          publication: {
            authorize: async () => {
              throw new Error("no publication expected");
            },
            hashContent: hash,
            publishingFamilyReference: id(6),
            configurationType: "STORE_CONFIGURATION",
            purposeCode: "STORE_CONFIGURATION",
            requiredLiveGateRequirementCodes: [],
          },
          businessDayStartSource: async () => {
            throw new Error("no materialization expected");
          },
          nextReference: () => {
            throw new Error("no materialization expected");
          },
        };
      },
    );
  const next = vi.fn(() => id(90));
  // Only unused runtime dependencies are nominally annotated. No returned owner
  // source, permission decision or qualification is cast into an accepted fact.
  const options = {
    persistence: { now: () => state.clock, transactions: { run } },
    authentication: { authorize: async () => ({ sessionReference: id(5) }) },
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure,
    nextReference: next,
  } as unknown as MerchantStoreConfigurationOrdinaryOptions;
  const service = createMerchantStoreConfigurationOrdinary(options);
  const read = {
    sessionCookie: "synthetic",
    expectedStoreReference: scope4.storeReference,
    expectedScope: scope4,
  };
  const command = parseStoreConfigurationOrdinaryCommand({
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...scope4,
    action: "Validate",
    operationReference: id(20),
    expectedHead: {
      configurationReference: id(7),
      configurationVersion: 1,
      contentDigest: "sha256:" + "c".repeat(64),
    },
  });
  const receipt = parseStoreConfigurationOrdinaryReceipt({
    ...command,
    profile: "StoreConfigurationOrdinaryReceiptV1",
    intentDigest: hash(command),
    outcome: "Abandoned",
    operation: null,
    auditReference: id(21),
    occurredAt: at,
    dataClassification: "ConfigurationMetadata",
  });
  function seedOriginal() {
    row.push({
      operation_id: receipt.operationReference,
      tenant_id: scope4.tenantReference,
      brand_id: scope4.brandReference,
      store_id: scope4.storeReference,
      actor_id: scope4.actorReference,
      action_code: receipt.action,
      intent_digest: receipt.intentDigest,
      command_json: command,
      outcome: receipt.outcome,
      committed_operation_id: null,
      legacy_input_json: null,
      legacy_intent_digest: null,
      receipt_json: receipt,
      receipt_digest: hash(receipt),
      audit_reference: receipt.auditReference,
      occurred_at: at,
      data_classification: "ConfigurationMetadata",
    });
  }
  return {
    state,
    scope,
    options,
    service,
    read,
    next,
    configure,
    baseline,
    queries,
    auditParameters,
    query,
    command,
    receipt,
    seedOriginal,
  };
}
it("returns truthful empty current state through actual owning read and final authorization", async () => {
  const f = fixture();
  const value = await f.service.read(f.read);
  expect(value.latest).toBeNull();
  expect(value.current).toBeNull();
  expect(value.expectedHead).toEqual({
    configurationReference: null,
    configurationVersion: 0,
    contentDigest: null,
  });
  expect(value.businessReferenceValidation).toBe("NotEvaluated");
  expect(f.queries.filter((sql) => sql.includes("IN SHARE MODE")).length).toBe(2);
  expect(f.state.allowedCalls).toBeGreaterThan(2);
  expect(f.next).not.toHaveBeenCalled();
});
it("retains the shortest current authority lease", async () => {
  const f = fixture();
  f.state.until = "2026-10-05T10:00:01.000Z";
  expect((await f.service.read(f.read)).validUntil).toBe(f.state.until);
});
it("refuses foreign actual Actor before acquiring configuration sources", async () => {
  const f = fixture();
  f.scope.actorReference = id(99);
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.configure).not.toHaveBeenCalled();
});
it("refuses current denied authority before source reads or allocation", async () => {
  const f = fixture();
  f.state.allowed = false;
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
});
it("refuses Actor drift within an allowed callback", async () => {
  const f = fixture();
  f.state.driftAt = 1;
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.query).not.toHaveBeenCalled();
});
it("rechecks actual authority in the final host phase", async () => {
  const f = fixture();
  f.baseline.mockImplementation(async () => {
    f.state.denyAt = f.state.allowedCalls + 1;
    return null;
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
  });
  expect(f.next).not.toHaveBeenCalled();
});
it("replays a real parsed Abandoned original without current configuration or fresh lifecycle ports", async () => {
  const f = fixture();
  f.seedOriginal();
  const value = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: f.command,
  });
  expect(value).toEqual(f.receipt);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
  expect(f.queries.some((sql) => sql.includes("ORDER BY o.sequence_number"))).toBe(false);
});
it("resolves historical Abandoned using only original identity and current fine authority", async () => {
  const f = fixture();
  f.seedOriginal();
  const value = await f.service.write({
    sessionCookie: "synthetic",
    csrf: "synthetic",
    expectedScope: scope4,
    command: {
      ...f.command,
      profile: "StoreConfigurationOrdinaryResolveV1",
      intentDigest: hash(f.command),
    },
  });
  expect(value).toEqual(f.receipt);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
});
it("does not let a changed action permission port silently admit current reads", async () => {
  const f = fixture();
  Object.defineProperty(f.options.actionPermissions, "validate", {
    value: "store.service.publish",
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.query).not.toHaveBeenCalled();
});

it("reads immutable history through held current read authority without loading today's configuration", async () => {
  const f = fixture();
  const page = await f.service.history({ ...f.read, csrf: "synthetic", beforeSequence: null });
  expect(page.entries).toEqual([]);
  expect(page.nextBeforeSequence).toBeNull();
  expect(page.readerActorReference).toBe(scope4.actorReference);
  expect(mocks.scope.mock.calls.some((call) => call[2] === "store.service.read")).toBe(true);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
  expect(
    f.queries.filter((sql) => sql.includes("ORDER BY o.sequence_number DESC LIMIT 3")),
  ).toHaveLength(2);
});
it("refuses malformed history selectors and denied current history authority without allocating", async () => {
  const f = fixture();
  await expect(
    f.service.history({ ...f.read, csrf: "synthetic", beforeSequence: 1.5 }),
  ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID" });
  expect(f.query).not.toHaveBeenCalled();
  f.state.allowed = false;
  await expect(
    f.service.history({ ...f.read, csrf: "synthetic", beforeSequence: null }),
  ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED" });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
});

it("passes real wrapped sourceHost and runs child checks/final before actual runner return then synchronous afterCommit", async () => {
  const trace: string[] = [];
  let callbackTx: Parameters<MerchantStoreConfigurationOrdinaryOptions["configure"]>[0] | undefined;
  const f = fixture((tx, host) => {
    callbackTx = tx;
    expect(Object.isFrozen(host)).toBe(true);
    void host.registerBeforeCommit(
      tx,
      async () => {
        trace.push("child check");
        expect(f.state.committed).toBe(false);
        await tx.query("SELECT $1::integer", [1]);
      },
      () => {
        trace.push("child final");
        expect(f.state.committed).toBe(false);
      },
    );
    host.registerAfterCommit(tx, () => {
      trace.push("after commit");
      expect(f.state.committed).toBe(true);
    });
  });
  const value = await f.service.read(f.read);
  expect(value.latest).toBeNull();
  expect(trace).toEqual(["child check", "child final", "after commit"]);
  expect(callbackTx).toBeDefined();
  expect(f.configure.mock.calls[0]?.[2]).toBeDefined();
});
it("wrong transaction source registration poisons work even when producer catches the rejection", async () => {
  const f = fixture((tx, host) => {
    try {
      host.registerAfterCommit({ ...tx }, () => undefined);
    } catch {
      /* An invalid producer cannot suppress the host failure. */
    }
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.committed).toBe(false);
});
it("first parent check closes registration so a child cannot append another asynchronous guard", async () => {
  const late = vi.fn();
  const f = fixture((tx, host) => {
    void host.registerBeforeCommit(
      tx,
      async () => {
        await host.registerBeforeCommit(
          tx,
          async () => {
            late();
          },
          () => undefined,
        );
      },
      () => undefined,
    );
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(late).not.toHaveBeenCalled();
  expect(f.state.committed).toBe(false);
});
it("a child final cannot register later checks and swallowed refusal still poisons finalization", async () => {
  const f = fixture((tx, host) => {
    void host.registerBeforeCommit(
      tx,
      async () => undefined,
      () => {
        try {
          host.registerAfterCommit(tx, () => undefined);
        } catch {
          /* failure is retained by the source host */
        }
      },
    );
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.committed).toBe(false);
});
it("rejects Promise-returning afterCommit without awaiting or reporting success after committed runner", async () => {
  let constructed = false;
  const f = fixture((tx, host) => {
    host.registerAfterCommit(
      tx,
      () =>
        new Promise<void>(() => {
          constructed = true;
        }),
    );
  });
  await expect(f.service.read(f.read)).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.committed).toBe(true);
  expect(constructed).toBe(true);
});
it("afterCommit cannot register another callback and the closed wrapper refuses SQL", async () => {
  let sourceHost: MerchantStoreConfigurationOrdinarySourceHost | undefined,
    tx: Parameters<MerchantStoreConfigurationOrdinaryOptions["configure"]>[0] | undefined;
  const f = fixture((actual, host) => {
    tx = actual;
    sourceHost = host;
    host.registerAfterCommit(actual, () => undefined);
  });
  await f.service.read(f.read);
  if (!sourceHost || !tx) throw new Error("actual configure boundary absent");
  const capturedHost = sourceHost,
    capturedTx = tx;
  expect(() => capturedHost.registerAfterCommit(capturedTx, () => undefined)).toThrow();
  const before = f.queries.length;
  await expect(capturedTx.query("SELECT $1::integer", [1])).rejects.toBeDefined();
  expect(f.queries).toHaveLength(before);
});
it("original write replay does not reacquire configure or public-source hooks", async () => {
  const hooks = vi.fn(),
    f = fixture(hooks);
  f.seedOriginal();
  const reply = await f.service.write({ ...f.read, csrf: "synthetic", command: f.command });
  expect(reply).toEqual(f.receipt);
  expect(f.configure).not.toHaveBeenCalled();
  expect(hooks).not.toHaveBeenCalled();
});

it("post-commit callback failure is unknown but original Resolve returns the retained immutable terminal without configure again", async () => {
  const f = fixture((tx, host) => {
    host.registerAfterCommit(tx, () => Promise.resolve(undefined));
  });
  f.seedOriginal();
  const original = parseStoreConfigurationOrdinaryResolve({
    ...f.command,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: f.receipt.intentDigest,
  });
  await expect(f.service.read({ ...f.read, csrf: "synthetic", original })).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.committed).toBe(true);
  const calls = f.configure.mock.calls.length;
  const recovered = await f.service.write({ ...f.read, csrf: "synthetic", command: original });
  expect(recovered).toEqual(f.receipt);
  expect(f.configure).toHaveBeenCalledTimes(calls);
  expect(f.next).not.toHaveBeenCalled();
});

it("fresh absent Resolve writes real Internal Audit and durable Abandoned; late fresh command returns same terminal without qualification", async () => {
  const f = fixture(),
    original = parseStoreConfigurationOrdinaryResolve({
      ...f.command,
      profile: "StoreConfigurationOrdinaryResolveV1",
      intentDigest: hash(f.command),
    });
  const reply = await f.service.write({ ...f.read, csrf: "synthetic", command: original });
  expect(reply.outcome).toBe("Abandoned");
  expect(reply.operation).toBeNull();
  expect(reply.operationReference).toBe(f.command.operationReference);
  expect(reply.intentDigest).toBe(hash(f.command));
  expect(f.state.committed).toBe(true);
  expect(f.auditParameters).toHaveLength(1);
  const audit = f.auditParameters[0];
  if (!audit) throw new Error("actual Audit append was not reached");
  expect(audit[0]).toBe(reply.auditReference);
  expect(audit[1]).toBe(scope4.brandReference);
  expect(audit[2]).toBe(scope4.storeReference);
  expect(audit[3]).toBe("User");
  expect(audit[4]).toBe(scope4.actorReference);
  expect(audit[5]).toBe("STORE_CONFIGURATION_ORIGINAL_ABANDONED");
  expect(audit[7]).toBe(f.command.operationReference);
  expect(JSON.parse(String(audit[9]))).toEqual({ intentDigest: reply.intentDigest });
  expect(audit[11]).toBe(f.command.operationReference);
  expect(audit[12]).toBe(at);
  expect(audit[15]).toBe("Internal");
  expect(reply.dataClassification).toBe("ConfigurationMetadata");
  const inserts = f.queries.filter((sql) =>
    sql.startsWith("INSERT INTO rms_store.store_configuration_original_operation"),
  ).length;
  expect(inserts).toBe(1);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).toHaveBeenCalledTimes(1);
  const late = await f.service.write({ ...f.read, csrf: "synthetic", command: f.command });
  expect(late).toEqual(reply);
  const recovered = await f.service.write({ ...f.read, csrf: "synthetic", command: original });
  expect(recovered).toEqual(reply);
  expect(
    f.queries.filter((sql) =>
      sql.startsWith("INSERT INTO rms_store.store_configuration_original_operation"),
    ),
  ).toHaveLength(1);
  expect(f.auditParameters).toHaveLength(1);
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.next).toHaveBeenCalledTimes(1);
});
