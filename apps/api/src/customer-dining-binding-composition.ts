import {
  createGuestDiningBindingService,
  createGuestSession,
  GuestSessionService,
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestDiningAdmissionEvidence,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
  type GuestRawCredential,
  type CanonicalInstant,
  type GuestSessionServiceOptions,
  type GuestDiningBindingServiceOptions,
  type GuestDiningBindingStorePort,
} from "@bop/identity";
import {
  assertCurrentDiningGuestTableContext,
  createDiningAdmissionConsumptionService,
  createDiningGuestBindingQuery,
  type DiningGuestBindingOptions,
  parseDiningReference,
  type QrTableContextEvidence,
  type DiningAdmissionConsumptionPorts,
} from "@rms/dining";

export interface CustomerDiningBindingCompositionOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly session: Pick<GuestSessionServiceOptions, "store" | "binding" | "credentials">;
  readonly bindings: GuestDiningBindingStorePort;
  readonly dining: Pick<DiningAdmissionConsumptionPorts, "store" | "credentials"> & {
    readonly binding: DiningGuestBindingOptions["repository"];
  };
  readonly contexts: {
    /** Current owner evidence for this authenticated Session; no signed payload is fabricated. */
    resolve(input: {
      readonly session: GuestSession;
      readonly observedAt: CanonicalInstant;
      readonly purpose: "DiningAdmission";
    }): Promise<QrTableContextEvidence | null>;
  };
  readonly recovery: GuestDiningBindingServiceOptions["recovery"];
  readonly preparationLifetimeSeconds: number;
  readonly now: () => unknown;
}

function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}

