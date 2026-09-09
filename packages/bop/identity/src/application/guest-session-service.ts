import {
  assertGuestSessionUsable,
  createGuestSession,
  createGuestSessionRecord,
  guestSessionCookie,
  GuestSessionError,
  parseGuestAdmissionEvidence,
  parseGuestDiningAdmissionEvidence,
  parseGuestDiningAdmissionReference,
  parseGuestEntryRequestReference,
  parseGuestOperationReference,
  parseGuestRawCredential,
  parseGuestSessionReference,
  type GuestAdmissionEvidence,
  type GuestDiningAdmissionEvidence,
  type GuestRawCredential,
  type GuestSession,
  type GuestSessionRecord,
  type GuestSessionRevocationReason,
} from "../contracts/guest-session.js";
import { parseCanonicalInstant, type CanonicalInstant } from "../contracts/identity-actor.js";
import type {
  GuestEntryAdmissionPort,
  GuestDiningAdmissionPort,
  GuestSessionBindingPort,
  GuestSessionCredentialPort,
  GuestSessionStorePort,
} from "./ports/guest-session-ports.js";

const fourHours = 4 * 60 * 60 * 1000;
const twentyFourHours = 24 * 60 * 60 * 1000;
const plus = (value: CanonicalInstant, milliseconds: number) =>
  new Date(Date.parse(value) + milliseconds).toISOString() as CanonicalInstant;
const command = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => {
      if (typeof key !== "string" || !allowed.has(key)) return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, descriptors[key as string]?.value])),
  );
};

export interface GuestSessionServiceOptions {
  readonly admission: GuestEntryAdmissionPort;
  readonly diningAdmission?: GuestDiningAdmissionPort;
  readonly binding: GuestSessionBindingPort;
  readonly store: GuestSessionStorePort;
  readonly credentials: GuestSessionCredentialPort;
  readonly now?: () => unknown;
}
export interface GuestSessionIssueResult {
  readonly status: "Issued";
  readonly session: GuestSession;
  readonly sessionCredential: GuestRawCredential;
  readonly csrfCredential: GuestRawCredential;
  readonly cookie: typeof guestSessionCookie;
}
export interface GuestSessionReplayResult {
  readonly status: "AlreadyApplied";
  readonly session: GuestSession;
  readonly cookie: typeof guestSessionCookie;
}
interface FreshGuestSessionRecord {
  readonly record: GuestSessionRecord;
  readonly sessionCredential: GuestRawCredential;
  readonly csrfCredential: GuestRawCredential;
}

export class GuestSessionService {
  readonly #admission: GuestEntryAdmissionPort;
  readonly #diningAdmission: GuestDiningAdmissionPort | null;
  readonly #binding: GuestSessionBindingPort;
  readonly #store: GuestSessionStorePort;
  readonly #credentials: GuestSessionCredentialPort;
  readonly #now: () => unknown;

