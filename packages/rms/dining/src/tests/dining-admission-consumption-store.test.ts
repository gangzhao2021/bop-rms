import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDiningJoinCapability } from "@bop/public-capability";
import {
  createDiningTable,
  createPostgresDiningAdmissionConsumptionStore,
  consumeDiningIdentityAdmission,
  parseDiningHash,
  parseDiningIdentityAdmission,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
  type DiningAdmissionConsumptionAuditFactory,
  type DiningTableTransactionRunner,
} from "../index.js";
const id = (n: number) => `01902290-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const start = "2026-07-29T12:00:00.000Z";
const joined = "2026-07-29T12:01:00.000Z";
const now = "2026-07-29T12:02:00.000Z";
const scope = { tenantReference: id(13), brandReference: id(7), storeReference: id(4) };
const hash = (value: string) => parseDiningHash(createHash("sha256").update(value).digest("hex"));
const credentials = { hashOperationIntent: hash, equals: (a: string, b: string) => a === b };
const dependency = { code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" };
function fixture() {
  const session = parseDiningSession({
    diningSessionReference: id(2),
    brandReference: id(7),
    storeReference: id(4),
    tableReference: id(5),
    tableAssignmentVersion: 7,
    phase: "Active",
    version: 2,
    startedByActorReference: id(8),
    startedAt: start,
    hostParticipantReference: id(3),
  });
  const participant = parseDiningParticipant({
    participantReference: id(3),
    diningSessionReference: id(2),
    status: "Active",
    version: 1,
    joinedAt: joined,
    leftAt: null,
  });
  const capability = parseDiningJoinCapability({
    capabilityReference: id(10),
    purpose: "DiningJoin",
    kind: "Invitation",
    storeReference: id(4),
    tableReference: id(5),
    diningSessionReference: id(2),
    selectorHash: "a".repeat(64),
    pepperVersion: 1,
    assignmentVersion: 7,
    generation: 1,
    status: "Consumed",
    version: 2,
    issuedAt: start,
    expiresAt: "2026-07-29T12:15:00.000Z",
    consumedAt: joined,
    revokedAt: null,
  });
  const joinHash = hash(`Join:${id(9)}:${id(10)}`);
  const admission = parseDiningIdentityAdmission({
    admissionReference: id(1),
    diningSessionReference: id(2),
    participantReference: id(3),
    storeReference: id(4),
    tableReference: id(5),
    tableAssignmentVersion: 7,
    operationReference: id(6),
    operationIntentHash: joinHash,
    status: "Active",
    version: 1,
    issuedAt: joined,
    consumedAt: null,
  });
  const join = {
    session,
    participant,
    admission,
    capability,
    operationReference: parseDiningReference(id(6)),
    operationIntentHash: joinHash,
  };
  const state = {
    session,
    participant,
    admission,
    join,
    joinedGuestSessionReference: parseDiningReference(id(9)),
    table: parseDiningTableStartEvidence({
      brandReference: id(7),
      storeReference: id(4),
      tableReference: id(5),
      assignmentVersion: 7,
      tableState: "Eligible",
      activeDiningSessionReference: id(2),
      observedAt: now,
    }),
  };

  const table = createDiningTable({
    ...scope,
    tableReference: id(5),
    stableLabel: "T",
    areaReference: id(20),
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Inactive",
    qrVersion: 0,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: id(2),
    aggregateVersion: 8,
    createdAt: start,
    observedAt: start,
  });
  const raw = { ...state, table };
  let row: unknown = raw;
  let original: unknown = null;
  const record = {
    operationReference: parseDiningReference(id(11)),
    guestSessionReference: parseDiningReference(id(9)),
    operationIntentHash: hash(`ConsumeDiningAdmission:${id(9)}:${id(1)}`),
    admission: consumeDiningIdentityAdmission({
      admission,
      session,
      participant,
      table: state.table,
      expectedAdmissionVersion: 1,
      expectedSessionVersion: 2,
      observedAt: now,
    }),
  };
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async (sql) => {
      if (sql.startsWith("SELECT s.session_snapshot")) return { rows: row === null ? [] : [row] };
      if (sql.startsWith("SELECT record_json"))
        return { rows: original === null ? [] : [{ record: original }] };
      if (sql.includes("FOR UPDATE")) {
        const reference = sql.includes("FROM rms_dining.dining_table ")
          ? id(5)
          : sql.includes("FROM rms_dining.dining_session ")
            ? id(2)
            : sql.includes("FROM rms_dining.dining_participant ")
              ? id(3)
              : id(1);
        return { rows: [{ reference }] };
      }
      if (sql.startsWith("UPDATE") || sql.startsWith("INSERT"))
        throw new Error("unexpected synthetic write");
      return { rows: [] };
    },
  );
  const runs = vi.fn();
  const runner: DiningTableTransactionRunner = {
    run: async (action) => {
      runs();
      return action({ query });
    },
  };
  const audit = vi.fn<DiningAdmissionConsumptionAuditFactory>((descriptor) => ({
    auditId: id(70),
    brandId: id(7),
    storeId: id(4),
    actor: { type: "System" },
    actionCode: "DINING_IDENTITY_ADMISSION_CONSUME",
    targetType: "DiningIdentityAdmission",
    targetId: descriptor.admissionReference,
    reasonCode: "AUTHORIZED_DINING_ADMISSION_CONSUMPTION",
    correlationId: id(71),
    occurredAt: descriptor.occurredAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  }));
  return {
    store: createPostgresDiningAdmissionConsumptionStore(runner, scope, credentials, audit),
    state,
    raw,
    record,
    command: { snapshot: state, record },
    query,
    runs,
    audit,
    setRow: (value: unknown) => {
      row = value;
    },
    setOriginal: (value: unknown) => {
      original = value;
    },
  };
}
describe("Dining admission consumption owner store", () => {
  it("reads coherent scoped facts using Session assignment, not Table aggregate version", async () => {
    const x = fixture();
    const result = await x.store.readCurrent({
      admissionReference: parseDiningReference(id(1)),
      observedAt: now as typeof x.state.table.observedAt,
    });
    expect(result).toEqual(x.state);
    expect(result?.table.assignmentVersion).toBe(7);
    expect(x.raw.table.aggregateVersion).toBe(8);
    const call = x.query.mock.calls.find(([sql]) => sql.startsWith("SELECT s.session_snapshot"));
    expect(call?.[1]).toEqual([id(13), id(7), id(4), id(1)]);
    expect(call?.[0]).toContain("j.guest_session_id");
    expect(Object.isFrozen(result?.join)).toBe(true);
  });
  it("returns null for no current record", async () => {
    const x = fixture();
    x.setRow(null);
    expect(
      await x.store.readCurrent({
        admissionReference: parseDiningReference(id(1)),
        observedAt: x.state.table.observedAt,
      }),
    ).toBeNull();
  });
  it("reads only a matching scoped original receipt", async () => {
    const x = fixture();
    x.setOriginal(x.record);
    expect(await x.store.resolveOperation(parseDiningReference(id(11)))).toEqual(x.record);
    expect(x.query.mock.calls.at(-1)?.[1]).toEqual([id(13), id(7), id(4), id(11)]);
  });
  it.each(["operationReference", "guestSessionReference"])(
    "rejects altered original %s",
    async (key) => {
      const x = fixture();
      x.setOriginal({ ...x.record, [key]: id(99) });
      await expect(x.store.resolveOperation(parseDiningReference(id(11)))).rejects.toMatchObject(
        dependency,
      );
    },
  );
  it("revalidates an original writer retry under all shared owner locks", async () => {
    const x = fixture();
    x.setRow({ ...x.raw, admission: x.record.admission });
    x.setOriginal(x.record);
    expect(await x.store.consume(x.command)).toEqual({
      status: "AlreadyApplied",
      record: x.record,
    });
    const locks = x.query.mock.calls.filter(
      ([sql]) => sql.includes("pg_advisory") || sql.includes("FOR UPDATE"),
    );
    expect(locks.map(([, values]) => values.at(-1))).toEqual([
      `DiningAdmissionConsume:${id(13)}:${id(7)}:${id(4)}:${id(11)}`,
      `DiningTable:${id(13)}:${id(7)}:${id(4)}:${id(5)}`,
      id(5),
      id(2),
      id(3),
      id(1),
    ]);
    expect(x.audit).not.toHaveBeenCalled();
    expect(
      x.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("INSERT")),
    ).toBe(false);
  });
  it("fences a changed Session before a writer retry can return history", async () => {
    const x = fixture();
    x.setOriginal(x.record);
    x.setRow({
      ...x.raw,
      session: { ...x.state.session, version: 3, phase: "Closing" },
      admission: x.record.admission,
    });
    await expect(x.store.consume(x.command)).rejects.toMatchObject({
      code: "DINING_SESSION_VERSION_CONFLICT",
    });
    expect(x.audit).not.toHaveBeenCalled();
  });
  it("fences an admission already consumed by another operation", async () => {
    const x = fixture();
    x.setRow({ ...x.raw, admission: x.record.admission });
    await expect(x.store.consume(x.command)).rejects.toMatchObject({
      code: "DINING_SESSION_VERSION_CONFLICT",
    });
    expect(x.audit).not.toHaveBeenCalled();
  });
  it.each([
    { guestSessionReference: id(99) },
    { operationIntentHash: "b".repeat(64) },
    { extra: true },
  ])("rejects invalid write intent %# before transaction", async (change) => {
    const x = fixture();
    await expect(
      x.store.consume({ ...x.command, record: { ...x.record, ...change } } as never),
    ).rejects.toMatchObject(dependency);
    expect(x.runs).not.toHaveBeenCalled();
  });
  it.each([
    ["actor", { type: "User", reference: id(9) }],
    ["actionCode", "DINING_SESSION_JOIN"],
    ["targetId", id(99)],
    ["targetType", "DiningSession"],
    ["sourceChannel", "API"],
    ["dataClassification", "Internal"],
    ["reasonCode", "OTHER"],
    ["storeId", id(99)],
    ["brandId", id(99)],
    ["beforeSummary", {}],
    ["occurredAt", joined],
  ])("rejects invalid Audit %s before mutations", async (key, value) => {
    const x = fixture();
    const factory = x.audit.getMockImplementation();
    if (factory === undefined) throw new Error("missing audit factory");
    x.audit.mockImplementationOnce(
      (descriptor) => ({ ...factory(descriptor), [String(key)]: value }) as never,
    );
    await expect(x.store.consume(x.command)).rejects.toMatchObject(dependency);
    expect(
      x.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("INSERT")),
    ).toBe(false);
  });
  it("denies malformed rows without evaluating an accessor", async () => {
    const x = fixture();
    const get = vi.fn(() => []);
    x.query.mockImplementationOnce(async () => ({ rows: [] }));
    x.query.mockImplementationOnce(async () =>
      Object.defineProperty({}, "rows", { get, enumerable: true }),
    );
    await expect(
      x.store.readCurrent({
        admissionReference: parseDiningReference(id(1)),
        observedAt: x.state.table.observedAt,
      }),
    ).rejects.toMatchObject(dependency);
    expect(get).not.toHaveBeenCalled();
  });
  it("rejects a mismatched physical Tenant snapshot", async () => {
    const x = fixture();
    x.setRow({ ...x.raw, table: { ...x.raw.table, tenantReference: id(99) } });
    await expect(
      x.store.readCurrent({
        admissionReference: parseDiningReference(id(1)),
        observedAt: x.state.table.observedAt,
      }),
    ).rejects.toMatchObject(dependency);
  });
  it("does not serve facts observed after the requested time", async () => {
    const x = fixture();
    x.setRow({ ...x.raw, table: { ...x.raw.table, observedAt: "2026-07-29T12:03:00.000Z" } });
    expect(
      await x.store.readCurrent({
        admissionReference: parseDiningReference(id(1)),
        observedAt: x.state.table.observedAt,
      }),
    ).toBeNull();
  });
});
