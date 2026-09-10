import {
  createGuestSession,
  GuestSessionService,
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  parseGuestOperationReference,
  readClosedRecord,
  type GuestSession,
  type GuestSessionServiceOptions,
  type CanonicalInstant,
} from "@bop/identity";
import {
  assertCurrentDiningGuestTableContext,
  createDiningSessionService,
  parseDiningIdentityAdmission,
  parseDiningReference,
  type DiningSessionPorts,
  type QrTableContextEvidence,
} from "@rms/dining";

export interface CustomerDiningJoinCompositionOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly session: Pick<GuestSessionServiceOptions, "store" | "credentials" | "binding">;
  readonly dining: {
    readonly store: Pick<
      DiningSessionPorts["store"],
      "resolveJoinState" | "resolveJoinOperation" | "join"
    >;
    readonly credentials: Pick<
      DiningSessionPorts["credentials"],
      "generateReference" | "hashJoinCredential" | "hashOperationIntent" | "equals"
    >;
    readonly pepperVersion: number;
  };
  readonly contexts: {
    resolve(input: {
      readonly session: GuestSession;
      readonly observedAt: CanonicalInstant;
      readonly purpose: "DiningJoin";
    }): Promise<QrTableContextEvidence | null>;
  };
  readonly now: () => unknown;
}
export interface CustomerDiningJoinRequestContext {
  /** Trusted server port bound to this request's canonical abuse context; never taken from JSON. */
  readonly abuse: DiningSessionPorts["abuse"];
}
function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}

/** Composition only. Identity authenticates; Dining owns context, abuse, Join and atomic effects. */
export function createCustomerDiningJoinComposition(options: CustomerDiningJoinCompositionOptions) {
  const rawScope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: String(parseDiningReference(rawScope.brandReference)),
    storeReference: String(parseDiningReference(rawScope.storeReference)),
  });
  const now = () => parseCanonicalInstant(options.now());
  const authorization = new GuestSessionService({
    ...options.session,
    admission: { consume: async () => null },
    now,
  });
  return Object.freeze({
    async join(input: unknown, request: CustomerDiningJoinRequestContext) {
      try {
        const raw = readClosedRecord(input, [
          "sessionCredential",
          "csrfCredential",
          "joinCredential",
          "operationReference",
        ]);
        const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
        const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
        const operationReference = parseGuestOperationReference(raw.operationReference);
        const joinCredential = raw.joinCredential;
        if (typeof joinCredential !== "string") return unavailable();
        const admit = request.abuse.admit.bind(request.abuse);
        const observedAt = now();
        const authorize = async (instant: CanonicalInstant) => {
          const session = createGuestSession(
            await authorization.authorize({
              sessionCredential,
              csrfCredential,
              observedAt: instant,
            }),
          );
          if (
            session.brandReference !== scope.brandReference ||
            session.storeReference !== scope.storeReference ||
            session.channel !== "DineIn" ||
            session.diningState !== "ContextOnly" ||
            session.publicTableReference === null
          )
            return unavailable();
          return session;
        };
        const contextFor = async (session: GuestSession, instant: CanonicalInstant) =>
          assertCurrentDiningGuestTableContext(
            {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              publicStoreReference: session.publicStoreReference,
              publicTableReference: session.publicTableReference,
              channel: session.channel,
              qrRevocationVersion: session.qrRevocationVersion,
              observedAt: instant,
            },
            await options.contexts.resolve(
              Object.freeze({ session, observedAt: instant, purpose: "DiningJoin" }),
            ),
          );
        const initial = await authorize(observedAt);
        await contextFor(initial, observedAt);
        const current = async (guestReference: string, instant: CanonicalInstant) => {
          if (guestReference !== initial.sessionReference) return unavailable();
          const session = await authorize(instant);
          if (JSON.stringify(session) !== JSON.stringify(initial)) return unavailable();
          const context = await contextFor(session, instant);
          return Object.freeze({ session, context });
        };
        const owner = createDiningSessionService({
          pepperVersion: options.dining.pepperVersion,
          credentials: { ...options.dining.credentials, generateJoinCredential: unavailable },
          staff: { authorize: async () => null },
          abuse: { admit },
          guests: {
            async resolve(value) {
              const evidence = await current(
                value.guestSessionReference,
                parseCanonicalInstant(value.observedAt),
              );
              return {
                guestSessionReference: value.guestSessionReference,
                diningState: "ContextOnly",
                channel: "DineIn",
                storeReference: parseDiningReference(scope.storeReference),
                tableReference: parseDiningReference(evidence.context.tableReference),
                observedAt: value.observedAt,
              };
            },
          },
          store: {
            ...options.dining.store,
            resolveStartOperation: async () => null,
            start: async () => unavailable(),
            resolveActiveJoin: async () => null,
            resolveRegenerationOperation: async () => null,
            regenerate: async () => unavailable(),
          },
        });
        const result = await owner.joinCurrent({
          guestSessionReference: initial.sessionReference,
          joinCredential,
          operationReference,
          requestedAt: now(),
        });
        if (result.status === "DiningJoinUnavailable") return unavailable();
        const admission = parseDiningIdentityAdmission(result.admission);
        const latest = await current(initial.sessionReference, now());
        if (
          admission.operationReference !== String(operationReference) ||
          admission.storeReference !== scope.storeReference ||
          admission.tableReference !== parseDiningReference(latest.context.tableReference)
        )
          return unavailable();
        return Object.freeze({
          status: "Joined" as const,
          operationReference,
          admissionReference: String(admission.admissionReference),
        });
      } catch {
        return unavailable();
      }
    },
  });
}
