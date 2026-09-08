import {
  parseGuestBindingPreparation,
  prepareGuestBinding,
} from "../contracts/guest-binding-preparation.js";
import {
  assertGuestSessionUsable,
  createGuestSession,
  createGuestSessionRecord,
  guestSessionCookie,
  GuestSessionError,
  parseGuestOperationReference,
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
import type {
  GuestBindingServiceOptions,
  GuestBindingCompletion,
} from "./ports/guest-binding-ports.js";

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
export function createGuestBindingService(options: GuestBindingServiceOptions) {
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
    if (session.channel !== "Pickup" || session.diningState !== "ContextOnly") return unavailable();
    return session;
  }
  async function finish(
    operationReference: string,
    sessionCredential: GuestRawCredential,
    csrfCredential: GuestRawCredential,
  ) {
    const session = await authorize(sessionCredential, csrfCredential);
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
        "targetReference",
        "sessionReference",
        "brandReference",
        "storeReference",
        "activatedAt",
      ],
    );
    if (
      result.operationReference !== operationReference ||
      result.sessionReference !== session.sessionReference ||
      result.brandReference !== session.brandReference ||
      result.storeReference !== session.storeReference ||
      parseCanonicalInstant(result.activatedAt) > at ||
      parseCanonicalInstant(result.activatedAt) < session.createdAt
    )
      return unavailable();
    const receipt: GuestBindingCompletion = Object.freeze({
      operationReference,
      targetReference: uuid(result.targetReference),
      sessionReference: session.sessionReference,
      brandReference: session.brandReference,
      storeReference: session.storeReference,
      activatedAt: parseCanonicalInstant(result.activatedAt),
    });
    if ((await options.owner.activate(receipt)) !== "Activated") return unavailable();
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
        ]);
        const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
        const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
        const operationReference = parseGuestOperationReference(raw.operationReference);
        const session = await authorize(sessionCredential, csrfCredential);
        const predecessor = createGuestSessionRecord(
          await options.sessions.resolve(sessionHash(sessionCredential)),
        );
        if (
          JSON.stringify(predecessor.session) !== JSON.stringify(session) ||
          !options.credentials.equals(
            predecessor.sessionSelectorHash,
            sessionHash(sessionCredential),
          ) ||
          !options.credentials.equals(predecessor.csrfSelectorHash, csrfHash(csrfCredential))
        )
          return unavailable();
        const target = readClosedRecord(
          await options.owner.reserveTarget({ operationReference, session, observedAt: now() }),
          [
            "operationReference",
            "targetReference",
            "sessionReference",
            "brandReference",
            "storeReference",
            "expectedVersion",
            "validUntil",
          ],
        );
        if (
          target.operationReference !== operationReference ||
          target.sessionReference !== session.sessionReference ||
          target.brandReference !== session.brandReference ||
          target.storeReference !== session.storeReference ||
          target.expectedVersion !== session.version
        )
          return unavailable();
        const targetReference = uuid(target.targetReference);
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
              purpose: "PickupCartBinding",
              operationReference,
              predecessor: session.sessionReference,
              version: session.version,
              brand: session.brandReference,
              store: session.storeReference,
              targetReference,
            }),
          ),
        });
        const preparation = prepareGuestBinding({
          operationReference,
          targetReference,
          predecessor,
          candidate,
          recoverySelectorHash: options.recovery.hash(recoveryProof),
          preparedAt,
          expiresAt,
        });
        const saved = parseGuestBindingPreparation(
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
        const session = await authorize(sessionCredential, csrfCredential);
        const acknowledged = parseGuestBindingPreparation(
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
          acknowledged.operationReference !== operationReference ||
          JSON.stringify(acknowledged.predecessor.session) !== JSON.stringify(session) ||
          !options.credentials.equals(
            acknowledged.predecessor.sessionSelectorHash,
            sessionHash(sessionCredential),
          ) ||
          !options.credentials.equals(
            acknowledged.candidate.sessionSelectorHash,
            proof.sessionSelectorHash,
          ) ||
          !options.credentials.equals(
            acknowledged.candidate.csrfSelectorHash,
            proof.csrfSelectorHash,
          ) ||
          !options.credentials.equals(acknowledged.recoverySelectorHash, proof.recoverySelectorHash)
        )
          return unavailable();
        const ownerEvidence = await options.owner.prepare(
          Object.freeze({
            operationReference,
            targetReference: acknowledged.targetReference,
            sessionReference: acknowledged.candidate.session.sessionReference,
            predecessorSessionReference: session.sessionReference,
            brandReference: session.brandReference,
            storeReference: session.storeReference,
            acknowledgedAt: acknowledged.acknowledgedAt,
            validUntil: acknowledged.expiresAt,
            observedAt: now(),
          }),
        );
        if (ownerEvidence === null) return unavailable();
        const at = now();
        const activated = parseGuestBindingPreparation(
          await options.bindings.activate({
            operationReference,
            currentSelectorHash: sessionHash(sessionCredential),
            proof,
            ownerEvidence,
            observedAt: at,
          }),
        );
        if (
          activated.status !== "Activated" ||
          activated.activatedAt !== at ||
          JSON.stringify({
            ...activated,
            status: acknowledged.status,
            revision: acknowledged.revision,
            activatedAt: null,
          }) !== JSON.stringify(acknowledged)
        )
          return unavailable();
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
