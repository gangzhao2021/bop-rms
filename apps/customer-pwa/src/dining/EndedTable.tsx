import { Link } from "react-router";
import { saidTable, t, tWords } from "../i18n/i18n.js";
import {
  CustomerPage,
  PageHeading,
  type CustomerJourneyStep,
  type CustomerStoreContext,
} from "../journey/CustomerPage.js";
import {
  getEndedTable,
  type ClosedBillPaid,
  type EndedTable,
} from "../session/customer-transaction-context.js";

/**
 * Batch 46 (v15 b45 live): how this phone's table visit ended, when it has no visit now. Every
 * guest tab (Menu, a dish page, Cart, Your table, the start page without a scan) says the same
 * calm thing with the Store's header, never "scan the location QR code to begin", "your visit
 * on this phone has ended" or a refresh that cannot help.
 */
export const endedTableHere = (): EndedTable | null => getEndedTable();

/** The ended table's Store for the page header (dine in), when the restore named it. */
export function endedTableStore(ended: EndedTable | null): CustomerStoreContext | undefined {
  return ended?.store == null
    ? undefined
    : {
        storeName: ended.store.storeDisplayName,
        brandName: ended.store.brandDisplayName,
        serviceMode: "DineIn",
      };
}

/** A table closed and settled while the guest sat at it (the receipt is on Your table). */
export function SettledTableCard({
  tableLabel,
  receiptLink = false,
}: {
  readonly tableLabel: string;
  readonly receiptLink?: boolean;
}) {
  return (
    <section className="order-status__card" role="status">
      <h2>{t("Thank you for dining with us.")}</h2>
      {/* b13: a table comped to nothing closes too; "paid" is the receipt's to say. */}
      <p>{tWords("Your meal at table {table} has ended.", { table: saidTable(tableLabel) })}</p>
      {/* Batch 44: the same words as the start page (a new party is seated first). */}
      <p>{t("New party? Ask staff to seat you, then scan again.")}</p>
      {receiptLink ? (
        <Link className="order-status__back" to="/dine-in/session">
          {t("See the receipt")}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Batch 45 (v15 b44 live): staff closed the guest's table with nothing ordered (guests joined, a
 * dish may have been added and removed). The visit is over and nothing was charged; there is no
 * receipt, nothing to join and no code to ask anyone for. A new party is seated first.
 */
export function EmptyClosedTableCard({ tableLabel }: { readonly tableLabel: string }) {
  return (
    <section className="order-status__card" role="status">
      <h2>{t("This table’s visit has ended")}</h2>
      <p>
        {tWords("Nothing was ordered at table {table}, so nothing was charged.", {
          table: saidTable(tableLabel),
        })}
      </p>
      <p>{t("New party? Ask staff to seat you, then scan again.")}</p>
    </section>
  );
}

/**
 * Batch 55 review (v15 b54, order 59): staff closed the bill when the guests left, then closed the
 * table. Before, every guest tab said "Thank you for dining with us … See the receipt", and Your
 * table showed no receipt: a bill closed this way has none. It says how the bill ended, in the
 * words Menu, Cart and Your table use while the table is still open; nothing to follow.
 */
export function ClosedBillTableCard({
  tableLabel,
  paid,
}: {
  readonly tableLabel: string;
  readonly paid: ClosedBillPaid;
}) {
  return (
    <section className="order-status__card" role="status">
      <h2>{t("This table’s visit has ended")}</h2>
      <p>{tWords("Your meal at table {table} has ended.", { table: saidTable(tableLabel) })}</p>
      <p>
        {paid === "Nothing"
          ? t("Staff closed your table’s bill; nothing was charged.")
          : t(
              "Staff closed your table’s bill: what was paid stays paid, and the rest is not charged to you.",
            )}
      </p>
      <p>{t("New party? Ask staff to seat you, then scan again.")}</p>
    </section>
  );
}

/**
 * WP-2423 item 8 ⑧/⑨: staff moved this phone's party to another table, or merged it into the
 * party there. The phone joins that table by its code. Batch 46: a party that had ordered
 * nothing isn't told its orders went along.
 */
export function MovedTableCard({
  tableLabel,
  merged,
  nothingOrdered,
}: {
  readonly tableLabel: string;
  readonly merged: boolean;
  readonly nothingOrdered: boolean;
}) {
  const table = saidTable(tableLabel);
  return (
    <section className="order-status__card" role="status">
      {merged ? (
        <>
          <h2>{tWords("Your table was merged into table {table}", { table })}</h2>
          <p>
            {nothingOrdered
              ? tWords(
                  "Staff joined your party to table {table}. Scan the code on table {table} to keep ordering and paying together.",
                  { table },
                )
              : tWords(
                  "Staff joined your party to table {table}. Everything your table ordered is on that table's bill. Scan the code on table {table} to keep ordering and paying together.",
                  { table },
                )}
          </p>
        </>
      ) : (
        <>
          <h2>{tWords("Your table moved to table {table}", { table })}</h2>
          <p>
            {nothingOrdered
              ? tWords(
                  "Staff moved your party to table {table}. Scan the code on table {table} to keep ordering and paying together.",
                  { table },
                )
              : tWords(
                  "Staff moved your party to table {table}. Everything your table ordered moved with you. Scan the code on table {table} to keep ordering and paying together.",
                  { table },
                )}
          </p>
        </>
      )}
    </section>
  );
}

/** The ended table's card, for a tab other than Your table (its receipt is there). */
export function EndedTableCard({ ended }: { readonly ended: EndedTable }) {
  return ended.kind === "Settled" ? (
    <SettledTableCard tableLabel={ended.tableLabel} receiptLink />
  ) : ended.kind === "Empty" ? (
    <EmptyClosedTableCard tableLabel={ended.tableLabel} />
  ) : ended.kind === "ClosedByStaff" ? (
    <ClosedBillTableCard tableLabel={ended.tableLabel} paid={ended.paid} />
  ) : (
    <MovedTableCard
      tableLabel={ended.tableLabel}
      merged={ended.merged}
      nothingOrdered={ended.nothingOrdered}
    />
  );
}

/** Menu, a dish page or Cart after the table's visit ended on this phone. */
export function EndedTablePage({
  step,
  title,
  ended,
}: {
  readonly step: CustomerJourneyStep;
  readonly title: string;
  readonly ended: EndedTable;
}) {
  return (
    <CustomerPage
      step={step}
      store={endedTableStore(ended)}
      className={`ended-table-page ended-table-page--${step}`}
      askToScan={false}
    >
      <PageHeading title={title} />
      <EndedTableCard ended={ended} />
    </CustomerPage>
  );
}
