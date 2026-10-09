import { Link } from "react-router";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";

const unavailableFields = [
  "Table / session",
  "Active Order batches",
  "Shared payable summary",
  "Service / allergen notices",
] as const;

export function DiningSessionPage({
  store,
}: {
  readonly store?: CustomerStoreContext | undefined;
}) {
  return (
    <CustomerPage step="other" store={store} className="order-status dining-session">
      <PageHeading title="Your dining session" />
      <section className="order-status__unavailable dining-session__unavailable" role="alert">
        <span className="order-status__unavailable-icon" aria-hidden="true">
          !
        </span>
        <h2>Session details are unavailable</h2>
        <p>Authorized session data is unavailable.</p>
        <ul className="dining-session__unavailable-fields">
          {unavailableFields.map((field) => (
            <li key={field}>{field} · unavailable</li>
          ))}
        </ul>
      </section>
      <Link className="order-status__back" to="/">
        Return to entry
      </Link>
    </CustomerPage>
  );
}
