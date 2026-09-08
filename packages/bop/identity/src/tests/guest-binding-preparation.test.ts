import { describe, expect, it } from "vitest";
import {
  acknowledgeGuestBinding,
  activateGuestBinding,
  completeGuestBinding,
  parseGuestBindingPreparation,
  prepareGuestBinding,
  type GuestBindingOwnerEvidence,
} from "../contracts/guest-binding-preparation.js";
import { createGuestSessionRecord, parseGuestSelectorHash } from "../contracts/guest-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hash = (n: number) => parseGuestSelectorHash(n.toString(16).repeat(64));
const at = (seconds: number) =>
  parseCanonicalInstant(
    new Date(Date.parse("2026-09-08T12:00:00.000Z") + seconds * 1000).toISOString(),
  );
const equals = (a: string, b: string) => a === b;
function fixture() {
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
    sessionSelectorHash: hash(1),
    csrfSelectorHash: hash(2),
    operationReference: id(6),
    operationIntentHash: hash(6),
  });
  const candidate = createGuestSessionRecord({
    ...predecessor,
    session: {
      ...predecessor.session,
      sessionReference: id(7),
      createdAt: at(0),
      lastSeenAt: at(0),
      idleExpiresAt: at(14400),
      absoluteExpiresAt: at(86400),
      rotatedFromGuestSessionReference: id(1),
    },
    sessionSelectorHash: hash(3),
    csrfSelectorHash: hash(4),
    operationReference: id(8),
    operationIntentHash: hash(7),
  });
  const preparation = prepareGuestBinding({
    operationReference: id(8),
    targetReference: id(9),
    predecessor,
    candidate,
    recoverySelectorHash: hash(5),
    preparedAt: at(0),
    expiresAt: at(300),
  });
  const proof = {
    sessionSelectorHash: hash(3),
    csrfSelectorHash: hash(4),
    recoverySelectorHash: hash(5),
  };
  const acknowledge = (value = preparation) =>
    acknowledgeGuestBinding(
      { preparation: value, current: predecessor, proof, observedAt: at(1) },
      equals,
    );
  const evidence: GuestBindingOwnerEvidence = {
    operationReference: id(8),
    targetReference: id(9),
    sessionReference: id(7),
    brandReference: id(2),
    storeReference: id(3),
    bindingVersion: 1,
    preparedAt: at(2),
    validUntil: at(300),
  };
  const activate = (value = acknowledge(), ownerEvidence = evidence) =>
    activateGuestBinding(
      {
        preparation: value,
        current: predecessor,
        proof,
        ownerEvidence,
        observedAt: at(3),
      },
      equals,
    );
  return { preparation, predecessor, candidate, proof, evidence, acknowledge, activate };
}