  constructor(options: GuestSessionServiceOptions) {
    this.#admission = options.admission;
    this.#diningAdmission = options.diningAdmission ?? null;
    this.#binding = options.binding;
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #at(value?: unknown): CanonicalInstant {
    try {
      return parseCanonicalInstant(value ?? this.#now());
    } catch {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
  }

  async #evidence(
    entryRequestInput: unknown,
    operationInput: unknown,
    requestedAt: CanonicalInstant,
  ): Promise<GuestAdmissionEvidence> {
    const entryRequestReference = parseGuestEntryRequestReference(entryRequestInput);
    const operationReference = parseGuestOperationReference(operationInput);
    try {
      const evidence = parseGuestAdmissionEvidence(
        await this.#admission.consume({
          entryRequestReference,
          operationReference,
          requestedAt,
        }),
      );
      if (
        evidence.entryRequestReference !== entryRequestReference ||
        Date.parse(evidence.evaluatedAt) > Date.parse(requestedAt) ||
        Date.parse(evidence.validUntil) <= Date.parse(requestedAt)
      ) {
        throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      }
      return evidence;
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  #intent(value: string) {
    try {
      return this.#credentials.hashOperationIntent(value);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  #selector(purpose: "Session" | "Csrf", credential: GuestRawCredential) {
    try {
      return this.#credentials.hashCredential(purpose, credential);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  async #storeCall<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof GuestSessionError &&
        (error.code === "GUEST_SESSION_VERSION_CONFLICT" ||
          error.code === "GUEST_SESSION_IDEMPOTENCY_CONFLICT")
      ) {
        throw error;
      }
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  #record(value: unknown): GuestSessionRecord {
    try {
      return createGuestSessionRecord(value);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  async #assertCurrent(session: GuestSession, observedAt: CanonicalInstant) {
    try {
      if ((await this.#binding.validate(session, observedAt)) !== "Current") {
        throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      }
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  #freshRecord(
    evidence: GuestAdmissionEvidence,
    operationInput: unknown,
    operationIntentHash: ReturnType<GuestSessionCredentialPort["hashOperationIntent"]>,
    observedAt: CanonicalInstant,
    rotatedFromGuestSessionReference: GuestSession["rotatedFromGuestSessionReference"],
  ): FreshGuestSessionRecord {
    const sessionCredential = parseGuestRawCredential(
      this.#credentials.generateCredential("Session"),
    );
    const csrfCredential = parseGuestRawCredential(this.#credentials.generateCredential("Csrf"));
    const operationReference = parseGuestOperationReference(operationInput);
    const session = createGuestSession({
      sessionReference: parseGuestSessionReference(this.#credentials.generateSessionReference()),
      status: "Active",
      version: 1,
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      publicStoreReference: evidence.publicStoreReference,
      publicTableReference: evidence.publicTableReference,
      channel: evidence.channel,
      locale: evidence.locale,
      qrReference: evidence.qrReference,
      qrRevocationVersion: evidence.qrRevocationVersion,
      diningState: "ContextOnly",
      diningSessionReference: null,
      diningParticipantReference: null,
      createdAt: observedAt,
      lastSeenAt: observedAt,
      idleExpiresAt: plus(observedAt, fourHours),
      absoluteExpiresAt: plus(observedAt, twentyFourHours),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference,
      revocationReason: null,
      revokedAt: null,
    });
    return {
      record: createGuestSessionRecord({
        session,
        sessionSelectorHash: this.#credentials.hashCredential("Session", sessionCredential),
        csrfSelectorHash: this.#credentials.hashCredential("Csrf", csrfCredential),
        operationReference,
        operationIntentHash,
      }),
      sessionCredential,
      csrfCredential,
    };
  }

  async create(input: {
    readonly entryRequestReference: unknown;
    readonly operationReference: unknown;
    readonly requestedAt?: unknown;
    readonly fixationCandidate?: unknown;
  }): Promise<GuestSessionIssueResult | GuestSessionReplayResult> {
    const raw = command(
      input,
      ["entryRequestReference", "operationReference"],
      ["requestedAt", "fixationCandidate"],
    );
    const requestedAt = this.#at(raw.requestedAt);
    const operationReference = parseGuestOperationReference(raw.operationReference);
    const entryRequestReference = parseGuestEntryRequestReference(raw.entryRequestReference);
    const intent = this.#intent(`Create:${entryRequestReference}`);
    const prior = await this.#storeCall(() => this.#store.resolveOperation(operationReference));
    if (prior !== null) {
      if (!this.#credentials.equals(prior.operationIntentHash, intent)) {
        throw new GuestSessionError("GUEST_SESSION_IDEMPOTENCY_CONFLICT");
      }
      return Object.freeze({
        status: "AlreadyApplied",
        session: prior.session,
        cookie: guestSessionCookie,
      });
    }
    const evidence = await this.#evidence(entryRequestReference, operationReference, requestedAt);
    let fresh: FreshGuestSessionRecord;
    try {
      fresh = this.#freshRecord(evidence, operationReference, intent, requestedAt, null);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
    const persisted = this.#record(
      await this.#storeCall(() => this.#store.create({ record: fresh.record })),
    );
    return Object.freeze({
      status: "Issued",
      session: persisted.session,
      sessionCredential: fresh.sessionCredential,
      csrfCredential: fresh.csrfCredential,
      cookie: guestSessionCookie,
    });
  }

  async resolve(input: {
    readonly sessionCredential: unknown;
    readonly activity: "Interactive" | "Background";
    readonly observedAt?: unknown;
  }): Promise<GuestSession> {
    const raw = command(input, ["sessionCredential", "activity"], ["observedAt"]);
    const observedAt = this.#at(raw.observedAt);
    if (raw.activity !== "Interactive" && raw.activity !== "Background") {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    const credential = parseGuestRawCredential(raw.sessionCredential);
    try {
      const selectorHash = this.#credentials.hashCredential("Session", credential);
      const record = await this.#storeCall(() => this.#store.resolve(selectorHash));
      if (record === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      const session = assertGuestSessionUsable(this.#record(record).session, observedAt);
      await this.#assertCurrent(session, observedAt);
      if (raw.activity === "Background") return session;
      const touched = await this.#storeCall(() =>
        this.#store.touchInteractive({
          selectorHash,
          expectedVersion: session.version,
          observedAt,
          idleExpiresAt: plus(observedAt, fourHours),
        }),
      );
      if (touched === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      return assertGuestSessionUsable(this.#record(touched).session, observedAt);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  async authorize(input: {
    readonly sessionCredential: unknown;
    readonly csrfCredential: unknown;
    readonly observedAt?: unknown;
  }): Promise<GuestSession> {
    const raw = command(input, ["sessionCredential", "csrfCredential"], ["observedAt"]);
    const observedAt = this.#at(raw.observedAt);
    const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
    const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
    try {
      const record = await this.#storeCall(() =>
        this.#store.resolve(this.#credentials.hashCredential("Session", sessionCredential)),
      );
      if (
        record === null ||
        !this.#credentials.equals(
          this.#credentials.hashCredential("Csrf", csrfCredential),
          record.csrfSelectorHash,
        )
      ) {
        throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      }
      const session = assertGuestSessionUsable(this.#record(record).session, observedAt);
      await this.#assertCurrent(session, observedAt);
      return session;
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }

  async bindDining(input: {
    readonly sessionCredential: unknown;
    readonly expectedVersion: unknown;
    readonly diningAdmissionReference: unknown;
    readonly operationReference: unknown;
    readonly requestedAt?: unknown;
  }): Promise<GuestSessionIssueResult | GuestSessionReplayResult> {
    const raw = command(
      input,
      ["sessionCredential", "expectedVersion", "diningAdmissionReference", "operationReference"],
      ["requestedAt"],
    );
    const requestedAt = this.#at(raw.requestedAt);
    if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1) {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    if (this.#diningAdmission === null) {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
    const credential = parseGuestRawCredential(raw.sessionCredential);
    const currentSelectorHash = this.#selector("Session", credential);
    const current = await this.#storeCall(() => this.#store.resolve(currentSelectorHash));
    if (current === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    const resolvedCurrent = this.#record(current).session;
    const operationReference = parseGuestOperationReference(raw.operationReference);
    const admissionReference = parseGuestDiningAdmissionReference(raw.diningAdmissionReference);
    const intent = this.#intent(
      `BindDining:${resolvedCurrent.sessionReference}:${raw.expectedVersion}:${admissionReference}`,
    );
    const prior = await this.#storeCall(() => this.#store.resolveOperation(operationReference));
    if (prior !== null) {
      if (!this.#credentials.equals(prior.operationIntentHash, intent)) {
        throw new GuestSessionError("GUEST_SESSION_IDEMPOTENCY_CONFLICT");
      }
      return Object.freeze({
        status: "AlreadyApplied",
        session: prior.session,
        cookie: guestSessionCookie,
      });
    }
    const currentSession = assertGuestSessionUsable(resolvedCurrent, requestedAt);
    if (currentSession.version !== raw.expectedVersion) {
      throw new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT");
    }
    if (
      currentSession.channel !== "DineIn" ||
      currentSession.diningState !== "ContextOnly" ||
      currentSession.publicTableReference === null
    ) {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
    let evidence: GuestDiningAdmissionEvidence;
    try {
      evidence = parseGuestDiningAdmissionEvidence(
        await this.#diningAdmission.consume({
          guestSessionReference: currentSession.sessionReference,
          admissionReference,
          operationReference,
          requestedAt,
        }),
      );
      if (
        evidence.guestSessionReference !== currentSession.sessionReference ||
        evidence.admissionReference !== admissionReference ||
        evidence.operationReference !== operationReference ||
        evidence.storeReference !== currentSession.storeReference ||
        evidence.publicTableReference !== currentSession.publicTableReference ||
        Date.parse(evidence.evaluatedAt) > Date.parse(requestedAt) ||
        Date.parse(evidence.validUntil) <= Date.parse(requestedAt)
      ) {
        throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
      }
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
    const sessionCredential = parseGuestRawCredential(
      this.#credentials.generateCredential("Session"),
    );
    const csrfCredential = parseGuestRawCredential(this.#credentials.generateCredential("Csrf"));
    const nextSession = createGuestSession({
      ...currentSession,
      sessionReference: parseGuestSessionReference(this.#credentials.generateSessionReference()),
      version: 1,
      diningState: "DiningBound",
      diningSessionReference: evidence.diningSessionReference,
      diningParticipantReference: evidence.diningParticipantReference,
      createdAt: requestedAt,
      lastSeenAt: requestedAt,
      idleExpiresAt: plus(requestedAt, fourHours),
      absoluteExpiresAt: plus(requestedAt, twentyFourHours),
      orderClosedAt: null,
      closureExpiresAt: null,
      rotatedFromGuestSessionReference: currentSession.sessionReference,
      revocationReason: null,
      revokedAt: null,
    });
    const nextRecord = createGuestSessionRecord({
      session: nextSession,
      sessionSelectorHash: this.#selector("Session", sessionCredential),
      csrfSelectorHash: this.#selector("Csrf", csrfCredential),
      operationReference,
      operationIntentHash: intent,
    });
    const persisted = this.#record(
      await this.#storeCall(() =>
        this.#store.rotate({
          currentSelectorHash,
          expectedVersion: raw.expectedVersion as number,
          reason: "BindingChanged",
          observedAt: requestedAt,
          nextRecord,
        }),
      ),
    );
    return Object.freeze({
      status: "Issued",
      session: persisted.session,
      sessionCredential,
      csrfCredential,
      cookie: guestSessionCookie,
    });
  }

  async rotate(input: {
    readonly sessionCredential: unknown;
    readonly expectedVersion: unknown;
    readonly entryRequestReference: unknown;
    readonly operationReference: unknown;
    readonly reason: "Rotated" | "BindingChanged" | "RiskChanged";
    readonly requestedAt?: unknown;
  }): Promise<GuestSessionIssueResult | GuestSessionReplayResult> {
    const raw = command(
      input,
      [
        "sessionCredential",
        "expectedVersion",
        "entryRequestReference",
        "operationReference",
        "reason",
      ],
      ["requestedAt"],
    );
    const requestedAt = this.#at(raw.requestedAt);
    if (
      !Number.isSafeInteger(raw.expectedVersion) ||
      (raw.expectedVersion as number) < 1 ||
      !["Rotated", "BindingChanged", "RiskChanged"].includes(raw.reason as string)
    ) {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    const credential = parseGuestRawCredential(raw.sessionCredential);
    const currentSelectorHash = this.#selector("Session", credential);
    const current = await this.#storeCall(() => this.#store.resolve(currentSelectorHash));
    if (current === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    const resolvedCurrent = this.#record(current).session;
    const operationReference = parseGuestOperationReference(raw.operationReference);
    const entryRequestReference = parseGuestEntryRequestReference(raw.entryRequestReference);
    const reason = raw.reason as "Rotated" | "BindingChanged" | "RiskChanged";
    const intent = this.#intent(
      `Rotate:${resolvedCurrent.sessionReference}:${raw.expectedVersion}:${entryRequestReference}:${reason}`,
    );
    const prior = await this.#storeCall(() => this.#store.resolveOperation(operationReference));
    if (prior !== null) {
      if (!this.#credentials.equals(prior.operationIntentHash, intent)) {
        throw new GuestSessionError("GUEST_SESSION_IDEMPOTENCY_CONFLICT");
      }
      return Object.freeze({
        status: "AlreadyApplied",
        session: prior.session,
        cookie: guestSessionCookie,
      });
    }
    const currentSession = assertGuestSessionUsable(resolvedCurrent, requestedAt);
    if (currentSession.version !== raw.expectedVersion) {
      throw new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT");
    }
    const evidence = await this.#evidence(entryRequestReference, operationReference, requestedAt);
    let fresh: FreshGuestSessionRecord;
    try {
      fresh = this.#freshRecord(
        evidence,
        operationReference,
        intent,
        requestedAt,
        currentSession.sessionReference,
      );
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
    const persisted = this.#record(
      await this.#storeCall(() =>
        this.#store.rotate({
          currentSelectorHash,
          expectedVersion: raw.expectedVersion as number,
          reason,
          observedAt: requestedAt,
          nextRecord: fresh.record,
        }),
      ),
    );
    return Object.freeze({
      status: "Issued",
      session: persisted.session,
      sessionCredential: fresh.sessionCredential,
      csrfCredential: fresh.csrfCredential,
      cookie: guestSessionCookie,
    });
  }

  async revoke(input: {
    readonly sessionCredential: unknown;
    readonly expectedVersion: unknown;
    readonly operationReference: unknown;
    readonly reason: GuestSessionRevocationReason;
    readonly requestedAt?: unknown;
  }): Promise<GuestSession> {
    const raw = command(
      input,
      ["sessionCredential", "expectedVersion", "operationReference", "reason"],
      ["requestedAt"],
    );
    const requestedAt = this.#at(raw.requestedAt);
    if (!Number.isSafeInteger(raw.expectedVersion) || (raw.expectedVersion as number) < 1) {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    const reasons: readonly GuestSessionRevocationReason[] = [
      "Rotated",
      "BindingChanged",
      "Logout",
      "StoreUnavailable",
      "QrRevoked",
      "OrderClosed",
      "DiningSessionClosed",
      "RiskChanged",
      "Administrative",
    ];
    if (!reasons.includes(raw.reason as GuestSessionRevocationReason)) {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    const reason = raw.reason as GuestSessionRevocationReason;
    const operationReference = parseGuestOperationReference(raw.operationReference);
    const credential = parseGuestRawCredential(raw.sessionCredential);
    const selectorHash = this.#selector("Session", credential);
    const intent = this.#intent(`Revoke:${selectorHash}:${raw.expectedVersion}:${reason}`);
    const prior = await this.#storeCall(() => this.#store.resolveOperation(operationReference));
    if (prior !== null) {
      if (!this.#credentials.equals(prior.operationIntentHash, intent)) {
        throw new GuestSessionError("GUEST_SESSION_IDEMPOTENCY_CONFLICT");
      }
      return prior.session;
    }
    const revoked = await this.#storeCall(() =>
      this.#store.revoke({
        selectorHash,
        expectedVersion: raw.expectedVersion as number,
        reason,
        observedAt: requestedAt,
        operationReference,
        operationIntentHash: intent,
      }),
    );
    if (revoked === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    try {
      return createGuestSession(revoked);
    } catch {
      throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
    }
  }
}
