import { Link } from "react-router";
import { CustomerPage, PageHeading } from "./journey/CustomerPage.js";

/** Fallback for a route that does not exist. */
export function CustomerShell() {
  return (
    <CustomerPage step="other" className="not-found-page">
      <PageHeading title="Page not found">
        <p>This link doesn’t lead anywhere. Scan the location QR code again or open the menu.</p>
      </PageHeading>
      <div className="shell-actions">
        <Link className="shell-action" to="/menu">
          Open the menu
        </Link>
        <Link to="/">Scan again</Link>
      </div>
    </CustomerPage>
  );
}
