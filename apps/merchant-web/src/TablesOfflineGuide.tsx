import { t } from "./i18n/i18n.js";

/**
 * WP-2423 item 8 ① segment 3 (operating continuity; DEC-TABLES-SERVER-MAIN): while the Tables page
 * can't reach the store system, it says what servers do instead, on the screen they are working
 * in — staff can't open a document while offline. The full procedure is the runbook's "Store
 * outage procedure" (Tables that pay at the end). Nothing is queued in the browser (IDR-0039).
 */
export function TablesOfflineGuide() {
  return (
    <section className="tables-offline" aria-labelledby="tables-offline-title" role="note">
      <h2 id="tables-offline-title">{t("While the connection is down")}</h2>
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
        <summary>{t("When the connection is back, for each table")}</summary>
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
    </section>
  );
}
