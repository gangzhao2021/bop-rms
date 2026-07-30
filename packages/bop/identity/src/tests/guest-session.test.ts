import { describe, expect, it } from "vitest";
import {
  assertGuestSessionUsable,
  createGuestSession,
  createGuestSessionRecord,
  guestSessionCookie,
  GuestSessionError,
  GuestSessionService,
  parseGuestAdmissionEvidence,
  type GuestAdmissionEvidence,
  type GuestOperationReference,
  type GuestRawCredential,
  type GuestSelectorHash,
  type GuestSessionCredentialPort,
  type GuestSessionRecord,
  type GuestSessionStorePort,
} from "../index.js";

const ids = {
  session: "00000000-0000-7000-8000-000000000001",
  nextSession: "00000000-0000-7000-8000-000000000002",
  operation: "00000000-0000-7000-8000-000000000003",
  nextOperation: "00000000-0000-7000-8000-000000000004",
  entry: "00000000-0000-7000-8000-000000000005",
  nextEntry: "00000000-0000-7000-8000-000000000006",
  evidence: "00000000-0000-7000-8000-000000000007",
  brand: "00000000-0000-7000-8000-000000000008",
  store: "00000000-0000-7000-8000-000000000009",
  publicStore: "00000000-0000-7000-8000-000000000010",
  publicTable: "00000000-0000-7000-8000-000000000011",
  qr: "00000000-0000-7000-8000-000000000012",
};
const now = "2026-07-29T12:00:00.000Z";
const sessionCredential = "A".repeat(43) as GuestRawCredential;
const csrfCredential = "B".repeat(43) as GuestRawCredential;
const nextSessionCredential = "C".repeat(43) as GuestRawCredential;
const nextCsrfCredential = "D".repeat(43) as GuestRawCredential;
const hash = (character: string) => character.repeat(64) as GuestSelectorHash;

const evidence = (overrides: Record<string, unknown> = {}) => ({
  decision: "Allowed",
  evidenceReference: ids.evidence,
  entryRequestReference: ids.entry,
  brandReference: ids.brand,
  storeReference: ids.store,
  publicStoreReference: ids.publicStore,
  publicTableReference: ids.publicTable,
  channel: "DineIn",
  locale: "en-CA",
  qrReference: ids.qr,
  qrRevocationVersion: 3,
  evaluatedAt: now,
  validUntil: "2026-07-29T12:05:00.000Z",
  ...overrides,
});

const session = (overrides: Record<string, unknown> = {}) => ({
  sessionReference: ids.session,
  status: "Active",
  version: 1,
  brandReference: ids.brand,
  storeReference: ids.store,
  publicStoreReference: ids.publicStore,
  publicTableReference: ids.publicTable,
  channel: "DineIn",
  locale: "en-CA",
  qrReference: ids.qr,
  qrRevocationVersion: 3,
  diningState: "ContextOnly",
  createdAt: now,
  lastSeenAt: now,
  idleExpiresAt: "2026-07-29T16:00:00.000Z",
  absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
  orderClosedAt: null,
  closureExpiresAt: null,
  rotatedFromGuestSessionReference: null,
  revocationReason: null,
  revokedAt: null,
  ...overrides,
});

class SyntheticCredentials implements GuestSessionCredentialPort {
  readonly purposes: string[] = [];
  readonly #credentials = [
    sessionCredential,
    csrfCredential,
    nextSessionCredential,
    nextCsrfCredential,
  ];
  readonly #references = [ids.session, ids.nextSession];

  generateCredential(purpose: "Session" | "Csrf") {
    this.purposes.push(purpose);
    const value = this.#credentials.shift();
    if (value === undefined) throw new Error("synthetic credential exhausted");
    return value;
  }
  generateSessionReference() {
    const value = this.#references.shift();
    if (value === undefined) throw new Error("synthetic reference exhausted");
    return value;
  }
  hashCredential(purpose: "Session" | "Csrf", credential: GuestRawCredential) {
    this.purposes.push(`Hash${purpose}`);
    return hash(
      credential === sessionCredential
        ? "a"
        : credential === csrfCredential
          ? "b"
          : credential === nextSessionCredential
            ? "c"
            : "d",
    );
  }
  hashOperationIntent(intent: string) {
    return hash(
      intent.includes("Rotate:")
        ? "e"
        : intent.includes("Revoke:")
          ? "f"
          : intent.includes(ids.nextEntry)
            ? "8"
            : "9",
    );
  }
  equals(left: GuestSelectorHash, right: GuestSelectorHash) {
    return left === right;
  }
}

