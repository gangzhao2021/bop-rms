import { describe, expect, it, vi } from "vitest";
import { createGuestBindingService } from "../application/guest-binding-service.js";
import type {
  GuestBindingServiceOptions,
  GuestBindingStorePort,
} from "../application/ports/guest-binding-ports.js";
import {
  acknowledgeGuestBinding,
  activateGuestBinding,
  completeGuestBinding,
  type GuestBindingPreparation,
} from "../contracts/guest-binding-preparation.js";
import {
  assertGuestSessionUsable,
  createGuestSessionRecord,
  type GuestSessionRecord,
} from "../contracts/guest-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
import { createGuestSessionCredentialProvider } from "../infrastructure/crypto/guest-session-credential-provider.js";
import { createGuestBindingCredentialProvider } from "../infrastructure/crypto/guest-binding-credential-provider.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (n: number) =>
  parseCanonicalInstant(new Date(Date.parse("2026-09-08T12:00:00.000Z") + n * 1000).toISOString());
function fixture() {
  let seconds = 0;
  const credentials = createGuestSessionCredentialProvider(new Uint8Array(32).fill(7));
  const recovery = createGuestBindingCredentialProvider(new Uint8Array(32).fill(7));
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
      publicTableReference: null,
      channel: "Pickup",
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
  let preparation: GuestBindingPreparation | null = null;
  const requirePreparation = () => {
    if (preparation === null) throw new Error("synthetic missing preparation");
    return preparation;
  };
  const requireRecord = (key: string) => {
    const value = records.get(key);
    if (!value) throw new Error("synthetic denied");
    return value;
  };
  const bindings: GuestBindingStorePort = {
    async prepare(value) {
      preparation = value;
      return value;
    },
    async acknowledge(input) {
      preparation = acknowledgeGuestBinding(
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
      const plan = activateGuestBinding(
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
      return completeGuestBinding(
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
  const options: GuestBindingServiceOptions = {
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
      reserveTarget: vi.fn(async (input) => ({
        operationReference: input.operationReference,
        targetReference: id(9),
        sessionReference: input.session.sessionReference,
        brandReference: id(2),
        storeReference: id(3),
        expectedVersion: input.session.version,
        validUntil: at(300),
      })),
      prepare: vi.fn(async (input) => ({
        operationReference: input.operationReference,
        targetReference: input.targetReference,
        sessionReference: input.sessionReference,
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        bindingVersion: 1,
        preparedAt: at(seconds),
        validUntil: input.validUntil,
      })),
      activate: vi.fn(async () => "Activated" as const),
    },
  };
  const service = createGuestBindingService(options);
  const input = { sessionCredential, csrfCredential, operationReference: id(8) };
  const activateInput = (prepared: Awaited<ReturnType<typeof service.prepare>>) => ({
    ...input,
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

describe("WP-2236 credential handoff service", () => {
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
      vi.mocked(f.options.owner.prepare).mock.calls,
      vi.mocked(f.options.owner.activate).mock.calls,
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
    expect(f.options.owner.reserveTarget).not.toHaveBeenCalled();
    expect(f.options.sessions.resolve).not.toHaveBeenCalled();
  });

  it.each(["brandReference", "storeReference", "sessionReference", "operationReference"] as const)(
    "denies wrong reservation %s",
    async (key) => {
      const f = fixture();
      // Replace the owner port with a finite synthetic wrong-scope response.
      vi.mocked(f.options.owner.reserveTarget).mockResolvedValue({
        operationReference: id(8),
        targetReference: id(9),
        sessionReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        expectedVersion: 1,
        validUntil: at(300),
        [key]: id(99),
      });
      const prepare = vi.spyOn(f.options.bindings, "prepare");
      await expect(f.service.prepare(f.input)).rejects.toMatchObject({
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      expect(prepare).not.toHaveBeenCalled();
    },
  );

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
    expect(f.options.owner.reserveTarget).not.toHaveBeenCalled();
  });

  it("continues after owner activation failure without reusing the revoked predecessor", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    vi.mocked(f.options.owner.activate).mockRejectedValueOnce(
      new Error("synthetic owner unavailable"),
    );
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
    expect(f.options.owner.prepare).toHaveBeenCalledTimes(1);
    expect(f.records.size).toBe(2);
  });

  it("retries owner preparation failure before Identity activation", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    f.setTime(1);
    vi.mocked(f.options.owner.prepare).mockRejectedValueOnce(
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
    expect(f.options.owner.prepare).not.toHaveBeenCalled();
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
    vi.mocked(f.options.owner.activate).mockResolvedValue("Unknown" as never);
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.getPreparation().status).toBe("Activated");
  });
  it("rejects substituted preparation persistence before delivering credentials", async () => {
    const f = fixture();
    const prepare = f.options.bindings.prepare;
    vi.spyOn(f.options.bindings, "prepare").mockImplementation(async (value, time) => ({
      ...(await prepare(value, time)),
      targetReference: id(99),
    }));
    await expect(f.service.prepare(f.input)).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.prepare).not.toHaveBeenCalled();
  });
  it("rejects substituted activation result before activating the owner", async () => {
    const f = fixture();
    const prepared = await f.service.prepare(f.input);
    const activate = f.options.bindings.activate;
    vi.spyOn(f.options.bindings, "activate").mockImplementation(async (value) => ({
      ...(await activate(value)),
      targetReference: id(99),
    }));
    await expect(f.service.activate(f.activateInput(prepared))).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
    });
    expect(f.options.owner.activate).not.toHaveBeenCalled();
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
    vi.mocked(f.options.owner.activate).mockClear();
    await expect(
      f.service.complete({
        operationReference: f.input.operationReference,
        sessionCredential: prepared.sessionCredential,
        csrfCredential: prepared.csrfCredential,
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    expect(f.options.owner.activate).not.toHaveBeenCalled();
  });
  it.each([0, 901, 1.5])("rejects invalid server lifetime %s", (preparationLifetimeSeconds) => {
    const f = fixture();
    expect(() =>
      createGuestBindingService({ ...f.options, preparationLifetimeSeconds }),
    ).toThrowError("guest session request is invalid");
  });
});
