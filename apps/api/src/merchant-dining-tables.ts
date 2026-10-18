import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningSessionReadStore,
  createPostgresDiningTableQrStore,
  createPostgresDiningTableStore,
  parseDiningInstant,
  parseDiningReference,
} from "@rms/dining";
import {
  createPostgresStaffDiningRoundEntryStore,
  listStoreDiningSessionOrders,
  listStorePaidDiningRoundsAwaitingAcceptance,
  listStoreUnpaidGuestDiningRounds,
} from "@rms/ordering";
import { createPostgresCardMachinePaymentStore } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import {
  runMerchantSnapshotRead,
  type PersistentMerchantBffOptions,
} from "./persistent-merchant-bff.js";
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
]);

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
          for (const round of await listStoreUnpaidGuestDiningRounds(
            tx as unknown as Parameters<typeof listStoreUnpaidGuestDiningRounds>[0],
            scoped,
            activeReferences,
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
          // WP-2423 D4: closing a table's session from this page — offered to staff who may close
          // both the session and its Order, with the session's Order (one read for every open
          // session) so the close dialog checks its rounds when it is opened, not on every poll.
          const sessionOrders = canCloseSessions
            ? await listStoreDiningSessionOrders(
                tx as unknown as Parameters<typeof listStoreDiningSessionOrders>[0],
                scoped,
                activeReferences,
              )
            : new Map<string, string>();
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
            items: Object.freeze(
              page.items.map((table) =>
                Object.freeze({
                  tableReference: table.tableReference,
                  stableLabel: table.stableLabel,
                  areaCode: table.areaCode,
                  capacity: table.capacity,
                  lifecycle: table.lifecycle,
                  operationalState: table.operationalState,
                  aggregateVersion: table.aggregateVersion,
                  currentDiningSessionReference: table.activeDiningSessionReference,
                  elapsedMinutes:
                    table.activeDiningSessionReference === null
                      ? null
                      : (elapsedMinutes.get(table.activeDiningSessionReference) ?? null),
                  qrCodeValidUntil: codeUntil(table),
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