class MemoryStore implements GuestSessionStorePort {
  readonly records = new Map<GuestSelectorHash, GuestSessionRecord>();
  readonly operations = new Map<GuestOperationReference, GuestSessionRecord>();
  touches = 0;

  async create(command: { readonly record: GuestSessionRecord }) {
    this.records.set(command.record.sessionSelectorHash, command.record);
    this.operations.set(command.record.operationReference, command.record);
    return command.record;
  }
  async resolve(selectorHash: GuestSelectorHash) {
    return this.records.get(selectorHash) ?? null;
  }
  async resolveOperation(operationReference: GuestOperationReference) {
    return this.operations.get(operationReference) ?? null;
  }
  async touchInteractive(command: {
    readonly selectorHash: GuestSelectorHash;
    readonly expectedVersion: number;
    readonly observedAt: string;
    readonly idleExpiresAt: string;
  }) {
    const current = this.records.get(command.selectorHash);
    if (current === undefined || current.session.version !== command.expectedVersion) return null;
    this.touches += 1;
    const touched = createGuestSessionRecord({
      ...current,
      session: {
        ...current.session,
        version: current.session.version + 1,
        lastSeenAt: command.observedAt,
        idleExpiresAt: command.idleExpiresAt,
      },
    });
    this.records.set(command.selectorHash, touched);
    return touched;
  }
  async rotate(command: {
    readonly currentSelectorHash: GuestSelectorHash;
    readonly expectedVersion: number;
    readonly reason: "Rotated" | "BindingChanged" | "RiskChanged";
    readonly observedAt: string;
    readonly nextRecord: GuestSessionRecord;
  }) {
    const current = this.records.get(command.currentSelectorHash);
    if (current === undefined || current.session.version !== command.expectedVersion) {
      throw new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT");
    }
    this.records.set(
      command.currentSelectorHash,
      createGuestSessionRecord({
        ...current,
        session: {
          ...current.session,
          status: "Revoked",
          version: current.session.version + 1,
          revocationReason: command.reason,
          revokedAt: command.observedAt,
        },
      }),
    );
    this.records.set(command.nextRecord.sessionSelectorHash, command.nextRecord);
    this.operations.set(command.nextRecord.operationReference, command.nextRecord);
    return command.nextRecord;
  }
  async revoke(command: {
    readonly selectorHash: GuestSelectorHash;
    readonly expectedVersion: number;
    readonly reason:
      | "Rotated"
      | "BindingChanged"
      | "Logout"
      | "StoreUnavailable"
      | "QrRevoked"
      | "OrderClosed"
      | "DiningSessionClosed"
      | "RiskChanged"
      | "Administrative";
    readonly observedAt: string;
    readonly operationReference: GuestOperationReference;
    readonly operationIntentHash: GuestSelectorHash;
  }) {
    const current = this.records.get(command.selectorHash);
    if (current === undefined || current.session.version !== command.expectedVersion) return null;
    const revoked = createGuestSession({
      ...current.session,
      status: "Revoked",
      version: current.session.version + 1,
      revocationReason: command.reason,
      revokedAt: command.observedAt,
    });
    const record = createGuestSessionRecord({
      ...current,
      session: revoked,
      operationReference: command.operationReference,
      operationIntentHash: command.operationIntentHash,
    });
    this.records.set(command.selectorHash, record);
    this.operations.set(command.operationReference, record);
    return revoked;
  }
}

const fixture = (
  admissionValue: GuestAdmissionEvidence | null = parseGuestAdmissionEvidence(evidence()),
  binding: "Current" | "Unavailable" = "Current",
) => {
  const store = new MemoryStore();
  const credentials = new SyntheticCredentials();
  const admissionCalls: unknown[] = [];
  const service = new GuestSessionService({
    admission: {
      async consume(command) {
        admissionCalls.push(command);
        return admissionValue;
      },
    },
    binding: { validate: async () => binding },
    store,
    credentials,
    now: () => now,
  });
  return { service, store, credentials, admissionCalls };
};

const issue = async (service: GuestSessionService) => {
  const result = await service.create({
    entryRequestReference: ids.entry,
    operationReference: ids.operation,
  });
  if (result.status !== "Issued") throw new Error("expected issued result");
  return result;
};