describe("WP-2234 Guest binding preparation", () => {
  it("prepares without granting authority and activates the exact candidate only after acknowledgement", () => {
    const f = fixture();
    const acknowledged = f.acknowledge();
    const plan = f.activate(acknowledged);
    expect(f.preparation.status).toBe("Prepared");
    expect(f.predecessor.session.status).toBe("Active");
    expect(Object.isFrozen(f.preparation.candidate.session)).toBe(true);
    expect(acknowledged).toMatchObject({
      status: "Acknowledged",
      revision: 2,
      acknowledgedAt: at(1),
    });
    expect(plan).toMatchObject({
      expectedPreparationRevision: 2,
      expectedPredecessorVersion: 1,
      preparation: { status: "Activated", revision: 3, activatedAt: at(3) },
      revoked: {
        session: {
          status: "Revoked",
          version: 2,
          revocationReason: "BindingChanged",
          revokedAt: at(3),
        },
      },
    });
    expect(plan.candidate).toEqual(f.candidate);
  });

  it("recovers repeated response loss using the active candidate without rotating the creator", () => {
    const f = fixture();
    const plan = f.activate();
    for (const seconds of [4, 301, 500]) {
      const receipt = completeGuestBinding(
        {
          preparation: plan.preparation,
          current: plan.candidate,
          sessionSelectorHash: f.proof.sessionSelectorHash,
          csrfSelectorHash: f.proof.csrfSelectorHash,
          observedAt: at(seconds),
        },
        equals,
      );
      expect(receipt).toEqual({
        operationReference: id(8),
        targetReference: id(9),
        sessionReference: id(7),
        brandReference: id(2),
        storeReference: id(3),
        activatedAt: at(3),
      });
      expect(receipt).not.toHaveProperty("recoverySelectorHash");
    }
    expect(() => f.activate(plan.preparation)).toThrowError("guest session is unavailable");
  });

  it("acknowledgement retries preserve their original time and revision", () => {
    const f = fixture();
    const first = f.acknowledge();
    const retry = acknowledgeGuestBinding(
      { preparation: first, current: f.predecessor, proof: f.proof, observedAt: at(20) },
      equals,
    );
    expect(retry).toEqual(first);
  });

  it.each(["sessionSelectorHash", "csrfSelectorHash", "recoverySelectorHash"] as const)(
    "denies wrong %s",
    (key) => {
      const f = fixture();
      expect(() =>
        acknowledgeGuestBinding(
          {
            preparation: f.preparation,
            current: f.predecessor,
            proof: { ...f.proof, [key]: hash(9) },
            observedAt: at(1),
          },
          equals,
        ),
      ).toThrowError("guest session is unavailable");
    },
  );

  it.each([-1, 300, 301])(
    "denies observation outside preparation validity at %s seconds",
    (seconds) => {
      const f = fixture();
      expect(() =>
        acknowledgeGuestBinding(
          {
            preparation: f.preparation,
            current: f.predecessor,
            proof: f.proof,
            observedAt: at(seconds),
          },
          equals,
        ),
      ).toThrowError("guest session is unavailable");
    },
  );

  it.each(["revoked", "version", "scope"])("denies changed predecessor %s", (kind) => {
    const f = fixture();
    const session = {
      ...f.predecessor.session,
      ...(kind === "revoked"
        ? { status: "Revoked", revocationReason: "Logout", revokedAt: at(1) }
        : kind === "version"
          ? { version: 2 }
          : { storeReference: id(99) }),
    };
    const current = createGuestSessionRecord({ ...f.predecessor, session });
    expect(() =>
      acknowledgeGuestBinding(
        { preparation: f.preparation, current, proof: f.proof, observedAt: at(2) },
        equals,
      ),
    ).toThrowError("guest session is unavailable");
  });

  it("denies activation before browser acknowledgement", () => {
    const f = fixture();
    expect(() => f.activate(f.preparation)).toThrowError("guest session is unavailable");
  });

  it.each([
    "operationReference",
    "targetReference",
    "sessionReference",
    "brandReference",
    "storeReference",
  ] as const)("denies substituted owner evidence %s", (key) => {
    const f = fixture();
    expect(() => f.activate(f.acknowledge(), { ...f.evidence, [key]: id(99) })).toThrowError(
      "guest session is unavailable",
    );
  });

  it.each([
    { bindingVersion: 2 },
    { preparedAt: at(0) },
    { preparedAt: at(4) },
    { validUntil: at(3) },
  ])("denies stale or premature owner evidence %j", (changes) => {
    const f = fixture();
    expect(() => f.activate(f.acknowledge(), { ...f.evidence, ...changes })).toThrowError(
      "guest session is unavailable",
    );
  });

  it.each(["predecessor", "expired", "wrong-csrf", "unactivated"])(
    "denies completion with %s",
    (kind) => {
      const f = fixture();
      const plan = f.activate();
      expect(() =>
        completeGuestBinding(
          {
            preparation: kind === "unactivated" ? f.preparation : plan.preparation,
            current: kind === "predecessor" ? plan.revoked : plan.candidate,
            sessionSelectorHash: f.proof.sessionSelectorHash,
            csrfSelectorHash: kind === "wrong-csrf" ? hash(9) : f.proof.csrfSelectorHash,
            observedAt: kind === "expired" ? at(14400) : at(4),
          },
          equals,
        ),
      ).toThrowError("guest session is unavailable");
    },
  );

  it.each([
    { revision: 2 },
    { expiresAt: at(901) },
    { expiresAt: at(0) },
    { acknowledgedAt: at(1) },
    { activatedAt: at(1) },
    { recoverySelectorHash: hash(3) },
    { rawCredential: "forbidden" },
  ])("rejects inconsistent or credential-bearing persisted shape %j", (changes) => {
    const f = fixture();
    expect(() => parseGuestBindingPreparation({ ...f.preparation, ...changes })).toThrowError(
      "guest session is unavailable",
    );
  });

  it("rejects cross-scope candidate and never invokes stored accessors", () => {
    const f = fixture();
    expect(() =>
      parseGuestBindingPreparation({
        ...f.preparation,
        candidate: { ...f.candidate, session: { ...f.candidate.session, storeReference: id(99) } },
      }),
    ).toThrowError("guest session is unavailable");
    let reads = 0;
    const hostile = { ...f.preparation };
    Object.defineProperty(hostile, "candidate", {
      get() {
        reads++;
        return f.candidate;
      },
    });
    expect(() => parseGuestBindingPreparation(hostile)).toThrowError(
      "guest session is unavailable",
    );
    expect(reads).toBe(0);
  });

  it("does not accept a recovery hash as a Session credential", () => {
    const f = fixture();
    const plan = f.activate();
    expect(() =>
      completeGuestBinding(
        {
          preparation: plan.preparation,
          current: plan.candidate,
          sessionSelectorHash: f.proof.recoverySelectorHash,
          csrfSelectorHash: f.proof.csrfSelectorHash,
          observedAt: at(4),
        },
        equals,
      ),
    ).toThrowError("guest session is unavailable");
  });
});
