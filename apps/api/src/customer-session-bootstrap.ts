import {
  createPostgresGuestCheckoutRecovery,
  findLatestGuestSessionOrder,
  findRecentGuestSessionOrders,
  listStoreDiningSessionOrders,
  parseOrderingReference,
} from "@rms/ordering";
import { createPublicStoreProfileService, parseGetPublicStoreRequest } from "@rms/store";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import {
  listDiningSessionMergedInto,
  listDiningSessionsMergedIn,
  loadDiningParticipantMove,
  loadDiningParticipantSettledTable,
} from "@rms/dining";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";
import type { RequestHandler } from "express";
import {
  isGuestBindingPermanentRefusal,
  isGuestDependencyFailure,
} from "./guest-binding-dependency.js";
import {
  GuestSessionService,
  GuestSessionError,
  createPostgresGuestSessionEntryStore,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
export const customerSessionBootstrapRoute = "/api/v1/customer/session/csrf";
/**
 * Batch 55 review (v15 b54): what a guest whose table closed is told was paid on a bill staff
 * closed when the guests left, from Payment's write-off record of it.
 */
export const closedBillPaid = (writeOff: {
  readonly capturedOrderAllocationMinor: bigint;
}): "Nothing" | "Some" => (writeOff.capturedOrderAllocationMinor > 0n ? "Some" : "Nothing");
export function createCustomerSessionBootstrapRead(
  options: CustomerCheckoutSessionAuthorizationOptions & {
    publicProfile?: PersistentPublicStoreProfileOptions;
  },
) {
  type Transaction = Parameters<Parameters<typeof options.transactions.run>[0]>[0];
  const settledTableStore = async (
    transaction: Transaction,
    guest: { readonly publicStoreReference: unknown; readonly locale: string },
  ): Promise<{ brandDisplayName: string; storeDisplayName: string } | null> => {
    if (!options.publicProfile) return null;
    const sql = transaction as unknown as {
      query(text: string, values: unknown[]): Promise<unknown>;
    };
    await sql.query("SAVEPOINT settled_table_store", []);
    try {
      const request = parseGetPublicStoreRequest({
        publicStoreReference: guest.publicStoreReference,
        requestedLocale: guest.locale,
        evaluatedAt: options.now(),
        purpose: "CustomerCart",
      });
      const profile = await createPublicStoreProfileService(
        createPersistentPublicStoreProfilePorts(transaction, options.publicProfile, request),
      ).getPublicStore(request);
      await sql.query("RELEASE SAVEPOINT settled_table_store", []);
      return profile.status === "Available"
        ? {
            brandDisplayName: profile.profile.brandDisplayName,
            storeDisplayName: profile.profile.storeDisplayName,
          }
        : null;
    } catch {
      await sql.query("ROLLBACK TO SAVEPOINT settled_table_store", []);
      return null;
    }
  };
  /** Batch 45 (v15 b44 live): an ended table's answer with the Store's names (the header). */
  const withStoreNames = async <T extends object>(
    transaction: Transaction,
    guest: { readonly publicStoreReference: unknown; readonly locale: string },
    answer: T,
  ) => {
    const store = await settledTableStore(transaction, guest);
    return store === null ? answer : { ...answer, store };
  };
  /**
   * Batch 46 (v15 b45 live): whether nothing was ordered by this party (its session and every
   * party merged into it): the ordering Domain's lookup of each session's Order.
   */
  const nothingOrderedBy = async (transaction: Transaction, session: string) => {
    const sessions = [
      session,
      ...(await listDiningSessionsMergedIn(transaction as never, options.scope, session)),
    ];
    return (
      (await listStoreDiningSessionOrders(transaction as never, options.scope, sessions)).size === 0
    );
  };
  /**
   * Batch 55 review (v15 b54): whether staff closed this bill when the guests left (Payment's
   * write-off of what was still owed), and whether anything was paid on it first. Such a bill has
   * no receipt (the settled receipt read refuses it), so the guest is told how it ended instead
   * of "Thank you … See the receipt". Null: no write-off, or the tenant isn't known here.
   */
  const closedByStaff = async (
    transaction: Transaction,
    session: string,
    guestSessionReference: string,
  ): Promise<{
    readonly paid: "Nothing" | "Some";
    readonly ownPaidMinor: bigint;
    /** Batch 57 (Q36): of it, refunded or on its way back to the card (a refused one: not). */
    readonly ownRefundedMinor: bigint;
  } | null> => {
    const tenantReference = options.publicProfile?.binding?.tenantReference;
    if (tenantReference === undefined) return null;
    const order = (
      await listStoreDiningSessionOrders(transaction as never, options.scope, [session])
    ).get(session);
    if (order === undefined) return null;
    const payment = createPostgresDiningTableSettlementStore({
      scope: { tenantReference: String(tenantReference), ...options.scope },
      // The guest sat at this closed table (proven by the caller); its own bill's Order only.
      authorize: async (_tx, value) => value.orderReference === order,
    });
    const [writeOff] = await payment.listWriteOffsByOrders(transaction as never, [order]);
    if (writeOff === undefined) return null;
    const paid = closedBillPaid(writeOff);
    // Batch 56 (v15 b55 live): what this phone itself paid on that bill before staff closed the
    // rest (Payment's captured phone payments of this guest's Session; never another guest's).
    const own =
      paid === "Nothing"
        ? []
        : (await payment.listOnlinePaymentsByOrders(transaction as never, [order])).filter(
            (attempt) =>
              attempt.guestSessionReference === guestSessionReference &&
              attempt.outcome?.status === "Captured",
          );
    const ownPaidMinor = own.reduce(
      (sum, attempt) => sum + (attempt.outcome?.capturedMinor ?? attempt.totalMinor),
      0n,
    );
    // Batch 57 (Q36): Payment's refunds of those payments to their card, as the own receipt reads.
    const ownPayments = new Set(own.map((attempt) => attempt.onlinePaymentReference));
    const ownRefundedMinor =
      own.length === 0
        ? 0n
        : (await payment.listOnlineRefundsByOrders(transaction as never, [order]))
            .filter(
              (refund) =>
                ownPayments.has(refund.onlinePaymentReference) &&
                refund.outcome?.status !== "Failed",
            )
            .reduce((sum, refund) => sum + refund.amountMinor, 0n);
    return { paid, ownPaidMinor, ownRefundedMinor };
  };
  return {
    async read(sessionCredential: string) {
      return options.transactions.run(async (transaction) => {
        const identity = new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(
            { run: async (work) => work(transaction) },
            options.scope,
          ),
          credentials: options.credentials,
          binding: options.binding(transaction),
          now: options.now,
          admission: { consume: async () => null },
        });
        const csrfToken = await identity.recoverForegroundCsrf({ sessionCredential });
        if (!options.publicProfile) return csrfToken;
        const guest = await identity.resolve({ sessionCredential, activity: "Background" });
        const request = parseGetPublicStoreRequest({
          publicStoreReference: guest.publicStoreReference,
          requestedLocale: guest.locale,
          evaluatedAt: options.now(),
          purpose: "CustomerCart",
        });
        const profile = await createPublicStoreProfileService(
          createPersistentPublicStoreProfilePorts(transaction, options.publicProfile, request),
        ).getPublicStore(request);
        if (profile.status !== "Available")
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const allocation = await createPostgresGuestCheckoutRecovery({
          scope: options.scope,
          authorize: async (tx, input) => {
            const confirmed = await identity.resolve({ sessionCredential, activity: "Background" });
            return (
              tx === transaction &&
              confirmed.brandReference === options.scope.brandReference &&
              confirmed.storeReference === options.scope.storeReference &&
              String(confirmed.sessionReference) === input.guestSessionReference &&
              JSON.stringify(confirmed) === JSON.stringify(guest)
            );
          },
        }).latest(transaction, {
          guestSessionReference: guest.sessionReference,
          observedAt: options.now(),
        });
        // WP-2423 Q10: a customer who reopens the app can go straight back to the order this
        // Guest Session placed (read only after the Session is confirmed in this transaction).
        // M104 (B.2): and every order of this visit, newest first (a pickup visit keeps ordering).
        const recentOrders = await findRecentGuestSessionOrders(transaction, options.scope, {
          guestSessionReference: String(guest.sessionReference),
          observedAt: options.now(),
          limit: 5,
        });
        const latestOrder = recentOrders[0] ?? null;
        const current = await identity.resolve({ sessionCredential, activity: "Background" });
        if (JSON.stringify(current) !== JSON.stringify(guest))
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return {
          csrfToken,
          ...(allocation ? { checkoutSessionReference: allocation.checkoutSessionReference } : {}),
          ...(latestOrder
            ? {
                currentOrder: {
                  orderReference: latestOrder.orderReference,
                  orderNumber: latestOrder.orderNumber,
                  orderType: latestOrder.orderType,
                },
              }
            : {}),
          ...(recentOrders.length > 1
            ? {
                earlierOrders: recentOrders.slice(1).map((order) => ({
                  orderReference: order.orderReference,
                  orderNumber: order.orderNumber,
                  orderType: order.orderType,
                })),
              }
            : {}),
          menuContext: {
            publicStoreReference: guest.publicStoreReference,
            channel: guest.channel,
            locale: guest.locale,
            brandDisplayName: profile.profile.brandDisplayName,
            storeDisplayName: profile.profile.storeDisplayName,
          },
          // M02 (v15 07b7a1b7): the table this Session is at and whether this phone joined its
          // party (Identity's own binding state, confirmed above), so a reload stays at it.
          ...(guest.channel === "DineIn" && guest.publicTableReference !== null
            ? {
                visit: {
                  publicTableReference: String(guest.publicTableReference),
                  joined: guest.diningState === "DiningBound",
                },
              }
            : {}),
        };
      });
    },
    /**
     * v15 2026-10-30: the table a dine-in guest's party sits at now, when staff moved it after this
     * phone joined (its table binding then no longer holds, so nothing else is restored). Only the
     * table's label: no CSRF credential and nothing the phone could act with. Null otherwise.
     */
    async readMovedTable(sessionCredential: string) {
      return options.transactions.run(async (transaction) => {
        // The guest Session alone (credential, expiry, revocation); not the table it joined at.
        const guest = await new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(
            { run: async (work) => work(transaction) },
            options.scope,
          ),
          credentials: options.credentials,
          binding: { validate: async () => "Current" as const },
          now: options.now,
          admission: { consume: async () => null },
        }).resolve({ sessionCredential, activity: "Background" });
        if (
          String(guest.brandReference) !== options.scope.brandReference ||
          String(guest.storeReference) !== options.scope.storeReference ||
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound" ||
          guest.diningSessionReference === null ||
          guest.diningParticipantReference === null
        )
          return null;
        // WP-2423 item 8 ⑨: the party was merged into another table's (it eats there now).
        const merged = (
          await listDiningSessionMergedInto(transaction as never, options.scope, [
            String(guest.diningSessionReference),
          ])
        ).get(String(guest.diningSessionReference));
        // Batch 45 (v15 b44 live): with the Store's published names, so the page keeps its header.
        const withStore = <T extends object>(answer: T) =>
          withStoreNames(transaction, guest, answer);
        // Batch 46 (v15 b45 live): a party that had ordered nothing isn't told its orders went
        // along to the other table's bill.
        const nothing = async () =>
          (await nothingOrderedBy(transaction, String(guest.diningSessionReference)))
            ? { nothingOrdered: true as const }
            : {};
        if (merged !== undefined)
          return merged.phase === "Active" || merged.phase === "Closing"
            ? withStore({
                tableLabel: merged.tableLabel,
                merged: true as const,
                ...(await nothing()),
              })
            : null;
        const moved = await loadDiningParticipantMove(transaction as never, options.scope, {
          diningSessionReference: String(guest.diningSessionReference),
          participantReference: String(guest.diningParticipantReference),
        });
        return moved === null
          ? null
          : withStore({ tableLabel: moved.tableLabel, ...(await nothing()) });
      });
    },
    /**
     * WP-2423 (coordinator 2026-10-30, Owner authorized): the table this dine-in guest sat at, when
     * it was closed normally (its bill settled) while the guest was still at it — so a guest who
     * paid and reloads is thanked instead of asked to join. A merged-away party is told at the
     * table it was merged into once that one closed. Only the label; nothing the phone can act
     * with. Batch 45 (v15 b44 live): a table closed with nothing ordered says just that
     * (nothingOrdered, no receipt access), so the guest isn't asked to join or for a join code.
     * Null: still open, cancelled, removed by staff or never joined.
     */
    async readSettledTable(sessionCredential: string) {
      return options.transactions.run(async (transaction) => {
        // The ended visit's Session (Active and within its absolute lifetime); no binding. Its
        // CSRF value reads that visit's receipts only (M5), here the settled table's receipt.
        const ended = await new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(
            { run: async (work) => work(transaction) },
            options.scope,
          ),
          credentials: options.credentials,
          binding: { validate: async () => "Current" as const },
          now: options.now,
          admission: { consume: async () => null },
        }).recoverEndedVisitCsrf({ sessionCredential, observedAt: options.now() });
        const guest = ended.session;
        const receipt = { csrfToken: String(ended.csrfCredential) };
        if (
          String(guest.brandReference) !== options.scope.brandReference ||
          String(guest.storeReference) !== options.scope.storeReference ||
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound" ||
          guest.diningSessionReference === null ||
          guest.diningParticipantReference === null
        )
          return null;
        const session = String(guest.diningSessionReference);
        const merged = (
          await listDiningSessionMergedInto(transaction as never, options.scope, [session])
        ).get(session);
        // Batch 45: the Store's names come with every ended table's answer (the page's header).
        const named = <T extends object>(answer: T) => withStoreNames(transaction, guest, answer);
        // Batch 55 review: a bill staff closed has no receipt for the table; how it ended. Batch
        // 56: a phone that paid part of it gets read-only access to its own payment's receipt.
        const guestSession = String(guest.sessionReference);
        const closedAnswer = (
          tableLabel: string,
          closed: NonNullable<Awaited<ReturnType<typeof closedByStaff>>>,
        ) =>
          named({
            tableLabel,
            closedByStaff: closed.paid,
            ...(closed.ownPaidMinor > 0n
              ? {
                  yourPayment: {
                    amountMinor: closed.ownPaidMinor.toString(),
                    method: "Online" as const,
                    ...(closed.ownRefundedMinor > 0n
                      ? { refundedMinor: closed.ownRefundedMinor.toString() }
                      : {}),
                  },
                  ...receipt,
                }
              : {}),
          });
        const closedOr = async (tableLabel: string, billSession: string) => {
          const closed = await closedByStaff(transaction, billSession, guestSession);
          return closed === null
            ? named({ tableLabel, ...receipt })
            : closedAnswer(tableLabel, closed);
        };
        // Batch 46 (v15 b45 live): the table this party was merged into closed with nothing
        // ordered there by anyone (its own party, this one or another merged in): the visit ended
        // and nothing was charged, as at a table of its own, not "thank you" with no receipt.
        if (merged !== undefined)
          return merged.phase !== "Closed"
            ? null
            : (await nothingOrderedBy(transaction, merged.diningSessionReference))
              ? named({ tableLabel: merged.tableLabel, nothingOrdered: true as const })
              : await closedOr(merged.tableLabel, merged.diningSessionReference);
        const settled = await loadDiningParticipantSettledTable(
          transaction as never,
          options.scope,
          {
            diningSessionReference: session,
            participantReference: String(guest.diningParticipantReference),
          },
        );
        if (settled === null) return null;
        // A party that left without ordering had nothing to settle: no receipt, nothing charged.
        const orders = await listStoreDiningSessionOrders(transaction as never, options.scope, [
          session,
        ]);
        if (!orders.has(session))
          return named({ tableLabel: settled.tableLabel, nothingOrdered: true as const });
        // Batch 44 (v15 b43 live): the Store's published names, so the guest's page still names
        // the Store after a reload. Public fields only; an unreadable profile leaves them out.
        const closed = await closedByStaff(transaction, session, guestSession);
        if (closed !== null) return closedAnswer(settled.tableLabel, closed);
        return named({ ...settled, ...receipt });
      });
    },
    /**
     * WP-2423 (v15 3cd0f8dd M5): a visit that ended (its table closed, or it sat idle) and placed an
     * order: the CSRF credential that lets this device read that order's receipt (read only, until
     * the Session's absolute expiry) and which order it is. Nothing else is restored: no menu, cart
     * or checkout. A visit without an order, or past that bound, has nothing to restore.
     */
    async readEndedVisit(sessionCredential: string) {
      return options.transactions.run(async (transaction) => {
        const identity = new GuestSessionService({
          store: createPostgresGuestSessionEntryStore(
            { run: async (work) => work(transaction) },
            options.scope,
          ),
          credentials: options.credentials,
          binding: options.binding(transaction),
          now: options.now,
          admission: { consume: async () => null },
        });
        const ended = await identity.recoverEndedVisitCsrf({
          sessionCredential,
          observedAt: options.now(),
        });
        if (
          ended.session.brandReference !== options.scope.brandReference ||
          ended.session.storeReference !== options.scope.storeReference
        )
          throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        const order = await findLatestGuestSessionOrder(transaction, options.scope, {
          guestSessionReference: String(ended.session.sessionReference),
          observedAt: options.now(),
        });
        if (order === null) throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
        return {
          csrfToken: ended.csrfCredential,
          order: {
            orderReference: order.orderReference,
            orderNumber: order.orderNumber,
            orderType: order.orderType,
          },
          receiptAvailableUntil: String(ended.session.absoluteExpiresAt),
        };
      });
    },
  };
}
export function createCustomerSessionBootstrapHandler(options?: {
  allowedOrigin: string;
  port: {
    read(sessionCredential: string): Promise<
      | string
      | {
          csrfToken: string;
          checkoutSessionReference?: string;
          currentOrder?: {
            orderReference: string;
            orderNumber: string;
            orderType: "Pickup" | "DineIn";
          };
          /** M104 (B.2): this visit's earlier orders, newest first (at most 4). */
          earlierOrders?: readonly {
            orderReference: string;
            orderNumber: string;
            orderType: "Pickup" | "DineIn";
          }[];
          menuContext: {
            publicStoreReference: string;
            channel: "DineIn" | "Pickup";
            locale: string;
            brandDisplayName: string;
            storeDisplayName: string;
          };
          /** M02: a dine-in Session's table, and whether this phone joined its party. */
          visit?: { publicTableReference: string; joined: boolean };
        }
    >;
    /** WP-2423 (v15 3cd0f8dd M5): receipt-only access for a visit that ended (absent: none). */
    readEndedVisit?(sessionCredential: string): Promise<{
      csrfToken: string;
      order: { orderReference: string; orderNumber: string; orderType: "Pickup" | "DineIn" };
      receiptAvailableUntil: string;
    }>;
    /**
     * The table this guest sat at when it was closed and settled (absent or null: not so), or
     * (batch 45) closed with nothing ordered: no receipt, nothing to act with.
     */
    readSettledTable?(sessionCredential: string): Promise<
      | {
          tableLabel: string;
          csrfToken: string;
          /** Batch 44: the Store's published names (absent: not readable). */
          store?: { brandDisplayName: string; storeDisplayName: string };
        }
      | {
          tableLabel: string;
          nothingOrdered: true;
          store?: { brandDisplayName: string; storeDisplayName: string };
        }
      | {
          tableLabel: string;
          /** Batch 55 review: staff closed the bill when the guests left (no receipt). */
          closedByStaff: "Nothing" | "Some";
          store?: { brandDisplayName: string; storeDisplayName: string };
          /**
           * Batch 56: what this phone itself paid on that bill, with read-only access to its own
           * payment's receipt (absent: this phone paid nothing on it).
           */
          yourPayment?: {
            amountMinor: string;
            method: "Online";
            /** Batch 57: of it, refunded or on its way back (absent: none). */
            refundedMinor?: string;
          };
          csrfToken?: string;
        }
      | null
    >;
    /** v15 2026-10-30: the table the guest's party was moved to (absent or null: not moved). */
    readMovedTable?(sessionCredential: string): Promise<{
      tableLabel: string;
      merged?: boolean;
      /** Batch 46: the party had ordered nothing at its own table. */
      nothingOrdered?: boolean;
      /** Batch 45: the Store's published names (absent: not readable). */
      store?: { brandDisplayName: string; storeDisplayName: string };
    } | null>;
  };
}): RequestHandler {
  const origin = options && new URL(options.allowedOrigin).origin;
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const reject = (status: number) => {
      // WP-2423 (rush-reads-and-orders-changes): a busy or unreachable store says when to ask
      // again, so the phone keeps the visit it has and asks again instead of starting over.
      if (status === 503) response.setHeader("Retry-After", "5");
      response.status(status).json({ schemaVersion: 1, error: { code: "session_unavailable" } });
    };
    if (!options) {
      reject(503);
      return;
    }
    let credential: string;
    try {
      if (
        request.get("sec-fetch-site") !== "same-origin" ||
        (request.get("origin") !== undefined && request.get("origin") !== origin) ||
        request.get("x-bop-session-bootstrap") !== "1" ||
        Object.keys(request.query).length !== 0
      )
        throw new Error();
      readClosedRecord(request.body ?? {}, []);
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim().split("="))
        .filter(([name]) => name === "__Host-bop-guest");
      // A first visit has no Guest Session yet: that is an ordinary state, not a bad request.
      // Nothing is issued (no CSRF token, no cookie) and every other check above still applies.
      if (cookies.length === 0) {
        response.status(204).end();
        return;
      }
      if (cookies.length !== 1 || cookies[0]?.length !== 2) throw new Error();
      credential = parseGuestRawCredential(cookies[0]?.[1]);
    } catch {
      reject(400);
      return;
    }
    /**
     * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): what the visit's own records say
     * ("not this visit", "nothing to restore") is nothing to restore. A store that could not
     * answer (no free connection in a rush, a statement cut off, a database fault) says nothing
     * about the visit: it is thrown on, so the phone hears "busy, try again" and keeps its visit.
     * Before, it was read as no visit (204) and a pickup guest in a rush was told their session
     * ended and to scan a QR code they do not have at home.
     */
    const notReadable = (error: unknown): null => {
      // What no wait can change (a refusal of this visit, an *_INVALID input) is an answer too:
      // nothing to restore, never "busy" for ever.
      if (
        (error instanceof GuestSessionError && !isGuestDependencyFailure(error)) ||
        isGuestBindingPermanentRefusal(error)
      )
        return null;
      throw error;
    };
    /** Stored data the page can't be given (malformed) is nothing to restore, never busy. */
    const wellFormed = <T>(parse: () => T): T | null => {
      try {
        return parse();
      } catch {
        return null;
      }
    };
    /** Batch 44/45: the Store's names for the page's header, when well formed (else left out). */
    const storeNames = (
      store: { brandDisplayName: string; storeDisplayName: string } | undefined,
    ) =>
      store !== undefined &&
      [store.brandDisplayName, store.storeDisplayName].every(
        (name) => typeof name === "string" && name.trim() !== "" && name.length <= 200,
      )
        ? {
            store: {
              brandDisplayName: store.brandDisplayName,
              storeDisplayName: store.storeDisplayName,
            },
          }
        : {};
    const readMovedTable = async (sessionCredential: string) => {
      if (options.port.readMovedTable === undefined) return null;
      try {
        const moved = await options.port.readMovedTable(sessionCredential);
        return moved !== null && /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(moved.tableLabel)
          ? {
              tableLabel: moved.tableLabel,
              ...(moved.merged === true ? { merged: true } : {}),
              ...(moved.nothingOrdered === true ? { nothingOrdered: true } : {}),
              ...storeNames(moved.store),
            }
          : null;
      } catch (error) {
        return notReadable(error);
      }
    };
    const readSettledTable = async (sessionCredential: string) => {
      if (options.port.readSettledTable === undefined) return null;
      let settled: Awaited<ReturnType<NonNullable<typeof options.port.readSettledTable>>>;
      try {
        settled = await options.port.readSettledTable(sessionCredential);
      } catch (error) {
        return notReadable(error);
      }
      if (settled === null || !/^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(settled.tableLabel))
        return null;
      // Batch 45: closed with nothing ordered: the label and the Store, never receipt access.
      if ("nothingOrdered" in settled)
        return settled.nothingOrdered === true
          ? {
              emptyTable: { tableLabel: settled.tableLabel, ...storeNames(settled.store) },
            }
          : null;
      // Batch 55 review (v15 b54): staff closed the bill when the guests left. There is no
      // receipt, so no receipt access: which table, whether anything was paid, and the Store.
      if ("closedByStaff" in settled) {
        if (settled.closedByStaff !== "Nothing" && settled.closedByStaff !== "Some") return null;
        // Batch 56 (v15 b55 live): the phone that paid part of it: what it paid and read-only
        // access to that payment's receipt. Anything malformed is left out (the bill's end stays).
        const own = settled.yourPayment;
        const ownCsrf =
          own === undefined || settled.csrfToken === undefined
            ? null
            : wellFormed(() => parseGuestRawCredential(settled.csrfToken));
        const yours =
          own !== undefined &&
          ownCsrf !== null &&
          own.method === "Online" &&
          /^[1-9][0-9]{0,15}$/u.test(own.amountMinor) &&
          (own.refundedMinor === undefined ||
            (/^[1-9][0-9]{0,15}$/u.test(own.refundedMinor) &&
              BigInt(own.refundedMinor) <= BigInt(own.amountMinor)))
            ? {
                yourPayment: {
                  amountMinor: own.amountMinor,
                  method: own.method,
                  ...(own.refundedMinor === undefined ? {} : { refundedMinor: own.refundedMinor }),
                },
                csrfToken: ownCsrf,
              }
            : {};
        return {
          closedTable: {
            tableLabel: settled.tableLabel,
            paid: settled.closedByStaff,
            ...storeNames(settled.store),
            ...yours,
          },
        };
      }
      const csrfToken = wellFormed(() => parseGuestRawCredential(settled.csrfToken));
      return csrfToken === null
        ? null
        : {
            settledTable: {
              tableLabel: settled.tableLabel,
              csrfToken,
              ...storeNames(settled.store),
            },
          };
    };
    /** The ended visit's receipt access, validated; null when there is none to give. */
    const readEndedVisit = async (sessionCredential: string) => {
      if (options.port.readEndedVisit === undefined) return null;
      let ended: Awaited<ReturnType<NonNullable<typeof options.port.readEndedVisit>>>;
      try {
        ended = await options.port.readEndedVisit(sessionCredential);
      } catch (error) {
        return notReadable(error);
      }
      const until = ended.receiptAvailableUntil;
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(until) ||
        !/^[1-9][0-9]{0,18}$/u.test(ended.order.orderNumber) ||
        (ended.order.orderType !== "Pickup" && ended.order.orderType !== "DineIn")
      )
        return null;
      const csrfToken = wellFormed(() => parseGuestRawCredential(ended.csrfToken));
      const orderReference = wellFormed(() =>
        String(parseOrderingReference(ended.order.orderReference)),
      );
      if (csrfToken === null || orderReference === null) return null;
      return {
        csrfToken,
        order: {
          orderReference,
          orderNumber: ended.order.orderNumber,
          orderType: ended.order.orderType,
        },
        receiptAvailableUntil: until,
      };
    };
    try {
      const result = await options.port.read(credential);
      const csrfToken = parseGuestRawCredential(
        typeof result === "string" ? result : result.csrfToken,
      );
      const menuContext = typeof result === "string" ? undefined : result.menuContext;
      const currentOrder =
        typeof result === "string" || result.currentOrder === undefined
          ? undefined
          : {
              orderReference: String(parseOrderingReference(result.currentOrder.orderReference)),
              orderNumber: /^[1-9][0-9]{0,18}$/u.test(result.currentOrder.orderNumber)
                ? result.currentOrder.orderNumber
                : (() => {
                    throw new Error("invalid order number");
                  })(),
              orderType:
                result.currentOrder.orderType === "DineIn"
                  ? ("DineIn" as const)
                  : result.currentOrder.orderType === "Pickup"
                    ? ("Pickup" as const)
                    : (() => {
                        throw new Error("invalid order type");
                      })(),
            };
      const rawEarlier = typeof result === "string" ? undefined : result.earlierOrders;
      const earlierOrders =
        rawEarlier === undefined || currentOrder === undefined
          ? undefined
          : rawEarlier.length < 1 || rawEarlier.length > 4
            ? (() => {
                throw new Error("invalid earlier orders");
              })()
            : rawEarlier.map((order) => {
                if (
                  !/^[1-9][0-9]{0,18}$/u.test(order.orderNumber) ||
                  (order.orderType !== "Pickup" && order.orderType !== "DineIn")
                )
                  throw new Error("invalid earlier order");
                return {
                  orderReference: String(parseOrderingReference(order.orderReference)),
                  orderNumber: order.orderNumber,
                  orderType: order.orderType,
                };
              });
      const rawVisit = typeof result === "string" ? undefined : result.visit;
      const visit =
        rawVisit === undefined
          ? undefined
          : menuContext?.channel === "DineIn" &&
              typeof rawVisit.joined === "boolean" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                rawVisit.publicTableReference,
              )
            ? { publicTableReference: rawVisit.publicTableReference, joined: rawVisit.joined }
            : (() => {
                throw new Error("invalid visit");
              })();
      const checkoutSessionReference =
        typeof result === "string" || result.checkoutSessionReference === undefined
          ? undefined
          : parseOrderingReference(result.checkoutSessionReference);
      response.status(200).json({
        schemaVersion: 1,
        csrfToken,
        ...(checkoutSessionReference ? { checkoutSessionReference } : {}),
        ...(currentOrder ? { currentOrder } : {}),
        ...(earlierOrders ? { earlierOrders } : {}),
        ...(menuContext
          ? {
              menuContext: {
                publicStoreReference: menuContext.publicStoreReference,
                channel: menuContext.channel,
                locale: menuContext.locale,
                brandDisplayName: menuContext.brandDisplayName,
                storeDisplayName: menuContext.storeDisplayName,
              },
            }
          : {}),
        ...(visit ? { visit } : {}),
      });
    } catch (error) {
      // WP-2423: a visit that ended or expired (or a cookie no Session matches) has nothing to
      // restore, exactly like a first visit: an empty 204 with no CSRF token, so the guest page
      // does not log a failed request. Every other Session failure still says so.
      if (
        error instanceof GuestSessionError &&
        error.code === "GUEST_SESSION_UNAVAILABLE" &&
        !isGuestDependencyFailure(error)
      ) {
        try {
          // v15 2026-10-30: staff moved this guest's party; the page says where it sits now (the
          // phone scans that table's code to join it again). Nothing to act with is issued.
          const moved = await readMovedTable(credential);
          if (moved !== null) {
            response.status(200).json({ schemaVersion: 1, movedTable: moved });
            return;
          }
          // The table was settled while this guest sat at it: thank them, with the table's
          // receipt (read only), instead of asking them to join.
          // Batch 45: or it closed with nothing ordered: the visit ended, nothing was charged.
          const settled = await readSettledTable(credential);
          if (settled !== null) {
            response.status(200).json({ schemaVersion: 1, ...settled });
            return;
          }
          // WP-2423 (v15 3cd0f8dd M5): a guest who left can still open their receipt here.
          const ended = await readEndedVisit(credential);
          if (ended === null) response.status(204).end();
          else response.status(200).json({ schemaVersion: 1, endedVisit: ended });
        } catch {
          reject(503);
        }
        return;
      }
      reject(error instanceof GuestSessionError && !isGuestDependencyFailure(error) ? 401 : 503);
    }
  };
}
