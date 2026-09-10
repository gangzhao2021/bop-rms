import {
  parseGuestDiningBindingPreparation,
  prepareGuestDiningBinding,
  activateGuestDiningBinding,
  acknowledgeGuestDiningBinding,
} from "../contracts/guest-dining-binding-preparation.js";
import {
  assertGuestSessionUsable,
  createGuestSession,
  createGuestSessionRecord,
  guestSessionCookie,
  GuestSessionError,
  parseGuestOperationReference,
  parseGuestDiningAdmissionReference,
  parseGuestDiningAdmissionEvidence,
  parseGuestRawCredential,
  parseGuestSessionReference,
  parseGuestSelectorHash,
  type GuestRawCredential,
} from "../contracts/guest-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "../contracts/identity-actor.js";
import type { GuestDiningBindingServiceOptions } from "./ports/guest-dining-binding-ports.js";

function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}
async function boundary<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    return unavailable();
  }
}
const uuid = (value: unknown) => parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID");

/** Credential-bearing results belong only to a same-origin, no-store credential transport. */
export function createGuestDiningBindingService(options: GuestDiningBindingServiceOptions) {
  const lifetime = options.preparationLifetimeSeconds;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > 900 ||
    typeof options.now !== "function"
  )
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  const now = () => parseCanonicalInstant(options.now());
  const sessionHash = (raw: GuestRawCredential) =>
    parseGuestSelectorHash(options.credentials.hashCredential("Session", raw));
  const csrfHash = (raw: GuestRawCredential) =>
    parseGuestSelectorHash(options.credentials.hashCredential("Csrf", raw));
  async function authorize(
    sessionCredential: GuestRawCredential,
    csrfCredential: GuestRawCredential,
    state: "ContextOnly" | "DiningBound",
  ) {
    const at = now();
    const session = assertGuestSessionUsable(
      createGuestSession(
        await options.authorization.authorize({
          sessionCredential,
          csrfCredential,
          observedAt: at,
        }),
      ),
      at,
    );
    if (session.channel !== "DineIn" || session.diningState !== state) return unavailable();
    return session;
  }
  async function finish(
    operationReference: string,
    sessionCredential: GuestRawCredential,
    csrfCredential: GuestRawCredential,
  ) {
    const session = await authorize(sessionCredential, csrfCredential, "DiningBound");
    const at = now();
    const result = readClosedRecord(
      await options.bindings.complete({
        operationReference,
        sessionSelectorHash: sessionHash(sessionCredential),
        csrfSelectorHash: csrfHash(csrfCredential),
        observedAt: at,
      }),
      [
        "operationReference",
        "admissionReference",
        "sessionReference",
        "brandReference",
        "storeReference",
        "diningSessionReference",
        "diningParticipantReference",
        "activatedAt",
      ],
    );
    if (
      result.operationReference !== operationReference ||
      result.sessionReference !== session.sessionReference ||
      result.brandReference !== session.brandReference ||
      result.storeReference !== session.storeReference ||
      result.diningSessionReference !== session.diningSessionReference ||
      result.diningParticipantReference !== session.diningParticipantReference ||
      parseCanonicalInstant(result.activatedAt) > at ||
      parseCanonicalInstant(result.activatedAt) < session.createdAt
    )
      return unavailable();
    parseGuestDiningAdmissionReference(result.admissionReference);
    return Object.freeze({
      status: "Activated" as const,
      operationReference,
      sessionCredential,
      csrfCredential,
      cookie: guestSessionCookie,
    });
  }
  return Object.freeze({
    prepare(input: unknown) {
      return boundary(async () => {
        const raw = readClosedRecord(input, [
          "sessionCredential",
          "csrfCredential",
          "operationReference",
          "admissionReference",
        ]);
        const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
        const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
        const operationReference = parseGuestOperationReference(raw.operationReference);
        const admissionReference = parseGuestDiningAdmissionReference(raw.admissionReference);
        const session = await authorize(sessionCredential, csrfCredential, "ContextOnly");
        const predecessor = createGuestSessionRecord(
          await options.sessions.resolve(sessionHash(sessionCredential)),
        );
        if (
          JSON.stringify(predecessor.session) !== JSON.stringify(session) ||
          options.credentials.equals(
            predecessor.sessionSelectorHash,
            sessionHash(sessionCredential),
          ) !== true ||
          options.credentials.equals(predecessor.csrfSelectorHash, csrfHash(csrfCredential)) !==
            true
        )
          return unavailable();
        const reservationAt = now();
        const target = readClosedRecord(
          await options.owner.reserveAdmission({
            operationReference,
            admissionReference,
            session,
            observedAt: reservationAt,
          }),
          [
            "operationReference",
            "admissionReference",
            "guestSessionReference",
            "brandReference",
            "storeReference",
            "publicTableReference",
            "diningSessionReference",
            "diningParticipantReference",
            "expectedGuestVersion",
            "evaluatedAt",
            "validUntil",
          ],
        );
        if (
          target.operationReference !== operationReference ||
          target.admissionReference !== admissionReference ||
          target.guestSessionReference !== session.sessionReference ||
          target.brandReference !== session.brandReference ||
          target.storeReference !== session.storeReference ||
          target.publicTableReference !== session.publicTableReference ||
          target.expectedGuestVersion !== session.version ||
          parseCanonicalInstant(target.evaluatedAt) > reservationAt
        )
          return unavailable();
        const diningSessionReference = uuid(target.diningSessionReference);
        const diningParticipantReference = uuid(target.diningParticipantReference);
        const preparedAt = now();
        assertGuestSessionUsable(session, preparedAt);
        const expiresAt = parseCanonicalInstant(
          new Date(
            Math.min(
              Date.parse(preparedAt) + lifetime * 1000,
              Date.parse(session.idleExpiresAt),
              Date.parse(session.absoluteExpiresAt),
              session.closureExpiresAt === null ? Infinity : Date.parse(session.closureExpiresAt),
              Date.parse(parseCanonicalInstant(target.validUntil)),
            ),
          ).toISOString(),
        );
        if (expiresAt <= preparedAt) return unavailable();
        const nextSessionCredential = parseGuestRawCredential(
          options.credentials.generateCredential("Session"),
        );
        const nextCsrfCredential = parseGuestRawCredential(
          options.credentials.generateCredential("Csrf"),
        );
        const recoveryProof = parseGuestRawCredential(options.recovery.generate());
        const candidate = createGuestSessionRecord({
          ...predecessor,
          session: {
            ...session,
            sessionReference: parseGuestSessionReference(
              options.credentials.generateSessionReference(),
            ),
            version: 1,
            diningState: "DiningBound",
            diningSessionReference,
            diningParticipantReference,
            createdAt: preparedAt,
            lastSeenAt: preparedAt,
            idleExpiresAt: new Date(Date.parse(preparedAt) + 4 * 60 * 60 * 1000).toISOString(),
            absoluteExpiresAt: new Date(Date.parse(preparedAt) + 24 * 60 * 60 * 1000).toISOString(),
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: session.sessionReference,
          },
          sessionSelectorHash: sessionHash(nextSessionCredential),
          csrfSelectorHash: csrfHash(nextCsrfCredential),
          operationReference,
          operationIntentHash: options.credentials.hashOperationIntent(
            JSON.stringify({
              purpose: "DiningSessionBinding",
              operationReference,
              predecessor: session.sessionReference,
              version: session.version,
              brand: session.brandReference,
              store: session.storeReference,
              admissionReference,
              diningSessionReference,
              diningParticipantReference,
            }),
          ),
        });
        const preparation = prepareGuestDiningBinding({
          operationReference,
          admissionReference,
          predecessor,
          candidate,
          recoverySelectorHash: options.recovery.hash(recoveryProof),
          preparedAt,
          expiresAt,
        });
        const saved = parseGuestDiningBindingPreparation(
          await options.bindings.prepare(preparation, now()),
        );
        if (JSON.stringify(saved) !== JSON.stringify(preparation)) return unavailable();
        return Object.freeze({
          status: "Prepared" as const,
          operationReference,
          sessionCredential: nextSessionCredential,
          csrfCredential: nextCsrfCredential,
          recoveryProof,
          expiresAt,
        });
      });
    },
    activate(input: unknown) {
      return boundary(async () => {
        const raw = readClosedRecord(input, [
          "sessionCredential",
          "csrfCredential",
          "operationReference",
          "candidateSessionCredential",
          "candidateCsrfCredential",
          "recoveryProof",
        ]);
        const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
        const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
        const operationReference = parseGuestOperationReference(raw.operationReference);
        const candidateSessionCredential = parseGuestRawCredential(raw.candidateSessionCredential);
        const candidateCsrfCredential = parseGuestRawCredential(raw.candidateCsrfCredential);
        const proof = Object.freeze({
          sessionSelectorHash: sessionHash(candidateSessionCredential),
          csrfSelectorHash: csrfHash(candidateCsrfCredential),
          recoverySelectorHash: parseGuestSelectorHash(
            options.recovery.hash(parseGuestRawCredential(raw.recoveryProof)),
          ),
        });
        const session = await authorize(sessionCredential, csrfCredential, "ContextOnly");
        const acknowledged = parseGuestDiningBindingPreparation(
          await options.bindings.acknowledge({
            operationReference,
            currentSelectorHash: sessionHash(sessionCredential),
            proof,
            observedAt: now(),
          }),
        );
        if (
          acknowledged.status !== "Acknowledged" ||
          acknowledged.acknowledgedAt === null ||
          options.credentials.equals(
            acknowledged.predecessor.csrfSelectorHash,
            csrfHash(csrfCredential),
          ) !== true ||
          acknowledged.operationReference !== operationReference ||
          JSON.stringify(acknowledged.predecessor.session) !== JSON.stringify(session) ||
          options.credentials.equals(
            acknowledged.predecessor.sessionSelectorHash,
            sessionHash(sessionCredential),
          ) !== true ||
          options.credentials.equals(
            acknowledged.candidate.sessionSelectorHash,
            proof.sessionSelectorHash,
          ) !== true ||
          options.credentials.equals(
            acknowledged.candidate.csrfSelectorHash,
            proof.csrfSelectorHash,
          ) !== true ||
          options.credentials.equals(
            acknowledged.recoverySelectorHash,
            proof.recoverySelectorHash,
          ) !== true
        )
          return unavailable();
        const requestedAt = now();
        acknowledgeGuestDiningBinding(
          {
            preparation: acknowledged,
            current: acknowledged.predecessor,
            proof,
            observedAt: requestedAt,
          },
          options.credentials.equals,
        );
        const ownerEvidence = parseGuestDiningAdmissionEvidence(
          await options.owner.consume(
            Object.freeze({
              operationReference,
              admissionReference: parseGuestDiningAdmissionReference(
                acknowledged.admissionReference,
              ),
              guestSessionReference: session.sessionReference,
              requestedAt,
            }),
          ),
        );
        const at = now();
        const plan = activateGuestDiningBinding(
          {
            preparation: acknowledged,
            current: acknowledged.predecessor,
            proof,
            ownerEvidence,
            observedAt: at,
          },
          options.credentials.equals,
        );
        const activated = parseGuestDiningBindingPreparation(
          await options.bindings.activate({
            operationReference,
            currentSelectorHash: sessionHash(sessionCredential),
            proof,
            ownerEvidence,
            observedAt: at,
          }),
        );
        if (JSON.stringify(activated) !== JSON.stringify(plan.preparation)) return unavailable();
        return finish(operationReference, candidateSessionCredential, candidateCsrfCredential);
      });
    },
    complete(input: unknown) {
      return boundary(async () => {
        const raw = readClosedRecord(input, [
          "operationReference",
          "sessionCredential",
          "csrfCredential",
        ]);
        return finish(
          parseGuestOperationReference(raw.operationReference),
          parseGuestRawCredential(raw.sessionCredential),
          parseGuestRawCredential(raw.csrfCredential),
        );
      });
    },
  });
}
