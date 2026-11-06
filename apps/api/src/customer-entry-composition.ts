import {
  GuestSessionService,
  guestSessionCookie,
  parseCanonicalInstant,
  parseGuestAdmissionEvidence,
  parseGuestEntryRequestReference,
  parseGuestOperationReference,
  type GuestAdmissionEvidence,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import {
  createQrTableContextService,
  parseQrTableContextEvidence,
  type QrTableContext,
  type QrTableContextEvidence,
  type QrTableContextPorts,
} from "@rms/dining";
import {
  createPublicStoreProfileService,
  createStoreOperatingStatusService,
  type PublicStoreProfilePorts,
  type StoreOperatingStatusPorts,
  type StoreOperatingStatus,
  type StoreUpcomingHours,
} from "@rms/store";
import type { CustomerEntryPort, CustomerEntryPortInput } from "./customer-entry.js";

export interface CustomerEntryAdmissionInput extends Omit<CustomerEntryPortInput, "qrToken"> {
  readonly context: QrTableContext;
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
}

export interface CustomerEntryOperatingReader {
  readCurrent(input: {
    brandReference: string;
    storeReference: string;
    publicStoreReference: string;
    evaluatedAt: string;
  }): Promise<
    | (Pick<StoreOperatingStatus, "state" | "availableServiceModes"> & {
        brandReference: string;
        storeReference: string;
        evaluatedAt: string;
        /** WP-2423 Q4: today's published hours, when the reader provides them. */
        todayHours?: readonly {
          startLocalTime: string;
          endLocalTime: string;
          endsNextDay: boolean;
        }[];
        /** The Store's local time ("HH:MM:SS") at `evaluatedAt`, when the reader provides it. */
        localTime?: string;
        /** The Store's local date at `evaluatedAt`, when the reader provides it. */
        localDate?: string;
        /** WP-2423 item 8 ③ (decision 16): holidays, last orders and the next opening. */
        upcomingHours?: StoreUpcomingHours;
        /** WP-2423 item 8 ⑦ 1b: services the Store turned off (never offered, whatever the hour). */
        servicesTurnedOff?: readonly "Pickup"[];
        /** WP-2423 item 11: this Store isn't ready to take orders yet (not a closing time). */
        notReadyForOrders?: boolean;
        /** WP-2423 item 13 ②: the platform paused this merchant's new guests. */
        newGuestsPaused?: boolean;
        /** WP-2423 store-service-controls (v15 M30): paused services and when each resumes. */
        pausedModes?: readonly { readonly mode: string; readonly until: string }[];
      })
    | null
  >;
}

export interface CustomerEntryCompositionOptions {
  readonly qr: QrTableContextPorts;
  readonly profile: PublicStoreProfilePorts;
  readonly operating: StoreOperatingStatusPorts;
  // The environment must atomically consume this request's proof and apply its abuse policy.
  readonly admission: {
    consume(input: CustomerEntryAdmissionInput): Promise<GuestAdmissionEvidence | null>;
  };
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "store" | "credentials">;
  /** Coordinator 2026-10-30: the scanned table's public state (a party seated there or not). */
  readonly table?: CustomerEntryTableReader;
}

export interface CustomerEntryTableReader {
  isOpen(input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly tableReference: string;
  }): Promise<boolean>;
  /**
   * WP-2423 DEC-DINING-GUEST-TABLE-START: at a free table, what a guest may do by scanning it. Absent
   * or failed: nothing new (the table isn't open, as before).
   */
  guestStart?(input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly tableReference: string;
    readonly at: string;
  }): Promise<"MayStart" | "BeingCleaned" | "No">;
  /** At an open table a guest started: whether this phone is asked if it is with those guests. */
  asksNewParty?(input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly tableReference: string;
  }): Promise<boolean>;
}

const unavailable = Object.freeze({ status: "EntryUnavailable" } as const);

