import { t } from "./i18n/i18n.js";
import { Link } from "react-router";
import { CustomerPage, PageHeading } from "./journey/CustomerPage.js";

/** Fallback for a route that does not exist. */
export function CustomerShell() {
  return (
    <CustomerPage step="other" className="not-found-page">
      <PageHeading title={t("Page not found")}>
        <p>
          {t("This link doesn’t lead anywhere. Scan the location QR code again or open the menu.")}
        </p>
      </PageHeading>
      <div className="shell-actions">
        <Link className="shell-action" to="/menu">
          {t("Open the menu")}
        </Link>
        <Link to="/">{t("Scan again")}</Link>
      </div>
    </CustomerPage>
  );
}
