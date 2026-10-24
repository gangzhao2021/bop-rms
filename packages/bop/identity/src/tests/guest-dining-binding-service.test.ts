import { describe, expect, it, vi } from "vitest";
import { createGuestDiningBindingService } from "../application/guest-dining-binding-service.js";
import type {
  GuestDiningBindingServiceOptions,
  GuestDiningBindingStorePort,
} from "../application/ports/guest-dining-binding-ports.js";
import {
  acknowledgeGuestDiningBinding,
  activateGuestDiningBinding,
  completeGuestDiningBinding,
  type GuestDiningBindingPreparation,
} from "../contracts/guest-dining-binding-preparation.js";
import {
  assertGuestSessionUsable,
  createGuestSessionRecord,
  type GuestSessionRecord,
} from "../contracts/guest-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
import { createGuestSessionCredentialProvider } from "../infrastructure/crypto/guest-session-credential-provider.js";
import { createGuestDiningBindingCredentialProvider } from "../infrastructure/crypto/guest-dining-binding-credential-provider.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number) =>
  parseCanonicalInstant(new Date(Date.parse("2026-09-08T12:00:00.000Z") + n * 1000).toISOString());
function fixture() {
  let seconds = 0;
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const recovery = createGuestDiningBindingCredentialProvider(new Uint8Array(32).fill(7));
  const sessionCredential = credentials.generateCredential("Session");
  const csrfCredential = credentials.generateCredential("Csrf");
  const predecessor = createGuestSessionRecord({
    session: {
      sessionReference: id(1),
      status: "Active",
      version: 1,
      brandReference: id(2),
      storeReference: id(3),
      publicStoreReference: id(4),
      publicTableReference: id(40),
      channel: "DineIn",
      locale: "en-CA",
      qrReference: id(5),
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
    operationReference: id(6),
    operationIntentHash: credentials.hashOperationIntent("synthetic predecessor"),
  });
  const records = new Map<string, GuestSessionRecord>([
    [predecessor.sessionSelectorHash, predecessor],
  ]);
  let preparation: GuestDiningBindingPreparation | null = null;
  const requirePreparation = () => {
    if (preparation === null) throw new Error("synthetic missing preparation");
    return preparation;
  };
  const requireRecord = (key: string) => {
    const value = records.get(key);
    if (!value) throw new Error("synthetic denied");
    return value;
  };
  const bindings: GuestDiningBindingStorePort = {
    async prepare(value) {
      preparation = value;
      return value;
    },
    async acknowledge(input) {
      preparation = acknowledgeGuestDiningBinding(
        {
          preparation: requirePreparation(),
          current: requireRecord(input.currentSelectorHash),
          proof: input.proof,
          observedAt: input.observedAt,
        },
        credentials.equals,
      );
      return preparation;
    },
    async activate(input) {
      const plan = activateGuestDiningBinding(
        {
          preparation: requirePreparation(),
          current: requireRecord(input.currentSelectorHash),
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
    },
    async complete(input) {
      return completeGuestDiningBinding(
        {
          preparation: requirePreparation(),
          current: requireRecord(input.sessionSelectorHash),
          sessionSelectorHash: input.sessionSelectorHash,
          csrfSelectorHash: input.csrfSelectorHash,
          observedAt: input.observedAt,
        },
        credentials.equals,
      );
    },
  };
  const options: GuestDiningBindingServiceOptions = {
    credentials,
    recovery,
    bindings,
    preparationLifetimeSeconds: 300,
    now: () => at(seconds),
    sessions: { resolve: vi.fn(async (key) => records.get(key) ?? null) },
    authorization: {
      authorize: vi.fn(async (input) => {
        const sessionHash = credentials.hashCredential("Session", input.sessionCredential as never);
        const csrfHash = credentials.hashCredential("Csrf", input.csrfCredential as never);
        const record = requireRecord(sessionHash);
        if (!credentials.equals(csrfHash, record.csrfSelectorHash))
          throw new Error("synthetic denied");
        return assertGuestSessionUsable(record.session, input.observedAt);
      }),
    },
    owner: {
      reserveAdmission: vi.fn(async (input) => ({
        operationReference: input.operationReference,
        admissionReference: input.admissionReference,
        guestSessionReference: input.session.sessionReference,
        brandReference: id(2),
        storeReference: id(3),
        publicTableReference: id(40),
        diningSessionReference: id(20),
        diningParticipantReference: id(21),
        expectedGuestVersion: input.session.version,
        evaluatedAt: at(seconds),
        validUntil: at(300),
      })),
      consume: vi.fn(async (input) => ({
        decision: "Allowed" as const,
        operationReference: input.operationReference,
        admissionReference: input.admissionReference,
        guestSessionReference: input.guestSessionReference,
        storeReference: predecessor.session.storeReference,
        publicTableReference: predecessor.session.publicTableReference as NonNullable<
          typeof predecessor.session.publicTableReference
        >,
        diningSessionReference: id(20) as never,
        diningParticipantReference: id(21) as never,
        evaluatedAt: at(seconds),
        validUntil: at(300),
      })),
    },
  };
  const service = createGuestDiningBindingService(options);
  const input = {
    sessionCredential,
    csrfCredential,
    operationReference: id(8),
    admissionReference: id(9),
  };
  const activateInput = (prepared: Awaited<ReturnType<typeof service.prepare>>) => ({
    sessionCredential,
    csrfCredential,
    operationReference: input.operationReference,
    candidateSessionCredential: prepared.sessionCredential,
    candidateCsrfCredential: prepared.csrfCredential,
    recoveryProof: prepared.recoveryProof,
  });
  return {
    options,
    service,
    input,
    activateInput,
    records,
    predecessor,
    getPreparation: requirePreparation,
    setTime: (n: number) => {
      seconds = n;
    },
  };
}

describe("WP-2296 credential handoff service", () => {
  it("authorizes, persists only hashes and sends no credentials to owner ports", async () => {
    const f = fixture();
    const result = await f.service.prepare(f.input);
    expect(result.status).toBe("Prepared");
    expect(f.records.size).toBe(1);
    const stored = JSON.stringify(f.getPreparation());
    for (const secret of [result.sessionCredential, result.csrfCredential, result.recoveryProof])
      expect(stored.includes(secret)).toBe(false);
    f.setTime(1);
    const activated = await f.service.activate(f.activateInput(result));
    expect(activated.status).toBe("Activated");
    const argumentsText = JSON.stringify([
      vi.mocked(f.options.owner.consume).mock.calls,
      vi.mocked(f.options.owner.reserveAdmission).mock.calls,
    ]);
    for (const secret of [
      result.sessionCredential,
      result.csrfCredential,
      result.recoveryProof,
      f.getPreparation().recoverySelectorHash,
    ])
      expect(argumentsText.includes(secret)).toBe(false);
    expect(f.records.get(f.predecessor.sessionSelectorHash)?.session.status).toBe("Revoked");
    expect(f.getPreparation().candidate.session.sessionReference).not.toBe(
      f.predecessor.session.sessionReference,
    );
  });

  it("denies current authorization before reservation or credential generation", async () => {
    const f = fixture();
    vi.mocked(f.options.authorization.authorize).mockRejectedValue(new Error("synthetic denied"));
    await expect(f.service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.reserveAdmission).not.toHaveBeenCalled();
    expect(f.options.sessions.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "brandReference",
    "storeReference",
    "guestSessionReference",
    "operationReference",
    "admissionReference",
    "publicTableReference",
  ] as const)("denies wrong reservation %s", async (key) => {
    const f = fixture();
    // Replace the owner port with a finite synthetic wrong-scope response.
    vi.mocked(f.options.owner.reserveAdmission).mockResolvedValue({
      operationReference: id(8),
      admissionReference: id(9),
      guestSessionReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      publicTableReference: id(40),
      diningSessionReference: id(20),
      diningParticipantReference: id(21),
      expectedGuestVersion: 1,
      evaluatedAt: at(0),
      validUntil: at(300),
      [key]: id(99),
    });
    const prepare = vi.spyOn(f.options.bindings, "prepare");
    await expect(f.service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("denies a substituted loaded Session before reserving a target", async () => {
    const f = fixture();
    vi.mocked(f.options.sessions.resolve).mockResolvedValue(
      createGuestSessionRecord({
        ...f.predecessor,
        session: { ...f.predecessor.session, storeReference: id(99) },
      }),
    );
    await expect(f.service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.reserveAdmission).not.toHaveBeenCalled();
  });

  it("continues after lost Identity activation acknowledgement without reusing the revoked predecessor", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    const activate = f.options.bindings.activate;
    vi.spyOn(f.options.bindings, "activate").mockImplementationOnce(async (input) => {
      await activate(input);
      throw new Error("synthetic acknowledgement lost");
    });
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    const candidate = f.getPreparation().candidate.session.sessionReference;
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    for (const n of [2, 301, 302]) {
      f.setTime(n);
      const result = await f.service.complete({
        operationReference: f.input.operationReference,
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      });
      expect(result.status).toBe("Activated");
      expect(f.getPreparation().candidate.session.sessionReference).toBe(candidate);
    }
    expect(f.options.owner.consume).toHaveBeenCalledTimes(1);
    expect(f.records.size).toBe(2);
  });

  it("retries owner preparation failure before Identity activation", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    vi.mocked(f.options.owner.consume).mockRejectedValueOnce(
      new Error("synthetic owner unavailable"),
    );
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.getPreparation().status).toBe("Acknowledged");
    expect(f.records.size).toBe(1);
    f.setTime(2);
    expect((await f.service.activate(f.activateInput(prepared))).status).toBe("Activated");
  });

  it("rejects wrong candidate proof before preparing the owner", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    await expect(
      f.service.activate({ ...f.activateInput(prepared), recoveryProof: f.input.csrfCredential }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(f.options.owner.consume).not.toHaveBeenCalled();
  });

  it("rejects malformed client scope and timestamp fields without effects", async () => {
    const f = fixture();
    await expect(
      f.service.prepare({ ...f.input, storeReference: id(99), observedAt: at(1) }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(f.options.authorization.authorize).not.toHaveBeenCalled();
  });

  it("does not report an unknown owner result as success", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    vi.mocked(f.options.owner.consume).mockResolvedValue(null);
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.getPreparation().status).toBe("Acknowledged");
    expect(f.records.size).toBe(1);
  });
  it("rejects substituted preparation persistence before delivering credentials", async () => {
    const f = fixture();
    const prepare = f.options.bindings.prepare;
    vi.spyOn(f.options.bindings, "prepare").mockImplementation(async (value, time) => ({
      ...(await prepare(value, time)),
      admissionReference: id(99),
    }));
    await expect(f.service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.consume).not.toHaveBeenCalled();
  });
  it("rejects substituted activation result before completing", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const activate = f.options.bindings.activate;
    vi.spyOn(f.options.bindings, "activate").mockImplementation(async (value) => ({
      ...(await activate(value)),
      admissionReference: id(99),
    }));
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.getPreparation().candidate.session.diningState).toBe("DiningBound");
  });
  it("rejects substituted completion scope", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    await f.service.activate(f.activateInput(prepared));
    const complete = f.options.bindings.complete;
    vi.spyOn(f.options.bindings, "complete").mockImplementation(async (value) => ({
      ...(await complete(value)),
      storeReference: id(99) as never,
    }));

    await expect(
      f.service.complete({
        operationReference: f.input.operationReference,
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(f.getPreparation().candidate.session.diningState).toBe("DiningBound");
  });
  it.each([0, 901, 1.5])("rejects invalid server lifetime %s", (preparationLifetimeSeconds) => {
    const f = fixture();
    expect(() =>
      createGuestDiningBindingService({ ...f.options, preparationLifetimeSeconds }),
    ).toThrowError("guest session request is invalid");
  });
  it.each(["prepare", "activate", "complete"] as const)(
    "captures closed %s inputs without getters",
    async (method) => {
      const f = fixture();
      const prepared = await f.service.prepare(f.input);
      const input =
        method === "prepare"
          ? f.input
          : method === "activate"
            ? f.activateInput(prepared)
            : {
                operationReference: f.input.operationReference,
                sessionCredential: prepared.sessionCredential,
                csrfCredential: prepared.csrfCredential,
              };
      vi.mocked(f.options.authorization.authorize).mockClear();
      const getter = vi.fn(() => input.sessionCredential);
      await expect(f.service[method]({ ...input, unwantedScope: id(99) })).rejects.toMatchObject({
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      await expect(
        f.service[method](
          Object.defineProperty({ ...input }, "sessionCredential", {
            enumerable: true,
            get: getter,
          }),
        ),
      ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      expect(getter).not.toHaveBeenCalled();
      expect(f.options.authorization.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(["candidateSessionCredential", "candidateCsrfCredential", "recoveryProof"] as const)(
    "denies substituted %s before admission consumption",
    async (field) => {
      const f = fixture();
      const prepared = await f.service.prepare(f.input);
      await expect(
        f.service.activate({ ...f.activateInput(prepared), [field]: f.input.sessionCredential }),
      ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      expect(f.options.owner.consume).not.toHaveBeenCalled();
    },
  );

  it.each([
    "guestSessionReference",
    "admissionReference",
    "operationReference",
    "storeReference",
    "publicTableReference",
    "diningSessionReference",
    "diningParticipantReference",
  ] as const)("validates consumed owner %s before Identity write", async (field) => {
    const f = fixture();
    const consume = vi.mocked(f.options.owner.consume).getMockImplementation();
    if (!consume) throw new Error("missing synthetic consume");
    vi.mocked(f.options.owner.consume).mockImplementation(
      async (input) => ({ ...(await consume(input)), [field]: id(99) }) as never,
    );
    const prepared = await f.service.prepare(f.input);
    const activate = vi.spyOn(f.options.bindings, "activate");
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(activate).not.toHaveBeenCalled();
    expect(f.records.size).toBe(1);
  });

  it.each(["evaluatedAt", "validUntil"] as const)(
    "rejects invalid owner %s before Identity write",
    async (field) => {
      const f = fixture();
      const consume = vi.mocked(f.options.owner.consume).getMockImplementation();
      if (!consume) throw new Error("missing synthetic consume");
      vi.mocked(f.options.owner.consume).mockImplementation(
        async (input) =>
          ({ ...(await consume(input)), [field]: at(field === "evaluatedAt" ? 10 : 0) }) as never,
      );
      const prepared = await f.service.prepare(f.input);
      const activate = vi.spyOn(f.options.bindings, "activate");
      await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      expect(activate).not.toHaveBeenCalled();
    },
  );

  it("retains the same candidate after Identity rollback", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const candidate = f.getPreparation().candidate;
    vi.spyOn(f.options.bindings, "activate").mockRejectedValueOnce(new Error("synthetic rollback"));
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.records.size).toBe(1);
    expect(f.getPreparation().status).toBe("Acknowledged");
    f.setTime(2);
    expect((await f.service.activate(f.activateInput(prepared))).status).toBe("Activated");
    expect(f.getPreparation().candidate).toEqual(candidate);
  });

  it("does not consume when an acknowledgement response arrives after preparation expiry", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const acknowledge = f.options.bindings.acknowledge;
    vi.spyOn(f.options.bindings, "acknowledge").mockImplementation(async (input) => {
      const result = await acknowledge(input);
      f.setTime(300);
      return result;
    });
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.consume).not.toHaveBeenCalled();
  });

  it("captures candidate proof before asynchronous authorization", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const input = { ...f.activateInput(prepared), recoveryProof: f.input.sessionCredential };
    const authorize = vi.mocked(f.options.authorization.authorize).getMockImplementation();
    if (!authorize) throw new Error("missing synthetic authorization");
    vi.mocked(f.options.authorization.authorize).mockImplementation(async (request) => {
      input.recoveryProof = prepared.recoveryProof;
      return authorize(request);
    });
    await expect(f.service.activate(input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.consume).not.toHaveBeenCalled();
  });

  it("requires exact boolean credential comparisons", async () => {
    const f = fixture();
    const service = createGuestDiningBindingService({
      ...f.options,
      credentials: { ...f.options.credentials, equals: () => "true" as never },
    });
    await expect(service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.reserveAdmission).not.toHaveBeenCalled();
  });

  it("bounds preparation expiry by the read-only owner evidence", async () => {
    const f = fixture();
    const reserve = vi.mocked(f.options.owner.reserveAdmission).getMockImplementation();
    if (!reserve) throw new Error("missing synthetic reservation");
    vi.mocked(f.options.owner.reserveAdmission).mockImplementation(
      async (input) => ({ ...(await reserve(input)), validUntil: at(20) }) as never,
    );
    expect((await f.service.prepare(f.input)).expiresAt).toBe(at(20));
    expect(f.options.owner.consume).not.toHaveBeenCalled();
  });

  it("requires current Dining authorization for completion", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    await f.service.activate(f.activateInput(prepared));
    vi.mocked(f.options.authorization.authorize).mockRejectedValue(
      new Error("synthetic current Dining unavailable"),
    );
    const complete = vi.spyOn(f.options.bindings, "complete");
    await expect(
      f.service.complete({
        operationReference: f.input.operationReference,
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(complete).not.toHaveBeenCalled();
  });
});