/** At most this many earlier visits are kept on a phone besides its current one. */
export const customerEntryEarlierVisitLimit = 2;
interface PresentedVisit {
  readonly source: "Current" | "Earlier";
  readonly credential: string;
  readonly result: Awaited<ReturnType<GuestSessionService["resumeForEntry"]>>;
}
async function presentedVisits(
  session: CustomerEntryCompositionOptions["session"],
  input: CustomerEntryPortInput,
  observedAt: string,
): Promise<readonly PresentedVisit[]> {
  const presented = input.presentedCredentials ?? [];
  if (presented.length === 0) return [];
  const identity = new GuestSessionService({
    ...session,
    admission: { consume: async () => null },
  });
  const visits: PresentedVisit[] = [];
  for (const { source, credential } of presented) {
    try {
      visits.push({
        source,
        credential,
        result: await identity.resumeForEntry({ sessionCredential: credential, observedAt }),
      });
    } catch (error) {
      // The store could not say: a retry, never a new visit that would replace this one.
      if ((error as { dependencyFailure?: unknown }).dependencyFailure === true)
        throw new CustomerEntryServiceUnavailableError();
      visits.push({ source, credential, result: Object.freeze({ status: "Unknown" as const }) });
    }
  }
  return visits;
}
/** Renews the one visit an entry resumes; a store that can't answer is a retry. */
async function renewResumed(
  session: CustomerEntryCompositionOptions["session"],
  credential: string,
  observedAt: string,
): Promise<PresentedVisit["result"]> {
  try {
    return await new GuestSessionService({
      ...session,
      admission: { consume: async () => null },
    }).resumeForEntry({ sessionCredential: credential, activity: "Interactive", observedAt });
  } catch (error) {
    if ((error as { dependencyFailure?: unknown }).dependencyFailure === true)
      throw new CustomerEntryServiceUnavailableError();
    return Object.freeze({ status: "Unknown" as const });
  }
}
/**
 * The earlier visits kept on the phone: one it can go on with, one whose receipts can still be
 * read, and one this Store can't see (it may be another Store's); never one that has fully ended.
 */
function keptCredentials(visits: readonly PresentedVisit[]): string[] {
  const kept: string[] = [];
  for (const visit of visits) {
    const worth =
      visit.result.status === "Usable" ||
      visit.result.status === "Unknown" ||
      (visit.result.status === "Ended" && visit.result.receiptsReadable);
    if (worth && !kept.includes(visit.credential)) kept.push(visit.credential);
  }
  return kept.slice(0, customerEntryEarlierVisitLimit);
}

/**
 * WP-2423: the database could not answer a read Entry needs (a lost connection, a timeout, a missing
 * grant). It is an outage, so the guest is asked to retry (503), never told the code is unusable.
 * The failure that caused it is kept, non-enumerable, for the request log's safe failure code only.
 */
export class CustomerEntryServiceUnavailableError extends Error {
  readonly code = "CUSTOMER_ENTRY_SERVICE_UNAVAILABLE";
  constructor() {
    super("CUSTOMER_ENTRY_SERVICE_UNAVAILABLE");
    this.name = "CustomerEntryServiceUnavailableError";
  }
}