describe("Guest Session contract", () => {
  it("accepts only strict server admission evidence and exact DineIn/Pickup shape", () => {
    expect(parseGuestAdmissionEvidence(evidence())).toMatchObject({
      decision: "Allowed",
      channel: "DineIn",
      publicTableReference: ids.publicTable,
    });
    expect(
      parseGuestAdmissionEvidence(evidence({ channel: "Pickup", publicTableReference: null })),
    ).toMatchObject({ channel: "Pickup", publicTableReference: null });
    expect(() => parseGuestAdmissionEvidence(evidence({ decision: "Denied" }))).toThrow(
      GuestSessionError,
    );
    expect(() => parseGuestAdmissionEvidence({ ...evidence(), clientAllowed: true })).toThrow(
      GuestSessionError,
    );
  });

  it("enforces half-open 4h idle, 24h absolute and 2h closure bounds", () => {
    const active = createGuestSession(session());
    expect(assertGuestSessionUsable(active, "2026-07-29T15:59:59.999Z")).toBe(active);
    expect(() => assertGuestSessionUsable(active, "2026-07-29T16:00:00.000Z")).toThrow(
      GuestSessionError,
    );
    const closed = createGuestSession(
      session({
        orderClosedAt: "2026-07-29T13:00:00.000Z",
        closureExpiresAt: "2026-07-29T15:00:00.000Z",
      }),
    );
    expect(() => assertGuestSessionUsable(closed, "2026-07-29T15:00:00.000Z")).toThrow(
      GuestSessionError,
    );
    expect(() =>
      createGuestSession(session({ idleExpiresAt: "2026-07-29T16:00:00.001Z" })),
    ).toThrow(GuestSessionError);
  });

  it("creates fresh purpose-separated credentials from one consumed server proof", async () => {
    const { service, store, credentials, admissionCalls } = fixture();
    const result = await issue(service);
    expect(result).toMatchObject({
      status: "Issued",
      sessionCredential,
      csrfCredential,
      cookie: guestSessionCookie,
      session: { diningState: "ContextOnly", version: 1 },
    });
    expect(admissionCalls).toHaveLength(1);
    expect(credentials.purposes).toEqual(["Session", "Csrf", "HashSession", "HashCsrf"]);
    const persisted = [...store.records.values()][0];
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).not.toContain(sessionCredential);
    expect(JSON.stringify(persisted)).not.toContain(csrfCredential);
    expect(persisted?.session).not.toHaveProperty("customer");
    expect(persisted?.session).not.toHaveProperty("permissions");
    expect(persisted?.session).not.toHaveProperty("diningSessionReference");
  });

  it("ignores fixation-shaped extra caller state because it is outside the closed create command", async () => {
    const { service } = fixture();
    const result = await service.create({
      entryRequestReference: ids.entry,
      operationReference: ids.operation,
      requestedAt: now,
      fixationCandidate: "attacker-controlled",
    } as Parameters<GuestSessionService["create"]>[0]);
    expect(result.status).toBe("Issued");
    if (result.status === "Issued") expect(result.sessionCredential).toBe(sessionCredential);
  });

  it("rejects unknown command fields and accessors without invoking them", async () => {
    const { service } = fixture();
    let accessed = false;
    const accessor = Object.defineProperty(
      {
        entryRequestReference: ids.entry,
        operationReference: ids.operation,
      },
      "requestedAt",
      {
        enumerable: true,
        get() {
          accessed = true;
          return now;
        },
      },
    );
    await expect(service.create(accessor)).rejects.toMatchObject({
      code: "GUEST_SESSION_INPUT_INVALID",
    });
    expect(accessed).toBe(false);
    await expect(
      service.resolve({
        sessionCredential,
        activity: "Background",
        unexpected: true,
      } as Parameters<GuestSessionService["resolve"]>[0]),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_INPUT_INVALID" });
  });

  it("fails denied, stale, future and dependency admission uniformly unavailable", async () => {
    for (const admission of [
      null,
      parseGuestAdmissionEvidence(
        evidence({
          evaluatedAt: "2026-07-29T11:59:59.999Z",
          validUntil: now,
        }),
      ),
      parseGuestAdmissionEvidence(
        evidence({
          evaluatedAt: "2026-07-29T12:00:00.001Z",
          validUntil: "2026-07-29T12:05:00.000Z",
        }),
      ),
    ]) {
      await expect(
        fixture(admission).service.create({
          entryRequestReference: ids.entry,
          operationReference: ids.operation,
        }),
      ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
    }
    const service = new GuestSessionService({
      admission: { consume: async () => Promise.reject(new Error("private dependency detail")) },
      binding: { validate: async () => "Current" },
      store: new MemoryStore(),
      credentials: new SyntheticCredentials(),
      now: () => now,
    });
    await expect(
      service.create({
        entryRequestReference: ids.entry,
        operationReference: ids.operation,
      }),
    ).rejects.toMatchObject({
      code: "GUEST_SESSION_UNAVAILABLE",
      message: "guest session is unavailable",
    });
  });

  it("does not extend idle time for background activity and does for interactive activity", async () => {
    const { service, store } = fixture();
    await issue(service);
    await service.resolve({
      sessionCredential,
      activity: "Background",
      observedAt: "2026-07-29T12:30:00.000Z",
    });
    expect(store.touches).toBe(0);
    const touched = await service.resolve({
      sessionCredential,
      activity: "Interactive",
      observedAt: "2026-07-29T12:30:00.000Z",
    });
    expect(store.touches).toBe(1);
    expect(touched).toMatchObject({
      version: 2,
      lastSeenAt: "2026-07-29T12:30:00.000Z",
      idleExpiresAt: "2026-07-29T16:30:00.000Z",
    });
  });

  it("fails closed when current Store or QR binding validation is unavailable", async () => {
    const { service } = fixture(parseGuestAdmissionEvidence(evidence()), "Unavailable");
    await issue(service);
    await expect(
      service.resolve({ sessionCredential, activity: "Background" }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  });

  it("maps Store failures and malformed records to one unavailable result", async () => {
    for (const resolved of [new Error("private store detail"), { unexpected: true }]) {
      const store = new MemoryStore();
      store.resolve = async () => {
        if (resolved instanceof Error) throw resolved;
        return resolved as never;
      };
      const service = new GuestSessionService({
        admission: { consume: async () => parseGuestAdmissionEvidence(evidence()) },
        binding: { validate: async () => "Current" },
        store,
        credentials: new SyntheticCredentials(),
        now: () => now,
      });
      await expect(
        service.resolve({ sessionCredential, activity: "Background" }),
      ).rejects.toMatchObject({
        code: "GUEST_SESSION_UNAVAILABLE",
        message: "guest session is unavailable",
      });
    }
  });

  it("authorizes only the CSRF credential bound to the same active Session", async () => {
    const { service } = fixture();
    await issue(service);
    await expect(service.authorize({ sessionCredential, csrfCredential })).resolves.toMatchObject({
      sessionReference: ids.session,
    });
    await expect(
      service.authorize({ sessionCredential, csrfCredential: nextCsrfCredential }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  });

  it("rotates both credentials atomically and makes the former selector unusable", async () => {
    const { service } = fixture();
    await issue(service);
    const rotated = await service.rotate({
      sessionCredential,
      expectedVersion: 1,
      entryRequestReference: ids.entry,
      operationReference: ids.nextOperation,
      reason: "BindingChanged",
    });
    expect(rotated.status).toBe("Issued");
    if (rotated.status === "Issued") {
      expect(rotated.sessionCredential).toBe(nextSessionCredential);
      expect(rotated.csrfCredential).toBe(nextCsrfCredential);
      expect(rotated.session.rotatedFromGuestSessionReference).toBe(ids.session);
    }
    await expect(
      service.resolve({ sessionCredential, activity: "Background" }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  });

  it("returns a bounded replay without reissuing raw credentials and rejects changed intent", async () => {
    const { service } = fixture();
    await issue(service);
    const replay = await service.create({
      entryRequestReference: ids.entry,
      operationReference: ids.operation,
    });
    expect(replay).toMatchObject({
      status: "AlreadyApplied",
      session: { sessionReference: ids.session },
    });
    expect(replay).not.toHaveProperty("sessionCredential");
    await expect(
      service.create({
        entryRequestReference: ids.nextEntry,
        operationReference: ids.operation,
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects stale expected versions and supports closed-reason revocation", async () => {
    const stale = fixture();
    await issue(stale.service);
    await expect(
      stale.service.rotate({
        sessionCredential,
        expectedVersion: 2,
        entryRequestReference: ids.entry,
        operationReference: ids.nextOperation,
        reason: "RiskChanged",
      }),
    ).rejects.toMatchObject({ code: "GUEST_SESSION_VERSION_CONFLICT" });

    const current = fixture();
    await issue(current.service);
    const revoked = await current.service.revoke({
      sessionCredential,
      expectedVersion: 1,
      operationReference: ids.nextOperation,
      reason: "Administrative",
    });
    expect(revoked).toMatchObject({
      status: "Revoked",
      revocationReason: "Administrative",
      version: 2,
    });
    await expect(
      current.service.revoke({
        sessionCredential,
        expectedVersion: 1,
        operationReference: ids.nextOperation,
        reason: "Administrative",
      }),
    ).resolves.toEqual(revoked);
  });

  it("uses privacy-safe uniform errors without references or credential values", async () => {
    const { service } = fixture();
    for (const value of ["short", sessionCredential]) {
      try {
        await service.resolve({ sessionCredential: value, activity: "Background" });
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GuestSessionError);
        expect(String((error as Error).message)).not.toContain(ids.session);
        expect(String((error as Error).message)).not.toContain(sessionCredential);
      }
    }
  });
});
