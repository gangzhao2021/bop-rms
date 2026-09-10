import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseDiningJoinCapability } from "@bop/public-capability";
import {
  createDiningAdmissionConsumptionService,
  DiningSessionError,
  parseDiningHash,
  parseDiningIdentityAdmission,
  parseDiningParticipant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
  type DiningAdmissionConsumptionPorts,
  type DiningAdmissionConsumptionRecord,
} from "../index.js";

const id = (n: number) => `018f2000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const start = "2026-07-29T12:00:00.000Z";
const joined = "2026-07-29T12:01:00.000Z";
const now = "2026-07-29T12:02:00.000Z";
const later = "2026-07-29T12:03:00.000Z";
const hash = (value: string) => parseDiningHash(createHash("sha256").update(value).digest("hex"));
function changed(value: unknown, path: string, replacement: unknown): never {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const fields = path.split(".");
  let target = copy;
  for (const key of fields.slice(0, -1)) target = target[key] as Record<string, unknown>;
  const last = fields.at(-1);
  if (last === undefined) throw new Error("missing fixture field");
  target[last] = replacement;
  return copy as never;
}
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
  const history = new Map<string, DiningAdmissionConsumptionRecord>();
  const guest = vi.fn<DiningAdmissionConsumptionPorts["guests"]["resolve"]>(async (command) => ({
    guestSessionReference: command.guestSessionReference,
    diningState: "ContextOnly",
    channel: "DineIn",
    storeReference: parseDiningReference(id(4)),
    tableReference: parseDiningReference(id(5)),
    observedAt: command.observedAt,
  }));
  const read = vi.fn<DiningAdmissionConsumptionPorts["store"]["readCurrent"]>(async () => state);
  const original = vi.fn<DiningAdmissionConsumptionPorts["store"]["resolveOperation"]>(
    async (operation) => history.get(operation) ?? null,
  );
  const write = vi.fn<DiningAdmissionConsumptionPorts["store"]["consume"]>(async ({ record }) => {
    const prior = history.get(record.operationReference);
    if (prior !== undefined) return { status: "AlreadyApplied", record: prior };
    history.set(record.operationReference, record);
    state.admission = record.admission;
    return { status: "Applied", record };
  });
  const digest = vi.fn(hash);
  const ports: DiningAdmissionConsumptionPorts = {
    scope: { brandReference: id(7), storeReference: id(4) },
    guests: { resolve: guest },
    credentials: { hashOperationIntent: digest, equals: (a, b) => a === b },
    store: { readCurrent: read, resolveOperation: original, consume: write },
  };
  const input = {
    guestSessionReference: id(9),
    admissionReference: id(1),
    operationReference: id(11),
    requestedAt: now,
  };
  return {
    service: createDiningAdmissionConsumptionService(ports),
    ports,
    input,
    state,
    history,
    guest,
    read,
    original,
    write,
    digest,
  };
}
const unavailable = { code: "DINING_SESSION_UNAVAILABLE" };
const dependency = { code: "DINING_SESSION_DEPENDENCY_UNAVAILABLE" };
const conflict = { code: "DINING_SESSION_IDEMPOTENCY_CONFLICT" };

describe("current-authorized Dining admission consumption", () => {
  it("consumes with complete frozen owner facts and preserves original Join identity", async () => {
    const x = fixture();
    const result = await x.service.consume(x.input);
    expect(result.status).toBe("Consumed");
    expect(result.record).toMatchObject({
      operationReference: id(11),
      guestSessionReference: id(9),
      admission: {
        status: "Consumed",
        version: 2,
        consumedAt: now,
        operationReference: id(6),
        operationIntentHash: x.state.join.operationIntentHash,
      },
    });
    expect(result.record.operationIntentHash).toBe(
      hash(`ConsumeDiningAdmission:${id(9)}:${id(1)}`),
    );
    const command = x.write.mock.calls[0]?.[0];
    expect(command?.snapshot.join).toEqual(x.state.join);
    expect(command?.snapshot.admission.status).toBe("Active");
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command?.snapshot.join)).toBe(true);
    expect(Object.isFrozen(result.record.admission)).toBe(true);
    expect(x.guest.mock.invocationCallOrder[0]).toBeLessThan(
      x.read.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(x.read.mock.invocationCallOrder[0]).toBeLessThan(
      x.original.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
  it("recovers the original consumption time at a later current observation", async () => {
    const x = fixture();
    const first = await x.service.consume(x.input);
    x.state.table = { ...x.state.table, observedAt: later as typeof x.state.table.observedAt };
    const retry = await x.service.consume({ ...x.input, requestedAt: later });
    expect(retry).toEqual({ status: "AlreadyApplied", record: first.record });
    expect(x.write).toHaveBeenCalledTimes(1);
    expect(x.guest).toHaveBeenCalledTimes(2);
    expect(retry.record.admission.consumedAt).toBe(now);
  });
  it("denies a consumed admission under another operation", async () => {
    const x = fixture();
    await x.service.consume(x.input);
    await expect(
      x.service.consume({ ...x.input, operationReference: id(12) }),
    ).rejects.toMatchObject(unavailable);
    expect(x.write).toHaveBeenCalledTimes(1);
  });
  it("converges on one original operation when callers race", async () => {
    const x = fixture();
    const results = await Promise.all([x.service.consume(x.input), x.service.consume(x.input)]);
    expect(results.map((r) => r.status).sort()).toEqual(["AlreadyApplied", "Consumed"]);
    expect(results[0]?.record).toEqual(results[1]?.record);
    expect(x.history.size).toBe(1);
  });
  it("recovers a lost acknowledgement without another consume", async () => {
    const x = fixture();
    const apply = x.write.getMockImplementation();
    if (apply === undefined) throw new Error("missing writer");
    x.write.mockImplementationOnce(async (command) => {
      await apply(command);
      throw new Error("private lost acknowledgement");
    });
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    expect((await x.service.consume(x.input)).status).toBe("AlreadyApplied");
    expect(x.write).toHaveBeenCalledTimes(1);
  });
  it("requires current Guest authority again before original recovery", async () => {
    const x = fixture();
    await x.service.consume(x.input);
    x.guest.mockResolvedValue(null);
    x.read.mockClear();
    x.original.mockClear();
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.read).not.toHaveBeenCalled();
    expect(x.original).not.toHaveBeenCalled();
  });
  it.each(["Closing", "Closed", "Cancelled"] as const)(
    "denies original recovery during %s",
    async (phase) => {
      const x = fixture();
      await x.service.consume(x.input);
      x.state.session = { ...x.state.session, version: 3, phase };
      x.original.mockClear();
      await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
      expect(x.original).not.toHaveBeenCalled();
      expect(x.write).toHaveBeenCalledTimes(1);
    },
  );
  it("allows later unrelated joins while retaining the original participant and consumption", async () => {
    const x = fixture();
    const first = await x.service.consume(x.input);
    x.state.session = { ...x.state.session, version: 3 };
    expect(await x.service.consume(x.input)).toEqual({
      status: "AlreadyApplied",
      record: first.record,
    });
  });
  it.each([
    ["guestSessionReference", id(99)],
    ["diningState", "DiningBound"],
    ["channel", "Pickup"],
    ["storeReference", id(99)],
    ["tableReference", null],
    ["observedAt", start],
  ])("denies current Guest %s before owner reads", async (field, value) => {
    const x = fixture();
    const resolve = x.guest.getMockImplementation();
    if (resolve === undefined) throw new Error("missing guest resolver");
    x.guest.mockImplementationOnce(async (command) =>
      changed(await resolve(command), String(field), value),
    );
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.read).not.toHaveBeenCalled();
    expect(x.original).not.toHaveBeenCalled();
    expect(x.digest).not.toHaveBeenCalled();
  });
  it("denies a different current Guest even when that Guest has valid table context", async () => {
    const x = fixture();
    await expect(
      x.service.consume({ ...x.input, guestSessionReference: id(99) }),
    ).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
    expect(x.write).not.toHaveBeenCalled();
  });
  it("denies a wrong current Table", async () => {
    const x = fixture();
    x.state.session = {
      ...x.state.session,
      tableReference: parseDiningReference(id(99)),
      version: 3,
    };
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
  });
  it.each([
    ["admission.admissionReference", id(99)],
    ["admission.operationIntentHash", "b".repeat(64)],
    ["participant.joinedAt", start],
    ["session.startedByActorReference", id(99)],
    ["session.startedAt", joined],
    ["join.operationIntentHash", "b".repeat(64)],
    ["join.admission.status", "Consumed"],
    ["join.capability.selectorHash", "bad"],
    ["join.capability.diningSessionReference", id(99)],
    ["join.capability.issuedAt", "2026-07-29T11:59:00.000Z"],
    ["join.capability.version", 3],
    ["join.session.version", 3],
    ["admission.version", 2],
    ["join.participant.extra", "private"],
  ])("rejects inconsistent owner snapshot %s", async (path, value) => {
    const x = fixture();
    x.read.mockResolvedValue(changed(x.state, String(path), value));
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    expect(x.original).not.toHaveBeenCalled();
    expect(x.write).not.toHaveBeenCalled();
  });
  it("recomputes the immutable original Guest/Join digest", async () => {
    const x = fixture();
    const bad = structuredClone(x.state);
    bad.join.operationIntentHash = parseDiningHash("b".repeat(64));
    Object.assign(bad.join.admission, { operationIntentHash: bad.join.operationIntentHash });
    Object.assign(bad.admission, { operationIntentHash: bad.join.operationIntentHash });
    x.read.mockResolvedValue(bad);
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    expect(x.original).not.toHaveBeenCalled();
  });
  it.each([
    ["table.tableState", "Unavailable"],
    ["table.assignmentVersion", 8],
    ["table.activeDiningSessionReference", null],
    ["table.storeReference", id(99)],
    ["table.brandReference", id(99)],
    ["table.observedAt", joined],
  ])("denies ineligible current %s before history", async (path, value) => {
    const x = fixture();
    x.read.mockResolvedValue(changed(x.state, String(path), value));
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
  });
  it.each([
    ["operationReference", id(99)],
    ["guestSessionReference", id(99)],
    ["admission.admissionReference", id(99)],
    ["operationIntentHash", "b".repeat(64)],
  ])("conflicts on altered original receipt %s", async (path, value) => {
    const x = fixture();
    const first = await x.service.consume(x.input);
    x.original.mockResolvedValue(changed(first.record, String(path), value));
    await expect(x.service.consume(x.input)).rejects.toMatchObject(conflict);
    expect(x.write).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["admission.tableReference", id(99)],
    ["admission.consumedAt", later],
    ["admission.consumedAt", joined],
    ["admission.status", "Active"],
    ["admission.version", 3],
    ["credential", "synthetic-forbidden"],
  ])("rejects malformed or inconsistent original receipt %s", async (path, value) => {
    const x = fixture();
    const first = await x.service.consume(x.input);
    x.original.mockResolvedValue(changed(first.record, String(path), value));
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
  });
  it.each(["Applied", "AlreadyApplied"] as const)(
    "validates the actual %s writer receipt",
    async (status) => {
      const x = fixture();
      x.write.mockImplementationOnce(async ({ record }) => ({
        status,
        record: changed(record, "admission.tableReference", id(99)),
      }));
      await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    },
  );
  it("retains an earlier original writer receipt when another caller already applied", async () => {
    const x = fixture();
    x.state.table = { ...x.state.table, observedAt: later as typeof x.state.table.observedAt };
    x.write.mockImplementationOnce(async ({ record }) => ({
      status: "AlreadyApplied",
      record: changed(record, "admission.consumedAt", now),
    }));
    const result = await x.service.consume({ ...x.input, requestedAt: later });
    expect(result.status).toBe("AlreadyApplied");
    expect(result.record.admission.consumedAt).toBe(now);
  });
  it("rejects an Applied receipt that changes the committed consumption time", async () => {
    const x = fixture();
    x.write.mockImplementationOnce(async ({ record }) => ({
      status: "Applied",
      record: changed(record, "admission.consumedAt", joined),
    }));
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
  });
  it.each(["read", "original", "write"] as const)(
    "bounds synchronous dependency failures from %s",
    async (key) => {
      const x = fixture();
      x[key].mockImplementationOnce(() => {
        throw new Error("private dependency detail");
      });
      await expect(x.service.consume(x.input)).rejects.toMatchObject({
        ...dependency,
        message: "dining session is unavailable",
      });
    },
  );
  it.each(["DINING_SESSION_VERSION_CONFLICT", "DINING_SESSION_IDEMPOTENCY_CONFLICT"] as const)(
    "preserves a fresh owned writer %s",
    async (code) => {
      const x = fixture();
      const error = new DiningSessionError(code);
      error.message = "private detail";
      x.write.mockRejectedValue(error);
      await expect(x.service.consume(x.input)).rejects.toMatchObject({
        code,
        message: "dining session is unavailable",
      });
    },
  );
  it.each([null, [], { extra: true }])("rejects malformed root input %#", async (input) => {
    const x = fixture();
    await expect(x.service.consume(input)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    expect(x.guest).not.toHaveBeenCalled();
  });
  it.each(["guestSessionReference", "admissionReference", "operationReference", "requestedAt"])(
    "rejects missing %s",
    async (key) => {
      const x = fixture();
      const input: Record<string, unknown> = { ...x.input };
      Reflect.deleteProperty(input, key);
      await expect(x.service.consume(input)).rejects.toMatchObject({
        code: "DINING_SESSION_INPUT_INVALID",
      });
    },
  );
  it("rejects input and dependency accessors without invocation", async () => {
    const x = fixture();
    const get = vi.fn(() => "private");
    const input = { ...x.input };
    Object.defineProperty(input, "admissionReference", { get, enumerable: true });
    await expect(x.service.consume(input)).rejects.toMatchObject({
      code: "DINING_SESSION_INPUT_INVALID",
    });
    const state = structuredClone(x.state);
    Object.defineProperty(state.admission, "admissionReference", { get, enumerable: true });
    x.read.mockResolvedValue(state);
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    expect(get).not.toHaveBeenCalled();
  });
  it("owns dependency records before invoking injected hash callbacks", async () => {
    const x = fixture();
    const state = structuredClone(x.state);
    x.read.mockResolvedValue(state);
    x.digest.mockImplementationOnce((text) => {
      Object.assign(state.admission, { tableReference: parseDiningReference(id(99)) });
      return hash(text);
    });
    expect((await x.service.consume(x.input)).status).toBe("Consumed");
    expect(x.write.mock.calls[0]?.[0].snapshot.admission.tableReference).toBe(id(5));
  });
});

describe("admission service fail-closed boundaries", () => {
  it("does not reveal an absent admission through history", async () => {
    const x = fixture();
    x.read.mockResolvedValue(null);
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
    expect(x.write).not.toHaveBeenCalled();
  });
  it.each(["sync", "async"])("bounds %s current Guest resolver failure", async (mode) => {
    const x = fixture();
    if (mode === "sync")
      x.guest.mockImplementationOnce(() => {
        throw new Error("private guest detail");
      });
    else x.guest.mockRejectedValueOnce(new Error("private guest detail"));
    await expect(x.service.consume(x.input)).rejects.toMatchObject({
      ...unavailable,
      message: "dining session is unavailable",
    });
    expect(x.read).not.toHaveBeenCalled();
  });
  it.each(["brandReference", "storeReference"])(
    "binds service %s independently of returned data",
    async (key) => {
      const x = fixture();
      const service = createDiningAdmissionConsumptionService({
        ...x.ports,
        scope: { ...x.ports.scope, [key]: id(99) },
      });
      await expect(service.consume(x.input)).rejects.toMatchObject(
        key === "storeReference" ? unavailable : dependency,
      );
      expect(x.original).not.toHaveBeenCalled();
      expect(x.write).not.toHaveBeenCalled();
    },
  );
  it.each([null, {}, { brandReference: "bad", storeReference: id(4) }])(
    "rejects malformed constructor scope %#",
    (scope) => {
      const x = fixture();
      expect(() =>
        createDiningAdmissionConsumptionService({ ...x.ports, scope: scope as never }),
      ).toThrow(DiningSessionError);
    },
  );
  it.each([
    null,
    {},
    { status: "Done", record: {} },
    { status: "Applied", record: {}, extra: true },
  ])("rejects a malformed writer acknowledgement %#", async (receipt) => {
    const x = fixture();
    x.write.mockResolvedValueOnce(receipt as never);
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
  });
  it("denies an admission after both Guest and Session move to another table", async () => {
    const x = fixture();
    const resolve = x.guest.getMockImplementation();
    if (resolve === undefined) throw new Error("missing Guest resolver");
    x.guest.mockImplementationOnce(async (command) =>
      changed(await resolve(command), "tableReference", id(99)),
    );
    x.state.session = {
      ...x.state.session,
      version: 3,
      tableReference: parseDiningReference(id(99)),
      tableAssignmentVersion: 2,
    };
    x.state.table = {
      ...x.state.table,
      tableReference: parseDiningReference(id(99)),
      assignmentVersion: 2,
    };
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
  });
  it("denies a participant who leaves before recovery", async () => {
    const x = fixture();
    await x.service.consume(x.input);
    x.state.participant = {
      ...x.state.participant,
      status: "Left",
      version: 2,
      leftAt: now as typeof x.state.participant.joinedAt,
    };
    x.original.mockClear();
    await expect(x.service.consume(x.input)).rejects.toMatchObject(unavailable);
    expect(x.original).not.toHaveBeenCalled();
  });
  it("bounds malformed and throwing digest providers", async () => {
    const x = fixture();
    x.digest.mockReturnValueOnce("bad" as never);
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    x.digest.mockImplementationOnce(() => {
      throw new Error("private hash detail");
    });
    await expect(x.service.consume(x.input)).rejects.toMatchObject(dependency);
    expect(x.original).not.toHaveBeenCalled();
  });
});
