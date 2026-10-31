import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
} from "../contracts/store-configuration-administration.js";
import {
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryResolve,
} from "../contracts/store-configuration-original.js";
import {
  createPostgresStoreConfigurationOriginalStore,
  type StoreConfigurationOriginalStoreOptions,
} from "../infrastructure/persistence/store-configuration-original-store.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(Object.getOwnPropertyDescriptor(v, k)?.value))
      .join(",")}}`;
  const encoded = JSON.stringify(v);
  if (encoded === undefined) throw new Error("invalid controlled fixture");
  return encoded;
}
const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
function configuration() {
  return createStoreConfigurationVersion({
    configurationReference: id(6),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Draft",
    source: "StoreOverride",
    brandBaseVersionReference: id(7),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(8),
    contactReference: id(9),
    receiptReference: id(10),
    taxConfigurationReference: id(11),
    paymentConfigurationReference: id(12),
    capacityConfigurationReference: null,
    enabledServiceModes: ["Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({ isoWeekday: i + 1, intervals: [] })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(4),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  });
}
interface Database {
  originals: Record<string, unknown>[];
  legacy: Record<string, unknown>[];
}
// Controlled SQL transport verifies owner protocol behavior, not PostgreSQL/IAM/Audit acceptance.
function fixture(database: Database = { originals: [], legacy: [] }) {
  let current = at,
    auditFailure = false;
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    audits: unknown[] = [];
  const fixed = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
  const c = configuration();
  const command = parseStoreConfigurationOrdinaryCommand({
    profile: "StoreConfigurationOrdinaryCommandV1",
    ...fixed,
    operationReference: id(5),
    action: "Validate",
    expectedHead: {
      configurationReference: c.configurationReference,
      configurationVersion: 1,
      contentDigest: hash(canonical(c)),
    },
  });
  const query = vi.fn(async (statement: string, values: readonly unknown[]) => {
    if (statement.includes("transaction_isolation"))
      return { rows: [{ isolation: "read committed" }], rowCount: 1 };
    if (
      statement.startsWith("SELECT") &&
      statement.includes("FROM rms_store.store_configuration_original_operation")
    )
      return {
        rows: database.originals.filter(
          (r) =>
            r.tenant_id === values[0] &&
            r.brand_id === values[1] &&
            r.store_id === values[2] &&
            r.operation_id === values[3],
        ),
        rowCount: 1,
      };
    if (
      statement.startsWith("SELECT") &&
      statement.includes("FROM rms_store.store_configuration_authoring_operation")
    )
      return { rows: database.legacy.filter((r) => r.operation_id === values[2]), rowCount: 1 };
    if (statement.startsWith("INSERT INTO rms_store.store_configuration_original_operation")) {
      if (database.originals.some((r) => r.operation_id === values[0]))
        throw new Error("controlled unique conflict");
      database.originals.push({
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
    return { rows: [], rowCount: 1 };
  });
  const tx = { query };
  const hold = vi.fn(async () => ({ validUntil: until }));
  const options: StoreConfigurationOriginalStoreOptions = {
    ...fixed,
    transaction: tx,
    clock: { now: () => current },
    originalObservedAt: at,
    originalValidUntil: until,
    registerBeforeCommit: (_tx, g, f) => {
      guards.push(g);
      finals.push(f);
    },
    authority: { holdUntilTransactionCompletes: hold },
    references: { canonicalize: canonical, hashIntent: hash, nextReference: () => id(20) },
    appendAbandonedAudit: async (_tx, input) => {
      if (auditFailure) throw new Error("controlled actual Audit failure");
      audits.push(input);
    },
  };
  const store = createPostgresStoreConfigurationOriginalStore(options);
  const resolve = parseStoreConfigurationOrdinaryResolve({
    ...command,
    profile: "StoreConfigurationOrdinaryResolveV1",
    intentDigest: hash(canonical(command)),
  });
  const originalInput = {
    operationReference: parseStoreAdministrationReference(id(5)),
    actorReference: parseStoreAdministrationReference(id(4)),
    purposeCode: "STORE_CONFIGURATION",
    auditReference: parseStoreAdministrationReference(id(20)),
    expectedVersion: 1,
    occurredAt: parseCanonicalInstant(at),
    configuration: c,
  };
  const addLegacy = (result = c) => {
    const legacyDigest = hash(
      JSON.stringify({
        command: "Validate",
        operationReference: originalInput.operationReference,
        actorReference: originalInput.actorReference,
        purposeCode: originalInput.purposeCode,
        auditReference: originalInput.auditReference,
        expectedVersion: originalInput.expectedVersion,
        configuration: originalInput.configuration,
      }),
    );
    database.legacy.push({
      operation_id: id(5),
      command_type: "Validate",
      intent_digest: legacyDigest,
      configuration_json: result,
      actor_reference: id(4),
      purpose_code: "STORE_CONFIGURATION",
      audit_reference: id(20),
      expected_version: "1",
      occurred_at: at,
    });
  };
  return {
    store,
    options,
    command,
    resolve,
    originalInput,
    addLegacy,
    database,
    audits,
    hold,
    query,
    tx,
    setNow: (value: string) => {
      current = value;
    },
    failAudit: () => {
      auditFailure = true;
    },
    finish: async () => {
      for (const g of guards) await g();
      for (const f of finals) f();
      return store.assertFinalized(tx);
    },
  };
}
describe("ordinary Store configuration immutable originals", () => {
  it("an absent read is nonterminal and allocates neither Audit nor terminal", async () => {
    const h = fixture();
    expect(await h.store.readOriginal(h.command)).toBeNull();
    expect(h.audits).toHaveLength(0);
    expect(h.database.originals).toHaveLength(0);
    expect(await h.finish()).toBe(until);
  });
  it("durably abandons absent original and exact late execute returns the same receipt", async () => {
    const h = fixture();
    const receipt = await h.store.resolve(h.resolve);
    expect(receipt.outcome).toBe("Abandoned");
    expect(h.audits).toHaveLength(1);
    expect(h.database.originals).toHaveLength(1);
    expect(await h.store.recordCommitted(h.command, h.originalInput)).toEqual(receipt);
    await h.finish();
    const again = fixture(h.database);
    expect(await again.store.resolve(again.resolve)).toEqual(receipt);
    expect(again.audits).toHaveLength(0);
    await again.finish();
  });
  it("records actual 005 success with its original input digest, distinct from ordinary intent", async () => {
    const h = fixture();
    expect(await h.store.readOriginal(h.command)).toBeNull();
    h.addLegacy();
    const receipt = await h.store.recordCommitted(h.command, h.originalInput);
    expect(receipt.outcome).toBe("Committed");
    expect(receipt.operation?.intentDigest).not.toBe(receipt.intentDigest);
    expect(h.audits).toHaveLength(0);
    await h.finish();
    const again = fixture(h.database);
    expect(await again.store.resolve(again.resolve)).toEqual(receipt);
    await again.finish();
  });
  it("binds Materialize scalar Setup pins to its actual server-created SaveDraft result", async () => {
    const h = fixture();
    const result = createStoreConfigurationVersion({
      ...h.originalInput.configuration,
      setupBasis: {
        profile: "StoreSetupConfigurationBasisV2",
        tenantReference: id(1),
        setupDraftReference: id(31),
        sourceRevision: 2,
        sourceSnapshotDigest: hash("actual whole source"),
        feeContexts: [
          { chargeType: "ServiceCharge", state: "Disabled" },
          { chargeType: "DeliveryFee", state: "Disabled" },
          { chargeType: "Tip", state: "Disabled" },
        ],
      },
    });
    const command = parseStoreConfigurationOrdinaryCommand({
      ...h.command,
      action: "Materialize",
      expectedHead: { configurationReference: null, configurationVersion: 0, contentDigest: null },
      setupSelector: {
        setupDraftReference: id(31),
        sourceRevision: 2,
        sourceSnapshotDigest: hash("actual whole source"),
      },
      reasonCode: "INTERNAL_TEST",
    });
    const input = { ...h.originalInput, expectedVersion: 0, configuration: result };
    const oldDigest = hash(
      JSON.stringify({
        command: "SaveDraft",
        operationReference: input.operationReference,
        actorReference: input.actorReference,
        purposeCode: input.purposeCode,
        auditReference: input.auditReference,
        expectedVersion: input.expectedVersion,
        configuration: input.configuration,
      }),
    );
    h.database.legacy.push({
      operation_id: id(5),
      command_type: "SaveDraft",
      intent_digest: oldDigest,
      configuration_json: result,
      actor_reference: id(4),
      purpose_code: "STORE_CONFIGURATION",
      audit_reference: id(20),
      expected_version: "0",
      occurred_at: at,
    });
    const receipt = await h.store.recordCommitted(command, input);
    expect(receipt.operation?.command).toBe("SaveDraft");
    expect(receipt.operation?.configuration.configurationReference).toBe(id(6));
    expect(receipt.intentDigest).toBe(hash(canonical(command)));
    await h.finish();
  });
  it("keeps the real pre-preparation input hash when result metadata differs", async () => {
    const h = fixture();
    h.originalInput.configuration = createStoreConfigurationVersion({
      ...h.originalInput.configuration,
      createdAt: "2026-10-05T09:59:59.999Z",
      updatedAt: "2026-10-05T09:59:59.999Z",
    });
    h.addLegacy();
    const receipt = await h.store.recordCommitted(h.command, h.originalInput);
    expect(receipt.operation?.configuration.updatedAt).toBe(at);
    const row = h.database.originals[0];
    if (!row) throw new Error("missing fixture terminal");
    expect(row.legacy_input_json).toMatchObject({
      configuration: { updatedAt: "2026-10-05T09:59:59.999Z" },
    });
    await h.finish();
  });
  it("does not manufacture a new terminal from a historical legacy-only original", async () => {
    const h = fixture();
    h.addLegacy();
    await expect(h.store.resolve(h.resolve)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
    });
    expect(h.database.originals).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
  it("rejects a wrong actual legacy actor", async () => {
    const h = fixture();
    h.addLegacy();
    h.database.legacy[0] = { ...h.database.legacy[0], actor_reference: id(30) };
    await expect(h.store.recordCommitted(h.command, h.originalInput)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.database.originals).toHaveLength(0);
  });
  it("rejects replay with a different ordinary expected whole-state digest", async () => {
    const h = fixture();
    await h.store.resolve(h.resolve);
    const changed = {
      ...h.command,
      expectedHead: { ...h.command.expectedHead, contentDigest: hash("other") },
    };
    await expect(h.store.readOriginal(changed)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
    });
    expect(h.database.originals).toHaveLength(1);
  });
  it("requires the actual scope Actor before any SQL write", async () => {
    const h = fixture();
    await expect(
      h.store.readOriginal({ ...h.command, actorReference: id(30) }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED" });
    expect(h.query).not.toHaveBeenCalled();
  });
  it("refuses a getter in captured actual input without executing it", async () => {
    const h = fixture();
    h.addLegacy();
    const getter = vi.fn(() => id(4));
    const original = { ...h.originalInput };
    Object.defineProperty(original, "actorReference", { enumerable: true, get: getter });
    await expect(h.store.recordCommitted(h.command, original)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("detects same-transaction mutation of a held original at final guard", async () => {
    const h = fixture();
    await h.store.resolve(h.resolve);
    const row = h.database.originals[0];
    if (!row) throw new Error("missing fixture row");
    row.receipt_digest = hash("tampered");
    await expect(h.finish()).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
    });
  });
  it("detects a late legacy insertion after a nonterminal absent read", async () => {
    const h = fixture();
    await h.store.readOriginal(h.command);
    h.addLegacy();
    await expect(h.finish()).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("retains the shorter actual authority deadline without renewal", async () => {
    const h = fixture();
    h.hold.mockResolvedValue({ validUntil: "2026-10-05T10:00:01.000Z" });
    await h.store.readOriginal(h.command);
    h.setNow("2026-10-05T10:00:01.000Z");
    await expect(h.finish()).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("captured transaction replacement poisons finalization", async () => {
    const h = fixture();
    await h.store.readOriginal(h.command);
    h.options.transaction.query = async () => ({ rows: [] });
    await expect(h.finish()).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("failed actual Audit prevents any abandoned terminal insert", async () => {
    const h = fixture();
    h.failAudit();
    await expect(h.store.resolve(h.resolve)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_ORIGINAL_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.database.originals).toHaveLength(0);
  });
});