export function createCustomerEntryComposition(
  options:
    | CustomerEntryCompositionOptions
    | (Omit<CustomerEntryCompositionOptions, "operating"> & {
        operatingReader: CustomerEntryOperatingReader;
      }),
): CustomerEntryPort {
  return Object.freeze({
    async establish(input: CustomerEntryPortInput) {
      try {
        const entryRequestReference = parseGuestEntryRequestReference(input.entryRequestReference);
        const operationReference = parseGuestOperationReference(input.operationReference);
        const requestedAt = parseCanonicalInstant(input.requestedAt);
        if (String(entryRequestReference) === String(operationReference)) return unavailable;

        // Capture only within this invocation, then let Dining validate the complete QR context.
        const captured: { evidence: QrTableContextEvidence | null } = { evidence: null };
        const qrService = createQrTableContextService({
          ...options.qr,
          contexts: {
            async resolve(payload) {
              const raw = await options.qr.contexts.resolve(payload);
              if (raw === null) return null;
              captured.evidence = parseQrTableContextEvidence(raw);
              return captured.evidence;
            },
          },
        });
        const qr = await qrService.resolveQrTableContext({
          qrToken: input.qrToken,
          evaluatedAt: requestedAt,
          purpose: "CustomerEntry",
        });
        if (qr.status !== "Verified" || captured.evidence === null) return unavailable;
        const evidence = captured.evidence;
        const scope = Object.freeze({
          brandReference: String(evidence.brandReference),
          storeReference: String(evidence.storeReference),
        });
        const sameScope = (value: { brandReference: string; storeReference: string }) =>
          value.brandReference === scope.brandReference &&
          value.storeReference === scope.storeReference;
        const query = {
          publicStoreReference: qr.context.publicStoreReference,
          evaluatedAt: requestedAt,
          purpose: "CustomerEntry" as const,
        };
        const profile = await createPublicStoreProfileService({
          ...options.profile,
          resolution: {
            async resolve(request) {
              const resolved = await options.profile.resolution.resolve(request);
              return resolved !== null && sameScope(resolved) ? resolved : null;
            },
          },
        }).getPublicStore({ ...query, requestedLocale: qr.context.locale });
        if (profile.status !== "Available") return unavailable;
        // M104/M105: what each credential this phone presented is to this Store, read before the
        // Store's hours and pause (an existing visit finishes as usual; only a new one is refused).
        const visits = await presentedVisits(options.session, input, requestedAt);
        const publicContextFor = () => ({
          brandDisplayName: profile.profile.brandDisplayName,
          storeDisplayName: profile.profile.storeDisplayName,
          publicStoreReference: String(qr.context.publicStoreReference),
          locale: String(qr.context.locale),
        });
        // A pickup code scanned again at the Store this phone already has a pickup visit at goes
        // on with that visit: the same cart, orders, receipts and pickup codes, no new visit.
        const resumable =
          qr.context.channel === "Pickup" && input.intent === undefined
            ? visits.find(
                (visit) =>
                  visit.result.status === "Usable" &&
                  sameScope(visit.result.session) &&
                  String(visit.result.session.publicStoreReference) ===
                    String(qr.context.publicStoreReference) &&
                  visit.result.session.channel === "Pickup" &&
                  visit.result.session.publicTableReference === null,
              )
            : undefined;
        let operatingStatus: Pick<StoreOperatingStatus, "state" | "availableServiceModes">;
        let todayHours: readonly {
          startLocalTime: string;
          endLocalTime: string;
          endsNextDay: boolean;
        }[] = [];
        let upcoming: StoreUpcomingHours | null = null;
        let localDate: string | null = null;
        let turnedOff: readonly string[] = [];
        let notReady = false;
        let newGuestsPaused = false;
        if ("operatingReader" in options) {
          const current = await options.operatingReader.readCurrent({
            ...scope,
            publicStoreReference: query.publicStoreReference,
            evaluatedAt: requestedAt,
          });
          if (!current || !sameScope(current) || current.evaluatedAt !== requestedAt)
            return unavailable;
          operatingStatus = current;
          todayHours = current.todayHours ?? [];
          upcoming = current.upcomingHours ?? null;
          localDate = current.localDate ?? null;
          turnedOff = current.servicesTurnedOff ?? [];
          notReady = current.notReadyForOrders === true;
          newGuestsPaused = current.newGuestsPaused === true;
        } else {
          const operating = await createStoreOperatingStatusService({
            ...options.operating,
            resolution: {
              async resolve(request) {
                const resolved = await options.operating.resolution.resolve(request);
                return resolved !== null && sameScope(resolved) ? resolved : null;
              },
            },
          }).getStoreOperatingStatus(query);
          if (operating.status !== "Available") return unavailable;
          operatingStatus = operating.operatingStatus;
        }
        // Only the visit resumed is renewed, as any interactive use is; earlier visits the phone
        // presented were read without extending them.
        const renewed =
          resumable !== undefined && resumable.result.status === "Usable"
            ? await renewResumed(options.session, resumable.credential, requestedAt)
            : null;
        if (resumable !== undefined && renewed !== null && renewed.status === "Usable") {
          const session = renewed.session;
          return Object.freeze({
            status: "Established" as const,
            ...publicContextFor(),
            publicTableReference: null,
            channel: "Pickup" as const,
            operatingState: operatingStatus.state,
            availableServiceModes: operatingStatus.availableServiceModes,
            contextExpiresAt: new Date(
              Math.min(
                Date.parse(qr.context.expiresAt),
                Date.parse(evidence.validUntil),
                Date.parse(session.idleExpiresAt),
                Date.parse(session.absoluteExpiresAt),
              ),
            ).toISOString(),
            sessionCredential: resumable.credential as never,
            csrfCredential: renewed.csrfCredential,
            cookie: guestSessionCookie,
            resumed: true as const,
            earlierCredentials: Object.freeze(
              keptCredentials(visits.filter((visit) => visit !== resumable)),
            ),
          });
        }
        // WP-2423 item 8 ⑦ 1b: a pickup code at a Store that turned pickup off.
        if (turnedOff.includes(qr.context.channel))
          return Object.freeze({
            status: "ServiceNotOffered" as const,
            storeDisplayName: profile.profile.storeDisplayName,
          });
        if (
          operatingStatus.state !== "Open" ||
          !operatingStatus.availableServiceModes.includes(qr.context.channel)
        )
          return Object.freeze({
            status: "NotAccepting" as const,
            storeDisplayName: profile.profile.storeDisplayName,
            operatingState: operatingStatus.state,
            todayHours,
            todayKind: upcoming?.todayKind ?? null,
            nextOpening: upcoming?.nextOpening ?? null,
            localDate,
            // M116: closed for the night or paused, the guest can still look at the menu. A Store
            // not ready for orders yet has no menu to show.
            ...(notReady
              ? { notReadyForOrders: true as const }
              : {
                  browse: Object.freeze({
                    brandDisplayName: profile.profile.brandDisplayName,
                    publicStoreReference: String(qr.context.publicStoreReference),
                    locale: String(qr.context.locale),
                    channel: qr.context.channel,
                  }),
                }),
          });

        // Coordinator 2026-10-30: at a table, whether a party is seated there now (public state).
        let tableOpen: boolean | undefined;
        const tableReference = evidence.tableReference;
        if (
          options.table !== undefined &&
          qr.context.channel === "DineIn" &&
          tableReference !== null &&
          tableReference !== undefined
        ) {
          tableOpen = await options.table
            .isOpen({ ...scope, tableReference: String(tableReference) })
            .catch(() => undefined);
        }
        // WP-2423 item 13 ② (Owner 2026-11-05): while the platform has paused this merchant, no new
        // visit starts (a pickup code, a free table, a guest-started table). A phone joining a party
        // already seated is part of that visit, so it still enters and the party finishes as usual;
        // a new party at that table ("NewParty") is a new visit.
        if (
          newGuestsPaused &&
          !(qr.context.channel === "DineIn" && tableOpen === true && input.intent !== "NewParty")
        )
          return Object.freeze({
            status: "NotAccepting" as const,
            storeDisplayName: profile.profile.storeDisplayName,
            operatingState: operatingStatus.state,
            todayHours,
            todayKind: upcoming?.todayKind ?? null,
            nextOpening: upcoming?.nextOpening ?? null,
            localDate,
            newGuestsPaused: true as const,
          });
        const publicContext = {
          brandDisplayName: profile.profile.brandDisplayName,
          storeDisplayName: profile.profile.storeDisplayName,
          publicStoreReference: String(qr.context.publicStoreReference),
          locale: String(qr.context.locale),
        };
        // Nobody can join or order at a table no party is seated at: start no visit (an earlier
        // one on this browser, e.g. of a guest whose table was just settled, stays as it is).
        // WP-2423 DEC-DINING-GUEST-TABLE-START: where guests start tables a scan alone still starts
        // nothing; only the guest's tap on Start ("Start" or "NewParty") goes on to a visit.
        if (tableOpen === false) {
          const offer = await (
            options.table?.guestStart?.({
              ...scope,
              tableReference: String(tableReference),
              at: requestedAt,
            }) ?? Promise.resolve("No" as const)
          ).catch(() => "No" as const);
          if (offer === "BeingCleaned")
            return Object.freeze({ status: "TableBeingCleaned" as const, ...publicContext });
          if (offer === "No")
            return Object.freeze({ status: "TableNotOpen" as const, ...publicContext });
          if (input.intent !== "Start" && input.intent !== "NewParty")
            return Object.freeze({ status: "TableMayStart" as const, ...publicContext });
        } else if (
          tableOpen === true &&
          input.intent === undefined &&
          (await (
            options.table?.asksNewParty?.({
              ...scope,
              tableReference: String(tableReference),
            }) ?? Promise.resolve(false)
          ).catch(() => false))
        )
          return Object.freeze({ status: "TableAskNewParty" as const, ...publicContext });

        const admitted = parseGuestAdmissionEvidence(
          await options.admission.consume(
            Object.freeze({
              entryRequestReference,
              operationReference,
              requestedAt,
              context: qr.context,
              scope,
            }),
          ),
        );
        if (
          admitted.entryRequestReference !== entryRequestReference ||
          !sameScope(admitted) ||
          String(admitted.publicStoreReference) !== String(qr.context.publicStoreReference) ||
          String(admitted.publicTableReference) !== String(qr.context.publicTableReference) ||
          admitted.channel !== qr.context.channel ||
          String(admitted.locale) !== String(qr.context.locale) ||
          String(admitted.qrReference) !== String(qr.context.qrReference) ||
          admitted.qrRevocationVersion !== qr.context.revocationVersion ||
          Date.parse(admitted.evaluatedAt) > Date.parse(requestedAt) ||
          Date.parse(admitted.validUntil) <= Date.parse(requestedAt)
        )
          return unavailable;

        let consumed = false;
        const session = await new GuestSessionService({
          ...options.session,
          admission: {
            async consume(command) {
              if (
                consumed ||
                command.entryRequestReference !== entryRequestReference ||
                command.operationReference !== operationReference ||
                command.requestedAt !== requestedAt
              )
                return null;
              consumed = true;
              return admitted;
            },
          },
        }).create({ entryRequestReference, operationReference, requestedAt });
        if (session.status !== "Issued") return unavailable;
        // Every visit this phone had that is still worth something (one it can go on with, or
        // one whose receipts can still be read, here or at another Store) is kept on the phone.
        const current = visits.find((visit) => visit.source === "Current");
        const endedHere =
          current !== undefined &&
          current.result.status === "Ended" &&
          sameScope(current.result.session) &&
          String(current.result.session.publicStoreReference) ===
            String(qr.context.publicStoreReference);
        const contextExpiresAt = new Date(
          Math.min(
            Date.parse(qr.context.expiresAt),
            Date.parse(evidence.validUntil),
            Date.parse(admitted.validUntil),
            Date.parse(session.session.idleExpiresAt),
            Date.parse(session.session.absoluteExpiresAt),
          ),
        ).toISOString();
        return Object.freeze({
          status: "Established" as const,
          brandDisplayName: profile.profile.brandDisplayName,
          storeDisplayName: profile.profile.storeDisplayName,
          publicStoreReference: String(qr.context.publicStoreReference),
          publicTableReference: qr.context.publicTableReference,
          channel: qr.context.channel,
          operatingState: operatingStatus.state,
          availableServiceModes: operatingStatus.availableServiceModes,
          locale: String(qr.context.locale),
          contextExpiresAt,
          ...(tableOpen === undefined ? {} : { tableOpen }),
          sessionCredential: session.sessionCredential,
          csrfCredential: session.csrfCredential,
          cookie: session.cookie,
          ...(visits.length === 0
            ? {}
            : { earlierCredentials: Object.freeze(keptCredentials(visits)) }),
          ...(endedHere && current.result.status === "Ended"
            ? {
                previousVisit: current.result.receiptsReadable
                  ? ("EndedReceiptsKept" as const)
                  : ("Ended" as const),
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof CustomerEntryServiceUnavailableError) throw error;
        return unavailable;
      }
    },
  });
}
