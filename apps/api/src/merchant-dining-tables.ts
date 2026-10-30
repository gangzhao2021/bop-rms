import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningPaymentTimingStore,
  createPostgresDiningSessionReadStore,
  createPostgresDiningTableQrStore,
  createPostgresDiningTableStore,
  listDiningSessionMergesInto,
  loadDiningSessionPhones,
  parseDiningInstant,
  parseDiningReference,
} from "@rms/dining";
import {
  createPostgresOrderRoundStaffHoldStore,
  createPostgresStaffDiningRoundEntryStore,
  listStoreDiningSessionOrders,
  listStorePaidDiningRoundsAwaitingAcceptance,
  listStoreUnpaidGuestDiningRounds,
} from "@rms/ordering";
import {
  createPostgresCardMachinePaymentStore,
  createPostgresDiningTableSettlementStore,
  listStoreOrderBatchesPaidOnline,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { runMerchantSnapshotRead } from "./merchant-snapshot-read.js";
import { merchantDiningStaffCallStore } from "./merchant-dining-staff-calls.js";
import type { MerchantBffService } from "./merchant-bff.js";
/** The Tables page's own permission first, then the actions it offers. */
const tableCloseActions = ["dining.session.close", "order.close", "dining.item.serve"] as const;
const tablePageActions = Object.freeze([
  "dining.operate",
  ...tableCloseActions,
  // WP-2423: the "Order host" section is offered only to staff who may transfer the host.
  "dining.host.transfer",
  // WP-2423 abandoned payment: "Cancel unpaid round" is offered to staff who may cancel orders.
  "ordering.order.cancel",
  // WP-2423 item 8 ①: "Guests left without paying" (a write-off) is offered to managers only.
  "payment.refund.approve",
]);

/** WP-2423 item 8 ⑤ decision 3: a phone that joined in the last 10 minutes is pointed out. */
const newPhoneMinutes = 10;

export function createMerchantDiningTables(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  tableAvailabilityCommandEnabled?: boolean;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["afterTableReference", "limit"]);
    const afterTableReference =
      raw.afterTableReference === null
        ? null
        : String(parseDiningReference(raw.afterTableReference));
    if (
      typeof raw.limit !== "number" ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > 100
    )
      throw new Error("DINING_TABLES_UNAVAILABLE");
    const limit = raw.limit;
    const denied = (): never => {
      throw new Error("DINING_TABLES_PERMISSION_DENIED");
    };
    // WP-2423 (v15 2026-10-18): the Tables page is polled by every floor screen. The read only
    // selects (Dining, Ordering, Payment and the caller's session, membership and policy) and
    // reads one snapshot of every owner: the session row's FOR SHARE and the membership/policy
    // SHARE table locks are answered locally, so it never waits for, or holds up, a staff command,
    // a role change or another screen, and it never sees half of a command (a table listed with a
    // session another command has just closed). The commands it offers re-check their versions.
    return runMerchantSnapshotRead(options.persistence.transactions, (tx) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // reads in between only confirm they run in this authorized transaction.
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          // WP-2423: the read's permission and the page's offered actions (operating tables;
          // closing a session needs closing both the session and its Order and serving its items,
          // the permissions the closing commands check) come from one current-fact read, not one
          // full resolution per action; the commands re-authorize in full when staff use them.
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              "dining.operate",
              authenticated.sessionReference,
            );
            const decisions = await current.authorizeActions(tablePageActions);
            if (decisions.get("dining.operate")?.effect !== "Allow") return denied();
            return Object.freeze({
              current,
              canOperateTables: options.tableAvailabilityCommandEnabled === true,
              canCloseSessions: tableCloseActions.every(
                (action) => decisions.get(action)?.effect === "Allow",
              ),
              canTransferHost: decisions.get("dining.host.transfer")?.effect === "Allow",
              canCancelUnpaidRounds: decisions.get("ordering.order.cancel")?.effect === "Allow",
              canWriteOff: decisions.get("payment.refund.approve")?.effect === "Allow",
            });
          },
          recheck: async ({ current }) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const {
            current,
            canOperateTables,
            canCloseSessions,
            canTransferHost,
            canCancelUnpaidRounds,
            canWriteOff,
          } = authority.scope;
          const authorize = () => authority.guard();
          const store = createPostgresDiningTableStore(
            { run: (work) => work(tx) },
            {
              tenantReference: current.selected.tenantReference,
              brandReference: current.context.brand.brandReference,
              storeReference: current.store.storeReference,
            },
            {
              hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
              equals: (a, b) => a === b,
            },
          );
          const page = await store.listTables({ afterTableReference, limit, authorize });
          const activeReferences = page.items.flatMap((table) =>
            table.activeDiningSessionReference === null ? [] : [table.activeDiningSessionReference],
          );
          // DEC-DINE-IN-PAY-LATER: how each table pays — an open table as it was opened, a free one
          // as the Store opens tables now — so staff entering a round know whether it is charged.
          const timings = createPostgresDiningPaymentTimingStore({
            scope: {
              tenantReference: current.selected.tenantReference,
              brandReference: current.context.brand.brandReference,
              storeReference: current.store.storeReference,
            },
            hashIntent: (v) => createHash("sha256").update(v).digest("hex"),
            equals: (a, b) => a === b,
          });
          const storeTiming = (await timings.load(tx, authorize)).paymentTiming;
          const sessionTimings = await timings.loadSessionTimings(tx, activeReferences);
          const elapsedMinutes = new Map<string, number>();
          // WP-2423 D4: each open session's phase and version, for closing it from this page.
          const sessionFacts = new Map<string, { phase: string; version: number }>();
          if (activeReferences.length > 0) {
            const observedAt = Date.parse(parseDiningInstant(options.persistence.now()));
            const sessions = await createPostgresDiningSessionReadStore(
              { run: (work) => work(tx) },
              {
                tenantReference: current.selected.tenantReference,
                brandReference: current.context.brand.brandReference,
                storeReference: current.store.storeReference,
              },
            ).loadSessions(activeReferences);
            if (sessions.length !== activeReferences.length)
              throw new Error("DINING_TABLES_UNAVAILABLE");
            for (const [index, session] of sessions.entries()) {
              if (
                !session ||
                (session.phase !== "Active" && session.phase !== "Closing") ||
                session.diningSessionReference !== activeReferences[index]
              )
                throw new Error("DINING_TABLES_UNAVAILABLE");
              const startedAt = Date.parse(session.startedAt);
              if (!Number.isFinite(observedAt) || startedAt > observedAt)
                throw new Error("DINING_TABLES_UNAVAILABLE");
              elapsedMinutes.set(
                session.diningSessionReference,
                Math.floor((observedAt - startedAt) / 60_000),
              );
              sessionFacts.set(session.diningSessionReference, {
                phase: session.phase,
                version: session.version,
              });
            }
          }
          // WP-2423 Q11: each table's printed code, so staff see a missing or soon-ending code here.
          const codes = await createPostgresDiningTableQrStore(tx, {
            tenantReference: current.selected.tenantReference,
            brandReference: current.context.brand.brandReference,
            storeReference: current.store.storeReference,
          }).loadLatestForTables(page.items.map((table) => table.tableReference));
          // WP-2423 item 5 ("warn before timeouts"): rounds staff entered at each table that still
          // wait for their card-machine payment, and when each is cancelled if not recorded.
          const scoped = {
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          const cardPayments = createPostgresCardMachinePaymentStore({
            scope: scoped,
            authorize: async () => authorize(),
          });
          // One Ordering read for every table on the page and one Payment read for all of their
          // rounds: the cost does not grow with the number of open tables or rounds.
          const sessionOfTable = new Map<string, string | null>(
            page.items.map((table) => [
              String(table.tableReference),
              table.activeDiningSessionReference === null
                ? null
                : String(table.activeDiningSessionReference),
            ]),
          );
          const candidates = (
            await createPostgresStaffDiningRoundEntryStore({
              ...scoped,
              authorize: async () => authorize(),
            }).listAwaitingPaymentByTables(
              tx,
              page.items
                .filter((table) => table.activeDiningSessionReference !== null)
                .map((table) => table.tableReference),
            )
          ).filter(
            // Only the party now at the table; an earlier session's round is not theirs.
            (round) => sessionOfTable.get(round.tableReference) === round.diningSessionReference,
          );
          const paidOnCardMachine = await cardPayments.listByBatches(
            tx,
            candidates.map((round) => ({
              orderReference: round.orderReference,
              orderBatchReference: round.orderBatchReference,
            })),
          );
          const awaiting = new Map<string, string[]>();
          for (const round of candidates) {
            if (paidOnCardMachine.has(round.orderBatchReference)) continue;
            awaiting.set(round.tableReference, [
              ...(awaiting.get(round.tableReference) ?? []),
              round.payBy,
            ]);
          }
          // WP-2423 abandoned payment ("warn before timeouts"): guest rounds of the party now at
          // each table that nobody paid for yet, and when each is cancelled unless paid. One read
          // for every open session on the page.
          const unpaidGuestRounds = new Map<
            string,
            {
              orderReference: string;
              orderBatchReference: string;
              roundNumber: number;
              payBy: string;
            }[]
          >();
          const unpaidRounds = await listStoreUnpaidGuestDiningRounds(
            tx as unknown as Parameters<typeof listStoreUnpaidGuestDiningRounds>[0],
            scoped,
            activeReferences,
          );
          // A payment that just arrived (Payment recorded it; Ordering records it seconds later):
          // the round is paid, so it is not offered for cancellation as unpaid. One Payment read.
          const paidOnline = await listStoreOrderBatchesPaidOnline(
            tx as unknown as Parameters<typeof listStoreOrderBatchesPaidOnline>[0],
            scoped,
            unpaidRounds.map((round) => round.orderBatchReference),
          );
          for (const round of unpaidRounds.filter(
            (entry) => !paidOnline.has(entry.orderBatchReference),
          ))
            unpaidGuestRounds.set(round.diningSessionReference, [
              ...(unpaidGuestRounds.get(round.diningSessionReference) ?? []),
              {
                orderReference: round.orderReference,
                orderBatchReference: round.orderBatchReference,
                roundNumber: round.roundNumber,
                payBy: round.payBy,
              },
            ]);
          // WP-2423 (v15 2026-10-16): paid rounds staff have not accepted yet. A paid dine-in round
          // is never refunded automatically, so the table shows how long it has waited. One read
          // for every open session on the page.
          const paidAwaitingAcceptance = new Map<
            string,
            { roundNumber: number; paidAt: string }[]
          >();
          for (const round of await listStorePaidDiningRoundsAwaitingAcceptance(
            tx as unknown as Parameters<typeof listStorePaidDiningRoundsAwaitingAcceptance>[0],
            scoped,
            activeReferences,
          ))
            paidAwaitingAcceptance.set(round.diningSessionReference, [
              ...(paidAwaitingAcceptance.get(round.diningSessionReference) ?? []),
              { roundNumber: round.roundNumber, paidAt: round.paidAt },
            ]);
          // WP-2423 D4 / item 8 ①: each open session's Order (one read for every open session), so
          // the list joins the table's dishes and bill and the close dialog checks its rounds when
          // it is opened, not on every poll.
          const sessionOrders = await listStoreDiningSessionOrders(
            tx as unknown as Parameters<typeof listStoreDiningSessionOrders>[0],
            scoped,
            activeReferences,
          );
          // WP-2423 item 8 ⑤ decisions 3 and 7: rounds waiting for staff ("needs action"; they are
          // not awaiting payment and are never cancelled by time) and phones that just joined.
          const ownerScope = {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          };
          const sessionOfOrder = new Map(
            [...sessionOrders].map(([session, order]) => [String(order), String(session)]),
          );
          // WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): the parties merged into each open table and
          // their Orders (on its bill; staff serve and close their rounds at this table).
          const mergesInto = await listDiningSessionMergesInto(
            tx as never,
            scoped,
            activeReferences.map(String),
          );
          const mergedSessions = [...mergesInto.values()].flat();
          const mergedOrders =
            mergedSessions.length === 0
              ? new Map<string, string>()
              : await listStoreDiningSessionOrders(
                  tx as unknown as Parameters<typeof listStoreDiningSessionOrders>[0],
                  scoped,
                  mergedSessions.map((entry) => entry.diningSessionReference),
                );
          // WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): tables whose bill has a payment, a part, a
          // split or a write-off (they are not merged); one read per kind for every open table.
          const billOrders = [...sessionOfOrder.keys()];
          const tablePayments = createPostgresDiningTableSettlementStore({
            scope: ownerScope,
            authorize: async (_tx, value) =>
              sessionOfOrder.has(String(value.orderReference)) && (await authorize()) === true,
          });
          const paymentStarted = new Set<string>(
            billOrders.length === 0
              ? []
              : [
                  ...(await tablePayments.listByOrders(tx as never, billOrders)),
                  ...(await tablePayments.listOnlinePaymentsByOrders(tx as never, billOrders)),
                  ...(await tablePayments.listWriteOffsByOrders(tx as never, billOrders)),
                  ...(await tablePayments.listSplitPlans(tx as never, billOrders)).filter(
                    (plan) => plan.mode !== "Whole",
                  ),
                ].map((entry) => sessionOfOrder.get(String(entry.orderReference)) ?? ""),
          );
          const waitingRounds = await createPostgresOrderRoundStaffHoldStore({
            brandReference: ownerScope.brandReference,
            storeReference: ownerScope.storeReference,
            authorize: async () => (await authorize()) === true,
          }).listWaiting({
            transaction: tx as unknown as Parameters<typeof listStoreDiningSessionOrders>[0],
            orderReferences: [...sessionOfOrder.keys()],
          });
          const heldRounds = new Map<
            string,
            {
              orderReference: string;
              orderBatchReference: string;
              roundNumber: number | null;
              reason: string;
              heldAt: string;
            }[]
          >();
          for (const hold of waitingRounds) {
            const session = sessionOfOrder.get(String(hold.orderReference));
            if (session === undefined) continue;
            const listed = unpaidGuestRounds.get(session) ?? [];
            const round = listed.find(
              (entry) => entry.orderBatchReference === String(hold.orderBatchReference),
            );
            unpaidGuestRounds.set(
              session,
              listed.filter((entry) => entry !== round),
            );
            heldRounds.set(session, [
              ...(heldRounds.get(session) ?? []),
              {
                orderReference: String(hold.orderReference),
                orderBatchReference: String(hold.orderBatchReference),
                roundNumber: round?.roundNumber ?? null,
                reason: hold.reason,
                heldAt: String(hold.heldAt),
              },
            ]);
          }
          const joinedAt = Date.parse(parseDiningInstant(options.persistence.now()));
          const newPhones = new Map<string, { phoneNumber: number; joinedAt: string }[]>();
          for (const session of activeReferences) {
            const phones = await loadDiningSessionPhones(
              tx as unknown as Parameters<typeof loadDiningSessionPhones>[0],
              ownerScope,
              String(session),
            );
            newPhones.set(
              String(session),
              phones
                .filter(
                  (phone) =>
                    !phone.left && joinedAt - Date.parse(phone.joinedAt) < newPhoneMinutes * 60_000,
                )
                .map((phone) => ({
                  phoneNumber: phone.phoneNumber,
                  joinedAt: String(phone.joinedAt),
                })),
            );
          }
          // WP-2423 Q28 DEC-DINING-STAFF-CALL: the open call of each open session (one read).
          const staffCalls = await merchantDiningStaffCallStore(tx, {
            tenantReference: String(current.selected.tenantReference),
            brandReference: String(current.context.brand.brandReference),
            storeReference: String(current.store.storeReference),
          }).listOpen(
            tx,
            activeReferences.map((reference) => String(reference)),
            async () => authorize(),
          );
          const codeUntil = (table: (typeof page.items)[number]) => {
            const issue = codes.get(table.tableReference);
            return table.qrStatus === "Active" && issue?.qrVersion === table.qrVersion
              ? issue.expiresAt
              : null;
          };
          return Object.freeze({
            canOperateTables,
            canCloseSessions,
            canTransferHost,
            canCancelUnpaidRounds,
            canWriteOff,
            items: Object.freeze(
              page.items.map((table) =>
                Object.freeze({
                  tableReference: table.tableReference,
                  stableLabel: table.stableLabel,
                  areaCode: table.areaCode,
                  capacity: table.capacity,
                  lifecycle: table.lifecycle,
                  operationalState: table.operationalState,
                  // WP-2423: why a table is blocked (CLEANING after its guests left), for Tables.
                  blockReasonCode: table.blockReasonCode,
                  aggregateVersion: table.aggregateVersion,
                  currentDiningSessionReference: table.activeDiningSessionReference,
                  elapsedMinutes:
                    table.activeDiningSessionReference === null
                      ? null
                      : (elapsedMinutes.get(table.activeDiningSessionReference) ?? null),
                  qrCodeValidUntil: codeUntil(table),
                  paymentTiming:
                    table.activeDiningSessionReference === null
                      ? storeTiming
                      : (sessionTimings.get(table.activeDiningSessionReference) ?? "PayFirst"),
                  staffCall: (() => {
                    const call =
                      table.activeDiningSessionReference === null
                        ? undefined
                        : staffCalls.get(String(table.activeDiningSessionReference));
                    return call === undefined
                      ? null
                      : Object.freeze({
                          callReference: String(call.callReference),
                          reason: call.reason,
                          calledAt: String(call.calledAt),
                        });
                  })(),
                  session:
                    table.activeDiningSessionReference === null
                      ? null
                      : Object.freeze({
                          phase:
                            sessionFacts.get(table.activeDiningSessionReference)?.phase ?? null,
                          version:
                            sessionFacts.get(table.activeDiningSessionReference)?.version ?? null,
                          orderReference:
                            sessionOrders.get(table.activeDiningSessionReference) ?? null,
                          // WP-2423 item 8 ⑨: something on the bill was paid, split or written
                          // off (not merged).
                          paymentStarted: paymentStarted.has(
                            String(table.activeDiningSessionReference),
                          ),
                          // WP-2423 item 8 ⑨: the tables merged into this one (their Orders are
                          // on its bill), oldest first.
                          mergedTables: Object.freeze(
                            (mergesInto.get(String(table.activeDiningSessionReference)) ?? []).map(
                              (entry) =>
                                Object.freeze({
                                  fromTableLabel: entry.fromTableLabel,
                                  orderReference:
                                    mergedOrders.get(entry.diningSessionReference) ?? null,
                                }),
                            ),
                          ),
                        }),
                  guestRoundsAwaitingPayment: Object.freeze(
                    (table.activeDiningSessionReference === null
                      ? []
                      : (unpaidGuestRounds.get(table.activeDiningSessionReference) ?? [])
                    )
                      .slice(0, 20)
                      .map((round) => Object.freeze({ ...round })),
                  ),
                  roundsAwaitingAcceptance: Object.freeze(
                    (table.activeDiningSessionReference === null
                      ? []
                      : (paidAwaitingAcceptance.get(table.activeDiningSessionReference) ?? [])
                    )
                      .slice(0, 20)
                      .map((round) => Object.freeze({ ...round })),
                  ),
                  heldRounds: Object.freeze(
                    (table.activeDiningSessionReference === null
                      ? []
                      : (heldRounds.get(String(table.activeDiningSessionReference)) ?? [])
                    )
                      .slice(0, 20)
                      .map((round) => Object.freeze({ ...round })),
                  ),
                  newPhones: Object.freeze(
                    (table.activeDiningSessionReference === null
                      ? []
                      : (newPhones.get(String(table.activeDiningSessionReference)) ?? [])
                    ).map((phone) => Object.freeze({ ...phone })),
                  ),
                  staffRoundsAwaitingPayment: Object.freeze(
                    (awaiting.get(table.tableReference) ?? [])
                      .slice(0, 20)
                      .map((payBy) => Object.freeze({ payBy })),
                  ),
                }),
              ),
            ),
            nextAfterTableReference: page.nextAfterTableReference,
          });
        },
      ),
    );
  };
}
