import { t, saidTable } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { SourceTime } from "./StoreTime.js";
import { loadLastBills } from "./table-last-bills.js";

const cad = (minor: string) => orderMoney({ amountMinor: minor, currencyCode: "CAD" });

/**
 * WP-2423 item 8 ① segment 3 (operating continuity; DEC-TABLES-SERVER-MAIN): while the Tables page
 * can't reach the store system, it says what servers do instead, on the screen they are working
 * in — staff can't open a document while offline. The full procedure is the runbook's "Store
 * outage procedure" (Tables that pay at the end). Nothing is queued in the browser (IDR-0039).
 */
export function TablesOfflineGuide({
  storeReference = null,
}: {
  /** b13: only this Store's saved bills (a table label repeats across Stores). */
  readonly storeReference?: string | null;
} = {}) {
  const last = loadLastBills(Date.now(), storeReference);
  return (
    <section className="tables-offline" aria-labelledby="tables-offline-title" role="note">
      <h2 id="tables-offline-title">{t("While Tables isn't working")}</h2>
      <ul>
        <li>
          {t("Take new rounds on paper slips (table and round) and pass them to the kitchen.")}
        </li>
        <li>{t("Tick each dish on the slip when it is served.")}</li>
        <li>
          {t(
            "A comp or discount is the manager's decision: write the dish, how much and the reason on the slip, with the manager's name.",
          )}
        </li>
        <li>
          {t(
            "Take the table's payment on the card machine or in cash as usual. Write the table, amount, tip, time and the slip's reference code (cash: received and change). Never write a card number.",
          )}
        </li>
      </ul>
      <details>
        <summary>{t("When Tables works again, for each table")}</summary>
        <ol>
          <li>
            {t("Enter its paper rounds: Take order for table, tick Recorded after an outage.")}
          </li>
          <li>{t("Mark the dishes served.")}</li>
          <li>
            {t(
              "Manager: record the comps and discounts from the slips first. They can't be added once the payment is recorded.",
            )}
          </li>
          <li>
            {t(
              "Start checkout, check the bill matches the paper, choose the tip, tick Paid while the system was down with the time, and record the payment.",
            )}
          </li>
          <li>{t("Close the table, then mark it cleaned.")}</li>
        </ol>
      </details>
      {/* Owner 2026-11-03: what each table owed, so a table can pay while the list can't be read. */}
      {last === null ? null : (
        <div className="tables-offline__bills">
          <h3>{t("Last bills seen before this stopped")}</h3>
          <p>
            {t("As of")} <SourceTime instant={last.savedAt} withDate={false} /> ·{" "}
            {t("Rounds taken since then aren't here: add the paper slips.")}
          </p>
          {last.tables.map((table) => (
            <details key={table.label}>
              <summary>
                <span>{t("Table {table}", { table: saidTable(table.label) })}</span>
                <strong>
                  {table.settled
                    ? t("Paid")
                    : t("To pay {amount}", { amount: cad(table.owedMinor) })}
                </strong>
              </summary>
              {table.rounds.map((round) => (
                <dl key={round.number} className="table-checkout__totals">
                  <div>
                    <dt>{t("Round {number}", { number: String(round.number) })}</dt>
                    <dd>{cad(round.totalMinor)}</dd>
                  </div>
                  {round.items.map((item, index) => (
                    <div key={index}>
                      <dt>{item.name}</dt>
                      <dd>{cad(item.subtotalMinor)}</dd>
                    </div>
                  ))}
                </dl>
              ))}
              {/* DEC-TAX-WHOLE-RECEIPT: the bill's one rounding line, as at checkout. */}
              {table.settled ||
              table.taxRoundingMinor === undefined ||
              table.taxRoundingMinor === "0" ? null : (
                <dl className="table-checkout__totals">
                  <div>
                    <dt>{t("Tax rounding")}</dt>
                    <dd>{cad(table.taxRoundingMinor)}</dd>
                  </div>
                </dl>
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
