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
  type DiningGuestTableStartResult,
  type DiningQrJoinIssueResult,
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
  /**
   * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN: while the scanned table is open, Dining issues the
   * Session's next one-time code for this guest, and the ordinary Join below consumes it.
   * `authorize` re-checks, inside the owner's transaction, that the guest is still the scanned,
   * not-yet-joined guest at this table.
   */
  readonly qr?: {
    issue(
      input: {
        readonly guestSessionReference: string;
        readonly tableReference: string;
        readonly observedAt: string;
      },
      authorize: () => Promise<boolean>,
    ): Promise<DiningQrJoinIssueResult>;
    /**
     * WP-2423 DEC-DINING-GUEST-TABLE-START: the table turned out not to be open; a guest may start
     * it where the Store allows. Commits on its own, because the next issue re-reads the table on
     * another connection.
     */
    startIfFree?(input: {
      readonly guestSessionReference: string;
      readonly tableReference: string;
      /** The Session this guest just ended by saying they weren't with the people there. */
      readonly endedSessionReference?: string;
    }): Promise<DiningGuestTableStartResult>;
    /** The guest said they aren't with the people at this table: the System closes it if it may. */
    closeForNewParty?(input: {
      readonly tableReference: string;
    }): Promise<
      | { readonly status: "Closed"; readonly diningSessionReference: string }
      | { readonly status: "Held"; readonly hold: string }
    >;
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
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const mine = (turns.get(key) ?? Promise.resolve()).then(work, work);
    const tail = mine.catch(() => undefined);
    turns.set(key, tail);
    try {
      return await mine;
    } finally {
      if (turns.get(key) === tail) turns.delete(key);
    }
  };
  return Object.freeze({
    async join(input: unknown, request: CustomerDiningJoinRequestContext) {
      try {
        const byQr =
          input !== null && typeof input === "object" && !Object.hasOwn(input, "joinCredential");
        const raw = readClosedRecord(
          input,
          byQr
            ? [
                "sessionCredential",
                "csrfCredential",
                "operationReference",
                ...(Object.hasOwn(input as object, "newParty") ? ["newParty"] : []),
              ]
            : ["sessionCredential", "csrfCredential", "joinCredential", "operationReference"],
        );
        if (raw.newParty !== undefined && raw.newParty !== true) return unavailable();
        const newParty = raw.newParty === true;
        const sessionCredential = parseGuestRawCredential(raw.sessionCredential);
        const csrfCredential = parseGuestRawCredential(raw.csrfCredential);
        const operationReference = parseGuestOperationReference(raw.operationReference);
        const qr = options.qr;
        if (byQr && qr === undefined) return unavailable();
        if (!byQr && typeof raw.joinCredential !== "string") return unavailable();
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
        // A phone reading the table just as another phone of its party starts it reads with an
        // instant before that start; a fresh instant answers it (bounded).
        const freshly = async <T>(work: (instant: CanonicalInstant) => Promise<T>): Promise<T> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              return await work(now());
            } catch {
              // Tried again below; a lasting failure answers on the last try.
            }
          }
          return work(now());
        };
        if (byQr) await freshly((instant) => contextFor(initial, instant));
        else await contextFor(initial, observedAt);
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
        const joinWith = (joinCredential: string) =>
          owner.joinCurrent({
            guestSessionReference: initial.sessionReference,
            joinCredential,
            operationReference,
            requestedAt: now(),
          });
        let result: Awaited<ReturnType<typeof joinWith>> | null = null;
        if (byQr && qr !== undefined) {
          const table = await freshly((instant) => current(initial.sessionReference, instant));
          // Phones of one party scan together, and each QR join replaces the code the last one was
          // issued: one at a time per table, so they don't spend each other's attempts or the
          // table's join budget. The retries below are what's left for a second process.
          const refusal = await inTurn(String(table.context.tableReference), async () => {
            // Another phone scanning at the same moment replaces the code just issued; the join
            // then refuses it without writing anything, so issue again (bounded).
            let askedToClose = false;
            let endedSessionReference: string | undefined;
            const attempts = 6;
            for (let attempt = 0; attempt < attempts; attempt += 1) {
              // Fresh on every attempt: a start commits with its own instant under the table's
              // lock, and an earlier instant here could precede it.
              const at = now();
              const evidence = await freshly((instant) =>
                current(initial.sessionReference, instant),
              );
              const tableReference = String(parseDiningReference(evidence.context.tableReference));
              if (newParty && !askedToClose && qr.closeForNewParty !== undefined) {
                askedToClose = true;
                const closed = await qr.closeForNewParty({ tableReference });
                if (closed.status === "Closed")
                  endedSessionReference = closed.diningSessionReference;
                // Nobody's table to end any more (the System just freed it): this phone goes on.
                else if (closed.hold === "Paused") return "Paused" as const;
                else if (closed.hold === "Budget") return "TooManyJoins" as const;
                else if (closed.hold !== "Changed") return "TableInUse" as const;
              }
              const issued = await qr.issue(
                {
                  guestSessionReference: String(initial.sessionReference),
                  tableReference,
                  observedAt: String(at),
                },
                async () => {
                  try {
                    const again = await freshly((instant) =>
                      current(initial.sessionReference, instant),
                    );
                    return again.context.tableReference === evidence.context.tableReference;
                  } catch {
                    return false;
                  }
                },
              );
              // No table open: a guest may start it where the Store allows, then this repeats. An
              // open table never comes here, so an ordinary join costs nothing extra at any Store.
              if (
                issued.status === "Refused" &&
                issued.reason === "NotOpen" &&
                qr.startIfFree !== undefined
              ) {
                const started = await qr.startIfFree({
                  guestSessionReference: String(initial.sessionReference),
                  tableReference,
                  ...(endedSessionReference === undefined ? {} : { endedSessionReference }),
                });
                if (started.status === "Started" || started.status === "AlreadyOpen") continue;
                if (started.status === "Busy") return "TooManyJoins" as const;
                if (started.status === "BeingCleaned") return "BeingCleaned" as const;
              }
              if (issued.status === "Refused") return issued.reason;
              // A join that lost a race wrote nothing, and its next attempt reads the new versions.
              try {
                result = await joinWith(String(issued.joinCredential));
              } catch (error) {
                if (attempt === attempts - 1) throw error;
                continue;
              }
              if (
                !(result.status === "DiningJoinRefused" && result.reason === "CodeNotAccepted") &&
                result.status !== "DiningJoinUnavailable"
              )
                break;
            }
            return null;
          });
          if (refusal !== null)
            return Object.freeze({ status: "Refused" as const, reason: refusal });
        } else result = await joinWith(raw.joinCredential as string);
        // Assigned inside the turn above, which TypeScript can't follow.
        result = result as Awaited<ReturnType<typeof joinWith>> | null;
        if (result === null) return unavailable();
        // A definitive Dining refusal wrote nothing; the Guest needs a new code, not a retry.
        if (result.status === "DiningJoinRefused")
          return Object.freeze({ status: "Refused" as const, reason: result.reason });
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