/** Composition only: owners authorize, validate context, reserve, consume and atomically bind. */
export function createCustomerDiningBindingComposition(
  options: CustomerDiningBindingCompositionOptions,
) {
  const rawScope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: String(parseDiningReference(rawScope.brandReference)),
    storeReference: String(parseDiningReference(rawScope.storeReference)),
  });
  const now = () => parseCanonicalInstant(options.now());
  const contextInput = (session: GuestSession, observedAt: CanonicalInstant) => ({
    brandReference: session.brandReference,
    storeReference: session.storeReference,
    publicStoreReference: session.publicStoreReference,
    publicTableReference: session.publicTableReference,
    channel: session.channel,
    qrRevocationVersion: session.qrRevocationVersion,
    observedAt,
  });
  async function contextFor(session: GuestSession, observedAt: CanonicalInstant) {
    if (
      session.brandReference !== scope.brandReference ||
      session.storeReference !== scope.storeReference
    )
      return unavailable();
    return assertCurrentDiningGuestTableContext(
      contextInput(session, observedAt),
      await options.contexts.resolve(
        Object.freeze({ session, observedAt, purpose: "DiningAdmission" }),
      ),
    );
  }
  const authorization = new GuestSessionService({
    ...options.session,
    admission: { consume: async () => null },
    now,
    binding: {
      async validate(session, observedAt) {
        try {
          if ((await options.session.binding.validate(session, observedAt)) !== "Current")
            return "Unavailable";
          if (session.diningState === "ContextOnly") return "Current";
          const context = await contextFor(session, observedAt);
          const current = await createDiningGuestBindingQuery({
            scope,
            repository: options.dining.binding,
            now,
          }).resolve({
            purpose: "GuestSessionBinding",
            diningSessionReference: session.diningSessionReference,
            participantReference: session.diningParticipantReference,
            tableReference: context.tableReference,
          });
          assertCurrentDiningGuestTableContext(contextInput(session, now()), context);
          return current === null ? "Unavailable" : "Current";
        } catch {
          return "Unavailable";
        }
      },
    },
  });
  function invocation() {
    // Never share the authenticated request's credentials or context with another invocation.
    let authenticated: {
      session: GuestSession;
      sessionCredential: GuestRawCredential;
      csrfCredential: GuestRawCredential;
    } | null = null;
    async function current(guestSessionReference: string, observedAt: CanonicalInstant) {
      const captured = authenticated;
      if (captured === null || captured.session.sessionReference !== guestSessionReference)
        return unavailable();
      const session = createGuestSession(
        await authorization.authorize({
          sessionCredential: captured.sessionCredential,
          csrfCredential: captured.csrfCredential,
          observedAt,
        }),
      );
      if (
        JSON.stringify(session) !== JSON.stringify(captured.session) ||
        session.diningState !== "ContextOnly" ||
        session.brandReference !== scope.brandReference ||
        session.storeReference !== scope.storeReference
      )
        return unavailable();
      const context = await contextFor(session, observedAt);
      return Object.freeze({ session, context });
    }
    function owner() {
      let observation: Awaited<ReturnType<typeof current>> | null = null;
      const service = createDiningAdmissionConsumptionService({
        scope,
        store: options.dining.store,
        credentials: options.dining.credentials,
        guests: {
          async resolve(input) {
            observation = await current(
              input.guestSessionReference,
              parseCanonicalInstant(input.observedAt),
            );
            return Object.freeze({
              guestSessionReference: input.guestSessionReference,
              diningState: "ContextOnly" as const,
              channel: "DineIn" as const,
              storeReference: parseDiningReference(observation.session.storeReference),
              tableReference: parseDiningReference(observation.context.tableReference),
              observedAt: input.observedAt,
            });
          },
        },
      });
      return { service, observed: () => observation ?? unavailable() };
    }
    return createGuestDiningBindingService({
      authorization: {
        async authorize(input) {
          const sessionCredential = parseGuestRawCredential(input.sessionCredential);
          const csrfCredential = parseGuestRawCredential(input.csrfCredential);
          const session = createGuestSession(await authorization.authorize(input));
          if (
            session.brandReference !== scope.brandReference ||
            session.storeReference !== scope.storeReference
          )
            return unavailable();
          authenticated = Object.freeze({ session, sessionCredential, csrfCredential });
          return session;
        },
      },
      sessions: options.session.store,
      bindings: options.bindings,
      credentials: options.session.credentials,
      recovery: options.recovery,
      preparationLifetimeSeconds: options.preparationLifetimeSeconds,
      now,
      owner: {
        async reserveAdmission(input) {
          const call = owner();
          const result = await call.service.reserve({
            guestSessionReference: input.session.sessionReference,
            admissionReference: input.admissionReference,
            operationReference: input.operationReference,
            requestedAt: input.observedAt,
          });
          const { session, context } = call.observed();
          if (
            JSON.stringify(session) !== JSON.stringify(input.session) ||
            result.tableReference !== String(context.tableReference)
          )
            return unavailable();
          return Object.freeze({
            operationReference: result.operationReference,
            admissionReference: result.admissionReference,
            guestSessionReference: result.guestSessionReference,
            brandReference: result.brandReference,
            storeReference: result.storeReference,
            publicTableReference: String(context.publicTableReference),
            diningSessionReference: result.diningSessionReference,
            diningParticipantReference: result.participantReference,
            expectedGuestVersion: session.version,
            evaluatedAt: parseCanonicalInstant(result.evaluatedAt),
            validUntil: parseCanonicalInstant(context.validUntil),
          });
        },
        async consume(input) {
          const call = owner();
          const result = await call.service.consume(input);
          const observedAt = now();
          const { context } = await current(input.guestSessionReference, observedAt);
          const admission = result.record.admission;
          if (admission.tableReference !== String(context.tableReference)) return unavailable();
          return parseGuestDiningAdmissionEvidence({
            decision: "Allowed",
            guestSessionReference: result.record.guestSessionReference,
            admissionReference: admission.admissionReference,
            operationReference: result.record.operationReference,
            storeReference: admission.storeReference,
            publicTableReference: context.publicTableReference,
            diningSessionReference: admission.diningSessionReference,
            diningParticipantReference: admission.participantReference,
            evaluatedAt: observedAt,
            validUntil: context.validUntil,
          });
        },
      },
    });
  }
  // Validate owner-independent configuration at construction; acquire no resource or credential.
  invocation();
  return Object.freeze({
    prepare: (input: unknown) => invocation().prepare(input),
    activate: (input: unknown) => invocation().activate(input),
    complete: (input: unknown) => invocation().complete(input),
  });
}
