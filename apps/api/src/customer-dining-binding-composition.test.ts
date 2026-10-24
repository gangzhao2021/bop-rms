import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeGuestDiningBinding,
  activateGuestDiningBinding,
  completeGuestDiningBinding,
  createGuestSessionRecord,
  createGuestSessionCredentialProvider,
  createGuestDiningBindingCredentialProvider,
  parseCanonicalInstant,
  type GuestSessionRecord,
  type GuestDiningBindingPreparation,
  type GuestDiningBindingStorePort,
} from "@bop/identity";
import { parseQrTableContextEvidence, type DiningAdmissionSnapshot } from "@rms/dining";
import {
  createCustomerDiningBindingComposition,
  createCustomerDiningSessionBinding,
  type CustomerDiningBindingCompositionOptions,
} from "./customer-dining-binding-composition.js";
const id = (n: number) => `01902298-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number) =>
  parseCanonicalInstant(new Date(Date.parse("2026-09-09T12:00:00.000Z") + n * 1000).toISOString());
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = { code: "GUEST_SESSION_UNAVAILABLE" };
function fixture(offset = 0) {
  let seconds = 0;
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const sessionCredential = credentials.generateCredential("Session");
  const csrfCredential = credentials.generateCredential("Csrf");
  const prior = createGuestSessionRecord({
    session: {
      sessionReference: id(offset + 1),
      status: "Active",
      version: 1,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(4),
      publicTableReference: id(offset + 40),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(offset + 5),
      qrRevocationVersion: 1,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: at(-60),
      lastSeenAt: at(-60),
      idleExpiresAt: at(14340),
      absoluteExpiresAt: at(86340),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: null,
      revocationReason: null,
      revokedAt: null,
    },
    sessionSelectorHash: credentials.hashCredential("Session", sessionCredential),
    csrfSelectorHash: credentials.hashCredential("Csrf", csrfCredential),
    operationReference: id(offset + 6),
    operationIntentHash: credentials.hashOperationIntent("synthetic entry"),
  });
  const records = new Map<string, GuestSessionRecord>([[prior.sessionSelectorHash, prior]]);
  let preparation: GuestDiningBindingPreparation | null = null;
  const saved = () => {
    if (!preparation) throw new Error("missing synthetic preparation");
    return preparation;
  };
  const record = (hash: string) => {
    const result = records.get(hash);
    if (!result) throw new Error("missing synthetic Session");
    return result;
  };
  const bindings: GuestDiningBindingStorePort = {
    prepare: vi.fn(async (value) => {
      preparation = value;
      return value;
    }),
    acknowledge: vi.fn(async (input) => {
      preparation = acknowledgeGuestDiningBinding(
        {
          preparation: saved(),
          current: record(input.currentSelectorHash),
          proof: input.proof,
          observedAt: input.observedAt,
        },
        credentials.equals,
      );
      return preparation;
    }),
    activate: vi.fn(async (input) => {
      const plan = activateGuestDiningBinding(
        {
          preparation: saved(),
          current: record(input.currentSelectorHash),
          proof: input.proof,
          ownerEvidence: input.ownerEvidence,
          observedAt: input.observedAt,
        },
        credentials.equals,
      );
      records.set(plan.revoked.sessionSelectorHash, plan.revoked);
      records.set(plan.candidate.sessionSelectorHash, plan.candidate);
      preparation = plan.preparation;
      return preparation;
    }),
    complete: vi.fn(async (input) =>
      completeGuestDiningBinding(
        {
          preparation: saved(),
          current: record(input.sessionSelectorHash),
          sessionSelectorHash: input.sessionSelectorHash,
          csrfSelectorHash: input.csrfSelectorHash,
          observedAt: input.observedAt,
        },
        credentials.equals,
      ),
    ),
  };
  const session = {
    diningSessionReference: id(offset + 20),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(offset + 50),
    tableAssignmentVersion: 7,
    phase: "Active",
    version: 2,
    startedByActorReference: id(60),
    startedAt: at(-60),
    hostParticipantReference: id(offset + 21),
  };
  const participant = {
    participantReference: id(offset + 21),
    diningSessionReference: id(offset + 20),
    status: "Active",
    version: 1,
    joinedAt: at(-30),
    leftAt: null,
  };
  const intent = digest(`Join:${id(offset + 1)}:${id(offset + 70)}`);
  const admission = {
    admissionReference: id(offset + 9),
    diningSessionReference: id(offset + 20),
    participantReference: id(offset + 21),
    storeReference: id(3),
    tableReference: id(offset + 50),
    tableAssignmentVersion: 7,
    operationReference: id(offset + 71),
    operationIntentHash: intent,
    status: "Active",
    version: 1,
    issuedAt: at(-30),
    consumedAt: null,
  };
  const state = {
    session,
    participant,
    admission,
    table: {
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(offset + 50),
      assignmentVersion: 7,
      tableState: "Eligible",
      activeDiningSessionReference: id(offset + 20),
      observedAt: at(0),
    },
    joinedGuestSessionReference: id(offset + 1),
    join: {
      session,
      participant,
      admission,
      operationReference: id(offset + 71),
      operationIntentHash: intent,
      capability: {
        capabilityReference: id(offset + 70),
        purpose: "DiningJoin",
        kind: "Invitation",
        storeReference: id(3),
        tableReference: id(offset + 50),
        diningSessionReference: id(offset + 20),
        selectorHash: "a".repeat(64),
        pepperVersion: 1,
        assignmentVersion: 7,
        generation: 1,
        status: "Consumed",
        version: 2,
        issuedAt: at(-60),
        expiresAt: at(600),
        consumedAt: at(-30),
        revokedAt: null,
      },
    },
  } as unknown as DiningAdmissionSnapshot;
  const histories = new Map<string, unknown>();
  const context = parseQrTableContextEvidence({
    publicStoreReference: id(4),
    publicTableReference: id(offset + 40),
    brandReference: id(2),
    storeReference: id(3),
    tableReference: id(offset + 50),
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    tableLifecycle: "Active",
    assignmentState: "Active",
    channel: "DineIn",
    qrState: "Enabled",
    revocationVersion: 1,
    contextEvidenceReference: id(offset + 80),
    validUntil: at(600),
  });
  const options: CustomerDiningBindingCompositionOptions = {
    scope: { brandReference: id(2), storeReference: id(3) },
    bindings,
    session: {
      credentials,
      binding: { validate: vi.fn(async () => "Current" as const) },
      store: {
        create: async ({ record }) => record,
        resolve: vi.fn(async (key) => records.get(key) ?? null),
        touchInteractive: async () => null,
        revoke: async () => null,
        resolveOperation: async () => null,
        rotate: async () => {
          throw new Error("unexpected direct rotation");
        },
      },
    },
    dining: {
      binding: {
        readCurrent: vi.fn(async () => ({
          session: state.session,
          participant: state.participant,
          table: state.table,
          admission: state.admission,
        })),
      },
      credentials: {
        hashOperationIntent: (value) => digest(value) as never,
        equals: (a, b) => a === b,
      },
      store: {
        readCurrent: vi.fn(async () => state),
        resolveOperation: vi.fn(async (operation) => (histories.get(operation) ?? null) as never),
        consume: vi.fn(async ({ record }) => {
          histories.set(record.operationReference, record);
          Object.assign(state, { admission: record.admission });
          return { status: "Applied" as const, record };
        }),
      },
    },
    contexts: { resolve: vi.fn(async () => context) },
    recovery: createGuestDiningBindingCredentialProvider(new Uint8Array(32).fill(9)),
    preparationLifetimeSeconds: 300,
    now: () => at(seconds),
  };
  const input = {
    operationReference: id(offset + 8),
    admissionReference: id(offset + 9),
    sessionCredential,
    csrfCredential,
  };
  const service = createCustomerDiningBindingComposition(options);
  const activation = (p: Awaited<ReturnType<typeof service.prepare>>) => ({
    operationReference: input.operationReference,
    sessionCredential,
    csrfCredential,
    candidateSessionCredential: p.sessionCredential,
    candidateCsrfCredential: p.csrfCredential,
    recoveryProof: p.recoveryProof,
  });
  const completion = (p: Awaited<ReturnType<typeof service.prepare>>) => ({
    operationReference: input.operationReference,
    sessionCredential: p.sessionCredential,
    csrfCredential: p.csrfCredential,
  });
  return {
    options,
    service,
    input,
    activation,
    completion,
    saved,
    records,
    histories,
    state,
    context,
    prior,
    setTime: (value: number) => {
      seconds = value;
      Object.assign(state.table, { observedAt: at(value) });
    },
  };
}

describe("WP-2298 explicit Dining binding composition", () => {
  it("constructs without resource access, reservation or credentials", () => {
    const f = fixture();
    expect(Object.isFrozen(f.service)).toBe(true);
    for (const mock of [
      f.options.session.store.resolve,
      f.options.contexts.resolve,
      f.options.dining.store.readCurrent,
      f.options.bindings.prepare,
    ])
      expect(mock).not.toHaveBeenCalled();
  });
  it("uses real owner services for prepare, consume, rotate and post-expiry completion", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    expect(f.histories.size).toBe(0);
    expect(f.records.size).toBe(1);
    expect(f.saved().candidate.session.diningSessionReference).toBe(id(20));
    expect(f.saved().candidate.session.publicTableReference).toBe(id(40));
    expect(f.state.session.tableReference).toBe(id(50));
    f.setTime(1);
    expect((await f.service.activate(f.activation(prepared))).status).toBe("Activated");
    f.setTime(301);
    expect((await f.service.complete(f.completion(prepared))).status).toBe("Activated");
    expect(f.histories.size).toBe(1);
    expect(f.records.get(f.prior.sessionSelectorHash)?.session.status).toBe("Revoked");
    const text = JSON.stringify([
      vi.mocked(f.options.contexts.resolve).mock.calls,
      vi.mocked(f.options.dining.store.consume).mock.calls,
      f.saved(),
    ]);
    for (const raw of [
      f.input.sessionCredential,
      f.input.csrfCredential,
      prepared.sessionCredential,
      prepared.csrfCredential,
      prepared.recoveryProof,
    ])
      expect(text).not.toContain(raw);
  });
  it.each(["prepare", "activate", "complete"] as const)(
    "rejects malformed %s before dependencies",
    async (method) => {
      const f = fixture();
      await expect(f.service[method]({})).rejects.toMatchObject(unavailable);
      expect(f.options.session.store.resolve).not.toHaveBeenCalled();
      expect(f.options.contexts.resolve).not.toHaveBeenCalled();
    },
  );
  it.each([0, 901, NaN])("rejects invalid finite lifetime %s", (preparationLifetimeSeconds) => {
    const f = fixture();
    expect(() =>
      createCustomerDiningBindingComposition({ ...f.options, preparationLifetimeSeconds }),
    ).toThrow();
  });
  it.each([
    ["brandReference", id(99)],
    ["storeReference", id(99)],
    ["publicStoreReference", id(99)],
    ["publicTableReference", id(99)],
    ["brandLifecycle", "Suspended"],
    ["storeLifecycle", "Suspended"],
    ["tableLifecycle", "Suspended"],
    ["assignmentState", "Inactive"],
    ["qrState", "Revoked"],
    ["revocationVersion", 2],
    ["validUntil", at(0)],
    ["tableReference", id(99)],
  ])(
    "denies invalid context %s before candidate persistence or consumption",
    async (field, value) => {
      const f = fixture();
      vi.mocked(f.options.contexts.resolve).mockResolvedValue({
        ...f.context,
        [field]: value,
      } as never);
      await expect(f.service.prepare(f.input)).rejects.toMatchObject(unavailable);
      expect(f.options.bindings.prepare).not.toHaveBeenCalled();
      expect(f.options.dining.store.consume).not.toHaveBeenCalled();
    },
  );
  it("bounds null/private context errors and rejects accessor evidence", async () => {
    const f = fixture();
    const getter = vi.fn(() => id(40));
    vi.mocked(f.options.contexts.resolve)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("synthetic private context"))
      .mockResolvedValueOnce(
        Object.defineProperty({ ...f.context }, "publicTableReference", {
          enumerable: true,
          get: getter,
        }),
      );
    for (let i = 0; i < 3; i++) {
      const error = await f.service.prepare(f.input).catch((e: unknown) => e);
      expect(error).toMatchObject(unavailable);
      expect(JSON.stringify(error)).not.toContain("private");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(f.options.dining.store.readCurrent).not.toHaveBeenCalled();
  });
  it("denies Session/CSRF and current binding failure before context or owner reads", async () => {
    const f = fixture();
    await expect(
      f.service.prepare({ ...f.input, csrfCredential: f.input.sessionCredential }),
    ).rejects.toMatchObject(unavailable);
    vi.mocked(f.options.session.binding.validate).mockResolvedValue("Unavailable");
    await expect(f.service.prepare(f.input)).rejects.toMatchObject(unavailable);
    expect(f.options.contexts.resolve).not.toHaveBeenCalled();
    expect(f.options.dining.store.readCurrent).not.toHaveBeenCalled();
  });
  it("reauthorizes the original Guest before owner access", async () => {
    const f = fixture();
    const resolve = vi.mocked(f.options.session.store.resolve).getMockImplementation();
    if (!resolve) throw new Error("missing resolver");
    let calls = 0;
    vi.mocked(f.options.session.store.resolve).mockImplementation(async (key) => {
      calls++;
      return calls >= 3 ? null : resolve(key);
    });
    await expect(f.service.prepare(f.input)).rejects.toMatchObject(unavailable);
    expect(f.options.contexts.resolve).not.toHaveBeenCalled();
    expect(f.options.dining.store.readCurrent).not.toHaveBeenCalled();
  });
  it.each(["owner", "identity", "lost-ack"] as const)(
    "recovers original candidate after %s failure",
    async (failure) => {
      const f = fixture();
      const prepared = await f.service.prepare(f.input);
      const candidate = f.saved().candidate;
      f.setTime(1);
      if (failure === "owner")
        vi.mocked(f.options.dining.store.consume).mockRejectedValueOnce(
          new Error("synthetic outage"),
        );
      else if (failure === "identity")
        vi.mocked(f.options.bindings.activate).mockRejectedValueOnce(
          new Error("synthetic rollback"),
        );
      else {
        const activate = vi.mocked(f.options.bindings.activate).getMockImplementation();
        if (!activate) throw new Error("missing activation");
        vi.mocked(f.options.bindings.activate).mockImplementationOnce(async (input) => {
          await activate(input);
          throw new Error("synthetic lost ack");
        });
      }
      await expect(f.service.activate(f.activation(prepared))).rejects.toMatchObject(unavailable);
      f.setTime(failure === "lost-ack" ? 301 : 2);
      const resumed = createCustomerDiningBindingComposition(f.options);
      const result =
        failure === "lost-ack"
          ? await resumed.complete(f.completion(prepared))
          : await resumed.activate(f.activation(prepared));
      expect(result.status).toBe("Activated");
      expect(f.saved().candidate).toEqual(candidate);
      expect(f.histories.size).toBe(1);
    },
  );
  it("does not install a candidate when context becomes invalid after owner commit", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const consume = vi.mocked(f.options.dining.store.consume).getMockImplementation();
    if (!consume) throw new Error("missing consume");
    vi.mocked(f.options.dining.store.consume).mockImplementationOnce(async (input) => {
      const result = await consume(input);
      vi.mocked(f.options.contexts.resolve).mockResolvedValue({ ...f.context, qrState: "Revoked" });
      return result;
    });
    await expect(f.service.activate(f.activation(prepared))).rejects.toMatchObject(unavailable);
    expect(f.records.size).toBe(1);
    expect(f.histories.size).toBe(1);
    expect(f.options.bindings.activate).not.toHaveBeenCalled();
  });
  it("keeps concurrent Guest credentials and mappings isolated", async () => {
    const first = fixture();
    const second = fixture(100);
    for (const [key, value] of second.records) first.records.set(key, value);
    vi.mocked(first.options.dining.store.readCurrent).mockImplementation(async (input) =>
      input.admissionReference === first.input.admissionReference ? first.state : second.state,
    );
    let arrived = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(first.options.contexts.resolve).mockImplementation(async (input) => {
      if (++arrived === 2) release();
      await barrier;
      return input.session.sessionReference === first.prior.session.sessionReference
        ? first.context
        : second.context;
    });
    const composition = createCustomerDiningBindingComposition(first.options);
    const outputs = await Promise.all([
      composition.prepare(first.input),
      composition.prepare(second.input),
    ]);
    expect(outputs.map((value) => value.operationReference)).toEqual([
      first.input.operationReference,
      second.input.operationReference,
    ]);
    const saved = vi.mocked(first.options.bindings.prepare).mock.calls.map(([record]) => record);
    expect(saved.map((value) => value.candidate.session.publicTableReference).sort()).toEqual(
      [id(40), id(140)].sort(),
    );
    for (const record of saved)
      expect(record.predecessor.session.publicTableReference).toBe(
        record.candidate.session.publicTableReference,
      );
  });
  it("keeps bound identity current during Closing without re-consuming admission", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    await f.service.activate(f.activation(prepared));
    Object.assign(f.state.session, { phase: "Closing", version: 3 });
    expect((await f.service.complete(f.completion(prepared))).status).toBe("Activated");
    expect(f.options.dining.store.consume).toHaveBeenCalledTimes(1);
    expect(f.options.dining.binding.readCurrent).toHaveBeenCalled();
  });
  it.each(["Closed", "Cancelled"])("denies bound identity for %s Dining Session", async (phase) => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    await f.service.activate(f.activation(prepared));
    Object.assign(f.state.session, { phase, version: 3 });
    vi.mocked(f.options.bindings.complete).mockClear();
    await expect(f.service.complete(f.completion(prepared))).rejects.toMatchObject(unavailable);
    expect(f.options.bindings.complete).not.toHaveBeenCalled();
  });
  it("does not revive original credentials after the Dining Table assignment changes back", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    await f.service.activate(f.activation(prepared));
    Object.assign(f.state.session, { tableAssignmentVersion: 9, version: 4 });
    Object.assign(f.state.table, { assignmentVersion: 9 });
    await expect(f.service.complete(f.completion(prepared))).rejects.toMatchObject(unavailable);
    expect(f.records.get(f.prior.sessionSelectorHash)?.session.status).toBe("Revoked");
    expect(f.histories.size).toBe(1);
  });
  it("requires current bound facts even when the base Session policy returns Current", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    await f.service.activate(f.activation(prepared));
    vi.mocked(f.options.dining.binding.readCurrent).mockResolvedValue(null);
    await expect(f.service.complete(f.completion(prepared))).rejects.toMatchObject(unavailable);
    expect(f.options.session.binding.validate).toHaveBeenCalled();
  });
});

describe("WP-2326 shared current Dining binding guard", () => {
  function guard(f: ReturnType<typeof fixture>) {
    return createCustomerDiningSessionBinding({
      scope: f.options.scope,
      binding: f.options.session.binding,
      repository: f.options.dining.binding,
      contexts: f.options.contexts,
      now: f.options.now,
    });
  }
  it("keeps ContextOnly policy without querying bound owner state", async () => {
    const f = fixture();
    expect(await guard(f).validate(f.prior.session, at(0))).toBe("Current");
    expect(f.options.contexts.resolve).not.toHaveBeenCalled();
    expect(f.options.dining.binding.readCurrent).not.toHaveBeenCalled();
  });
  it.each(["brandReference", "storeReference"] as const)(
    "rejects another %s before base policy",
    async (field) => {
      const f = fixture();
      expect(await guard(f).validate({ ...f.prior.session, [field]: id(999) }, at(0))).toBe(
        "Unavailable",
      );
      expect(f.options.session.binding.validate).not.toHaveBeenCalled();
      expect(f.options.contexts.resolve).not.toHaveBeenCalled();
    },
  );
  it("retains a base-policy denial before owner access", async () => {
    const f = fixture();
    vi.mocked(f.options.session.binding.validate).mockResolvedValue("Unavailable");
    expect(await guard(f).validate(f.prior.session, at(0))).toBe("Unavailable");
    expect(f.options.contexts.resolve).not.toHaveBeenCalled();
  });
  it.each(["current", "missing admission", "moved assignment", "expired after await"])(
    "checks original consumed admission for %s",
    async (scenario) => {
      const f = fixture();
      const prepared = await f.service.prepare(f.input);
      f.setTime(1);
      await f.service.activate(f.activation(prepared));
      if (scenario === "missing admission") {
        vi.mocked(f.options.dining.binding.readCurrent).mockResolvedValue(null);
      }
      if (scenario === "moved assignment") {
        Object.assign(f.state.session, { tableAssignmentVersion: 9, version: 4 });
        Object.assign(f.state.table, { assignmentVersion: 9 });
      }
      if (scenario === "expired after await") {
        vi.mocked(f.options.dining.binding.readCurrent).mockImplementation(async () => {
          f.setTime(600);
          return {
            session: f.state.session,
            participant: f.state.participant,
            table: f.state.table,
            admission: f.state.admission,
          };
        });
      }
      expect(await guard(f).validate(f.saved().candidate.session, at(1))).toBe(
        scenario === "current" ? "Current" : "Unavailable",
      );
      expect(f.options.dining.binding.readCurrent).toHaveBeenCalled();
      expect(f.options.dining.store.consume).toHaveBeenCalledTimes(1);
    },
  );
});
