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

describe("WP-2292 closed transition commands", () => {
  const names = ["prepare", "acknowledge", "activate", "complete"] as const;
  const transition = (name: (typeof names)[number]) => {
    const f = fixture();
    const comparator = equals;
    if (name === "prepare") {
      return {
        command: {
          operationReference: f.preparation.operationReference,
          targetReference: f.preparation.targetReference,
          predecessor: f.predecessor,
          candidate: f.candidate,
          recoverySelectorHash: f.preparation.recoverySelectorHash,
          preparedAt: f.preparation.preparedAt,
          expiresAt: f.preparation.expiresAt,
        },
        run: (input: unknown) =>
          prepareGuestBinding(input as Parameters<typeof prepareGuestBinding>[0]),
      };
    }
    if (name === "acknowledge") {
      return {
        command: {
          preparation: f.preparation,
          current: f.predecessor,
          proof: f.proof,
          observedAt: at(1),
        },
        run: (input: unknown, compare = comparator) =>
          acknowledgeGuestBinding(input as Parameters<typeof acknowledgeGuestBinding>[0], compare),
      };
    }
    if (name === "activate") {
      return {
        command: {
          preparation: f.acknowledge(),
          current: f.predecessor,
          proof: f.proof,
          ownerEvidence: f.evidence,
          observedAt: at(3),
        },
        run: (input: unknown, compare = comparator) =>
          activateGuestBinding(input as Parameters<typeof activateGuestBinding>[0], compare),
      };
    }
    return {
      command: {
        preparation: f.activate().preparation,
        current: f.candidate,
        sessionSelectorHash: f.candidate.sessionSelectorHash,
        csrfSelectorHash: f.candidate.csrfSelectorHash,
        observedAt: at(4),
      },
      run: (input: unknown, compare = comparator) =>
        completeGuestBinding(input as Parameters<typeof completeGuestBinding>[0], compare),
    };
  };
  for (const name of names) {
    it(`${name} accepts its declared immutable command`, () => {
      const t = transition(name);
      const before = JSON.stringify(t.command);
      expect(Object.isFrozen(t.run(Object.freeze(t.command)))).toBe(true);
      expect(JSON.stringify(t.command)).toBe(before);
    });
    for (const shape of [
      "extra",
      "missing",
      "symbol",
      "hidden",
      "accessor",
      "prototype",
      "array",
      "null",
    ] as const) {
      it(`${name} rejects ${shape} outer input without executing accessors`, () => {
        const t = transition(name);
        let input: unknown = { ...t.command };
        const key = Object.keys(t.command)[0];
        if (key === undefined) throw new Error("empty synthetic command");
        let reads = 0;
        if (shape === "extra") Object.assign(input as object, { unauthorized: true });
        if (shape === "missing") Reflect.deleteProperty(input as object, key);
        if (shape === "symbol") Object.assign(input as object, { [Symbol("extra")]: true });
        if (shape === "hidden") Object.defineProperty(input, "hidden", { value: true });
        if (shape === "accessor")
          Object.defineProperty(input, key, {
            enumerable: true,
            get: () => {
              reads++;
              return Reflect.get(t.command, key);
            },
          });
        if (shape === "prototype") Object.setPrototypeOf(input, { marker: true });
        if (shape === "array") input = [];
        if (shape === "null") input = null;
        let failure: unknown;
        try {
          t.run(input);
        } catch (error) {
          failure = error;
        }
        expect(reads).toBe(0);
        expect(failure).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      });
    }
  }
  it.each(["revision", "status", "acknowledgedAt", "activatedAt"])(
    "prepare rejects caller lifecycle field %s",
    (field) => {
      const t = transition("prepare");
      expect(() => t.run({ ...t.command, [field]: null })).toThrowError(
        "guest session is unavailable",
      );
    },
  );
  for (const name of ["acknowledge", "activate", "complete"] as const) {
    for (const value of [false, "true", 1, {}, undefined, null]) {
      it(`${name} requires exact true comparison for ${String(value)}`, () => {
        const t = transition(name);
        expect(() => t.run(t.command, () => value as boolean)).toThrowError(
          "guest session is unavailable",
        );
      });
    }
    it(`${name} requires every individual possession comparison`, () => {
      const count = name === "complete" ? 2 : 3;
      for (let failed = 0; failed < count; failed++) {
        const t = transition(name);
        let calls = 0;
        expect(() =>
          t.run(t.command, () => (calls++ === failed ? ("true" as unknown as boolean) : true)),
        ).toThrowError("guest session is unavailable");
        expect(calls).toBe(count);
      }
    });
    it(`${name} replaces thrown comparison failures with a bounded error`, () => {
      const t = transition(name);
      const injected = new Error("synthetic-private-provider-detail");
      let failure: unknown;
      try {
        t.run(t.command, () => {
          throw injected;
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).not.toBe(injected);
      expect(failure).toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
      expect(String(failure)).not.toContain(injected.message);
    });
  }
});
