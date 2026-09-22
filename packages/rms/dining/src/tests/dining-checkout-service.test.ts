import {
  createDiningCheckoutClockService,
  type DiningCheckoutClockOptions,
} from "../application/dining-checkout-clock-service.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  createDiningCheckoutService,
  type DiningCheckoutServiceOptions,
} from "../application/dining-checkout-service.js";
import {
  parseDiningSession,
  parseDiningParticipant,
  parseDiningIdentityAdmission,
  parseDiningTableStartEvidence,
} from "../domain/dining-session.js";
import {
  parseDiningCheckoutCommitment,
  type DiningCheckoutCommitment,
} from "../domain/dining-checkout-commitment.js";
const id = (n: number) => "01902402-0000-7000-8000-" + n.toString().padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
function fixture() {
  let instant = at,
    stored: DiningCheckoutCommitment | null = null,
    authorizations = 0,
    writes = 0;
  const input = {
    commitmentReference: id(10),
    guestSessionReference: id(9),
    diningSessionReference: id(4),
    participantReference: id(8),
    cartReference: id(11),
    cartVersion: 3,
    quoteReference: id(12),
    submissionReference: id(13),
    orderReference: id(14),
    orderBatchReference: id(15),
    paymentOperationReference: id(16),
    sourceValidUntil: "2026-09-10T12:05:00.000Z",
  };
  const session = parseDiningSession({
    diningSessionReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(6),
    tableAssignmentVersion: 7,
    phase: "Active",
    version: 5,
    startedByActorReference: id(20),
    startedAt: "2026-09-10T11:00:00.000Z",
    hostParticipantReference: id(8),
  });
  const participant = parseDiningParticipant({
    participantReference: id(8),
    diningSessionReference: id(4),
    status: "Active",
    version: 1,
    joinedAt: "2026-09-10T11:01:00.000Z",
    leftAt: null,
  });
  const admission = parseDiningIdentityAdmission({
    admissionReference: id(30),
    diningSessionReference: id(4),
    participantReference: id(8),
    storeReference: id(3),
    tableReference: id(6),
    tableAssignmentVersion: 7,
    operationReference: id(31),
    operationIntentHash: "a".repeat(64),
    status: "Consumed",
    version: 2,
    issuedAt: participant.joinedAt,
    consumedAt: "2026-09-10T11:01:01.000Z",
  });
  const options: DiningCheckoutServiceOptions = {
    scope: { brandReference: id(2), storeReference: id(3) },
    now: () => instant,
    hashIntent: (value) => createHash("sha256").update(value).digest("hex"),
    authorization: {
      authorize: async (request) => {
        authorizations++;
        return {
          guestSessionReference: id(9),
          brandReference: id(2),
          storeReference: id(3),
          diningSessionReference: id(4),
          participantReference: id(8),
          tableReference: id(6),
          identityVersion: 2,
          expiresAt: "2026-09-10T13:00:00.000Z",
          observedAt: request.observedAt,
        };
      },
    },
    current: {
      readCurrent: async (request) => ({
        session,
        participant,
        admission,
        table: parseDiningTableStartEvidence({
          brandReference: id(2),
          storeReference: id(3),
          tableReference: id(6),
          assignmentVersion: 7,
          tableState: "Eligible",
          activeDiningSessionReference: id(4),
          observedAt: request.observedAt,
        }),
      }),
    },
    repository: {
      load: async () => stored,
      append: async ({ record }) => {
        writes++;
        stored = record;
        return { status: "Created", record, version: 1 };
      },
    },
    audit: {
      create: async ({ record, observedAt }) => ({
        auditId: id(40),
        brandId: id(2),
        storeId: id(3),
        actor: { type: "System" },
        actionCode: "DINING_CHECKOUT_PREPARE",
        targetType: "DiningCheckoutCommitment",
        targetId: record.commitmentReference,
        reasonCode: "AUTHORIZED_DINING_CHECKOUT",
        correlationId: id(41),
        occurredAt: observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  };
  return {
    input,
    options,
    service: () => createDiningCheckoutService(options),
    setTime: (value: string) => {
      instant = value;
    },
    stored: () => stored,
    writes: () => writes,
    authorizations: () => authorizations,
  };
}
it("prepares against consumed admission and reauthorizes before and after persistence", async () => {
  const f = fixture(),
    result = await f.service().prepare(f.input);
  expect(result.status).toBe("Created");
  expect(result.record.state).toBe("Prepared");
  expect(result.record.sessionVersion).toBe(5);
  expect(result.record.participantVersion).toBe(1);
  expect(f.authorizations()).toBe(4);
  expect(f.writes()).toBe(1);
});
it("recovers original history without renewing its source deadline", async () => {
  const f = fixture(),
    first = await f.service().prepare(f.input);
  f.setTime("2026-09-10T12:06:00.000Z");
  const replay = await f.service().prepare(f.input);
  expect(replay).toEqual({ status: "Existing", record: first.record });
  expect(f.writes()).toBe(1);
});
it("refuses revoked identity on replay without disclosing the stored record", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  f.options.authorization.authorize = async () => null;
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.writes()).toBe(1);
});
it.each([
  "brandReference",
  "storeReference",
  "guestSessionReference",
  "diningSessionReference",
  "participantReference",
] as const)("rejects foreign authority %s before storage", async (key) => {
  const f = fixture(),
    authorize = f.options.authorization.authorize;
  f.options.authorization.authorize = async (request) => ({
    ...((await authorize(request)) as NonNullable<Awaited<ReturnType<typeof authorize>>>),
    [key]: id(99),
  });
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.writes()).toBe(0);
});
it("rejects an unconsumed admission", async () => {
  const f = fixture(),
    read = f.options.current.readCurrent;
  f.options.current.readCurrent = async (request) => {
    const snapshot = await read(request);
    if (snapshot === null) throw new Error("missing synthetic snapshot");
    return {
      ...snapshot,
      admission: { ...snapshot.admission, status: "Active", version: 1, consumedAt: null },
    };
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.writes()).toBe(0);
});
it("permits history recovery in Closing but denies a new commitment", async () => {
  const f = fixture(),
    first = await f.service().prepare(f.input),
    read = f.options.current.readCurrent;
  f.options.current.readCurrent = async (request) => {
    const snapshot = await read(request);
    if (snapshot === null) throw new Error("missing synthetic snapshot");
    return { ...snapshot, session: { ...snapshot.session, phase: "Closing", version: 6 } };
  };
  expect((await f.service().prepare(f.input)).record).toEqual(first.record);
  await expect(
    f.service().prepare({ ...f.input, commitmentReference: id(50) }),
  ).rejects.toMatchObject({ code: "DINING_CHECKOUT_INTENT_CONFLICT" });
  f.options.repository.load = async () => null;
  await expect(
    f.service().prepare({ ...f.input, commitmentReference: id(50) }),
  ).rejects.toMatchObject({ code: "DINING_CHECKOUT_PERMISSION_DENIED" });
});
it("does not renew or reuse a changed submission intent", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  for (const patch of [
    { quoteReference: id(51) },
    { cartVersion: 4 },
    { sourceValidUntil: "2026-09-10T12:10:00.000Z" },
    { paymentOperationReference: id(52) },
  ])
    await expect(f.service().prepare({ ...f.input, ...patch })).rejects.toMatchObject({
      code: "DINING_CHECKOUT_INTENT_CONFLICT",
    });
  expect(f.writes()).toBe(1);
});
it("reauthorizes after audit waits and denies revocation before writing", async () => {
  const f = fixture(),
    audit = f.options.audit.create;
  f.options.audit.create = async (request) => {
    f.options.authorization.authorize = async () => null;
    return audit(request);
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.writes()).toBe(0);
});
it("rejects source expiry across audit waits without writing", async () => {
  const f = fixture(),
    audit = f.options.audit.create;
  f.options.audit.create = async (request) => {
    f.setTime(f.input.sourceValidUntil);
    return audit(request);
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_SOURCE_EXPIRED",
  });
  expect(f.writes()).toBe(0);
});
it("preserves a committed record when identity becomes revoked before the response", async () => {
  const f = fixture(),
    append = f.options.repository.append;
  f.options.repository.append = async (request) => {
    const saved = await append(request);
    f.options.authorization.authorize = async () => null;
    return saved;
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.stored()?.state).toBe("Prepared");
  expect(f.writes()).toBe(1);
});
it("rejects an identity version change during an invocation", async () => {
  const f = fixture(),
    authorize = f.options.authorization.authorize;
  f.options.authorization.authorize = async (request) => {
    const result = await authorize(request);
    if (result === null) throw new Error("missing synthetic authority");
    return { ...result, identityVersion: f.authorizations() + 1 };
  };
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.writes()).toBe(0);
});
it("rejects a malformed storage receipt rather than returning it as durable history", async () => {
  const f = fixture(),
    append = f.options.repository.append;
  f.options.repository.append = async (request) => ({ ...(await append(request)), version: 2 });
  await expect(f.service().prepare(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
});
it("captures input before waiting and never invokes input accessors", async () => {
  const f = fixture();
  let reads = 0;
  const input = {
    ...f.input,
    get quoteReference() {
      reads++;
      return id(12);
    },
  };
  await expect(f.service().prepare(input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_REQUEST_INVALID",
  });
  expect(reads).toBe(0);
  expect(f.authorizations()).toBe(0);
});

it("returns current Prepared history for Ordering without renewing or duplicating it", async () => {
  const f = fixture();
  const first = await f.service().prepareForOrdering(f.input);
  f.setTime("2026-09-10T12:01:00.000Z");
  const next = await f.service().prepareForOrdering(f.input);
  expect(next).toEqual({ status: "Existing", record: first.record });
  expect(f.writes()).toBe(1);
});
it("retains expired history but refuses it for a new Ordering submission", async () => {
  const f = fixture();
  const first = await f.service().prepare(f.input);
  f.setTime(f.input.sourceValidUntil);
  await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect((await f.service().prepare(f.input)).record).toEqual(first.record);
  expect(f.writes()).toBe(1);
});
it.each(["Closing", "VersionChanged"] as const)(
  "refuses %s context for Ordering while retaining original history",
  async (change) => {
    const f = fixture();
    await f.service().prepare(f.input);
    const read = f.options.current.readCurrent;
    f.options.current.readCurrent = async (request) => {
      const snapshot = await read(request);
      if (snapshot === null) throw new Error("missing fixture");
      return {
        ...snapshot,
        session: {
          ...snapshot.session,
          version: 6,
          phase: change === "Closing" ? "Closing" : "Active",
        },
      };
    };
    await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
      code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.writes()).toBe(1);
  },
);
it("rechecks current owner context after the preparation write completes", async () => {
  const f = fixture();
  const append = f.options.repository.append;
  const read = f.options.current.readCurrent;
  f.options.repository.append = async (request) => {
    const saved = await append(request);
    f.options.current.readCurrent = async (query) => {
      const snapshot = await read(query);
      if (snapshot === null) throw new Error("missing fixture");
      return { ...snapshot, session: { ...snapshot.session, phase: "Closing", version: 6 } };
    };
    return saved;
  };
  await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.stored()?.state).toBe("Prepared");
  expect(f.writes()).toBe(1);
});
it("does not treat a sealed commitment as fresh Ordering preparation", async () => {
  const f = fixture();
  const first = await f.service().prepare(f.input);
  f.options.repository.load = async () => ({
    ...first.record,
    state: "PaymentPending",
    orderingLinkedAt: first.record.preparedAt,
    paymentRequestedAt: first.record.preparedAt,
    capacityExpiresAt: "2026-09-10T12:30:00.000Z" as never,
  });
  await expect(f.service().prepareForOrdering(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.writes()).toBe(1);
});

async function clockFixture() {
  const f = fixture();
  await f.service().prepare(f.input);
  const options: DiningCheckoutClockOptions = {
    ...f.options,
    authorization: {
      authorize: (request) =>
        f.options.authorization.authorize({
          ...request,
          action: "PrepareDiningCheckout",
        }),
    },
    repository: {
      load: f.options.repository.load,
      append: async (request) => {
        if (f.stored()?.paymentRequestedAt !== null) throw new Error("synthetic clock contention");
        const saved = await f.options.repository.append({ ...request, expectedVersion: 0 });
        return { ...saved, version: 2 };
      },
    },
    ordering: {
      resolve: async ({ record }) => ({
        commitmentReference: record.commitmentReference,
        brandReference: record.brandReference,
        storeReference: record.storeReference,
        submissionReference: record.submissionReference,
        orderReference: record.orderReference,
        orderBatchReference: record.orderBatchReference,
        cartReference: record.cartReference,
        cartVersion: record.cartVersion,
        quoteReference: record.quoteReference,
        paymentOperationReference: record.paymentOperationReference,
        guestSessionReference: record.guestSessionReference,
        intentHash: record.intentHash,
        acknowledgedAt: f.options.now(),
      }),
    },
    audit: {
      create: async (request) => ({
        ...(await f.options.audit.create(request)),
        actionCode: "DINING_CHECKOUT_SEAL",
      }),
    },
  };
  return { ...f, clockOptions: options, clock: () => createDiningCheckoutClockService(options) };
}
it("seals one original payment clock after acknowledged Ordering and recovers it after expiry", async () => {
  const f = await clockFixture();
  const first = await f.clock().seal(f.input);
  expect(first.record.paymentRequestedAt).toBe(at);
  expect(first.record.capacityExpiresAt).toBe("2026-09-10T12:30:00.000Z");
  f.setTime("2026-09-10T12:40:00.000Z");
  f.clockOptions.ordering.resolve = async () => {
    throw new Error("must not select a new clock");
  };
  expect(await f.clock().seal(f.input)).toEqual({ status: "Existing", record: first.record });
  expect(f.writes()).toBe(2);
});
it("does not seal without positive exact Ordering acknowledgement", async () => {
  const f = await clockFixture();
  f.clockOptions.ordering.resolve = async () => null;
  await expect(f.clock().seal(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.writes()).toBe(1);
});
it("rejects an acknowledgement for a different permanent payment operation", async () => {
  const f = await clockFixture(),
    resolve = f.clockOptions.ordering.resolve;
  f.clockOptions.ordering.resolve = async (request) => ({
    ...((await resolve(request)) as object),
    paymentOperationReference: id(999),
  });
  await expect(f.clock().seal(f.input)).rejects.toBeDefined();
  expect(f.writes()).toBe(1);
});
it("recovers the durable original seal when the write acknowledgement is lost", async () => {
  const f = await clockFixture(),
    append = f.clockOptions.repository.append;
  f.clockOptions.repository.append = async (request) => {
    await append(request);
    throw new Error("synthetic lost acknowledgement");
  };
  expect((await f.clock().seal(f.input)).status).toBe("Existing");
  expect(f.stored()?.capacityExpiresAt).toBe("2026-09-10T12:30:00.000Z");
  expect(f.writes()).toBe(2);
});
it("does not turn a failed absent seal into a completed payment clock", async () => {
  const f = await clockFixture();
  f.clockOptions.repository.append = async () => {
    throw new Error("synthetic rollback");
  };
  await expect(f.clock().seal(f.input)).rejects.toBeDefined();
  expect(f.stored()?.state).toBe("Prepared");
  expect(f.writes()).toBe(1);
});
it("rejects expiry across clock Audit waits without renewing the preparation", async () => {
  const f = await clockFixture(),
    audit = f.clockOptions.audit.create;
  f.clockOptions.audit.create = async (request) => {
    f.setTime(f.input.sourceValidUntil);
    return audit(request);
  };
  await expect(f.clock().seal(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_SOURCE_EXPIRED",
  });
  expect(f.writes()).toBe(1);
});
it("recovers the winning concurrent seal instead of overwriting it with an earlier candidate", async () => {
  const f = await clockFixture(),
    audit = f.clockOptions.audit.create;
  let release: () => void = () => {
      throw new Error("gate is not initialized");
    },
    started: () => void = () => {
      throw new Error("gate is not initialized");
    };
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  f.clockOptions.audit.create = async (request) => {
    if (++calls === 1) {
      started();
      await gate;
    }
    return audit(request);
  };
  const first = f.clock().seal(f.input);
  await waiting;
  f.setTime("2026-09-10T12:01:00.000Z");
  const winner = await f.clock().seal(f.input);
  release();
  expect((await first).record).toEqual(winner.record);
  expect(winner.record.paymentRequestedAt).toBe("2026-09-10T12:01:00.000Z");
  expect(f.writes()).toBe(2);
});
it("preserves a committed seal but refuses the response after authority revocation", async () => {
  const f = await clockFixture(),
    append = f.clockOptions.repository.append;
  f.clockOptions.repository.append = async (request) => {
    const saved = await append(request);
    f.options.authorization.authorize = async () => null;
    return saved;
  };
  await expect(f.clock().seal(f.input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_PERMISSION_DENIED",
  });
  expect(f.stored()?.state).toBe("PaymentPending");
});

async function paymentFixture() {
  const f = fixture(),
    prepared = (await f.service().prepare(f.input)).record;
  const sealed = parseDiningCheckoutCommitment({
    ...prepared,
    state: "PaymentPending",
    orderingLinkedAt: at,
    paymentRequestedAt: at,
    capacityExpiresAt: "2026-09-10T12:30:00.000Z",
  });
  f.options.repository.load = async () => sealed;
  return { ...f, sealed };
}
it("authorizes existing sealed payment against current owner context without renewing its clock", async () => {
  const f = await paymentFixture(),
    authorize = f.options.authorization.authorize;
  const actions: string[] = [];
  f.options.authorization.authorize = async (request) => {
    actions.push(request.action);
    return authorize(request);
  };
  f.setTime("2026-09-10T12:06:00.000Z");
  const result = await f.service().authorizePayment(f.input);
  expect(result.record).toEqual(f.sealed);
  expect(new Set(actions)).toEqual(new Set(["AuthorizeDiningCheckoutPayment"]));
  expect(f.writes()).toBe(1);
});
it("never creates missing preparation while checking payment authority", async () => {
  const f = fixture();
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect(f.writes()).toBe(0);
});
it("rejects unsealed preparation as current payment authority", async () => {
  const f = fixture();
  await f.service().prepare(f.input);
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect(f.writes()).toBe(1);
});
it("rejects an expired sealed clock while original history remains recoverable", async () => {
  const f = await paymentFixture();
  f.setTime("2026-09-10T12:30:00.000Z");
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect((await f.service().prepare(f.input)).record).toEqual(f.sealed);
  expect(f.writes()).toBe(1);
});
it("denies payment when Dining enters Closing", async () => {
  const f = await paymentFixture(),
    read = f.options.current.readCurrent;
  f.options.current.readCurrent = async (request) => {
    const value = await read(request);
    if (value === null) return value;
    return { ...value, session: { ...value.session, phase: "Closing", version: 6 } };
  };
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
  expect(f.writes()).toBe(1);
});
it("denies current payment after revocation during the owner read", async () => {
  const f = await paymentFixture(),
    read = f.options.current.readCurrent;
  f.options.current.readCurrent = async (request) => {
    const value = await read(request);
    f.options.authorization.authorize = async () => null;
    return value;
  };
  await expect(f.service().authorizePayment(f.input)).rejects.toThrow();
});
