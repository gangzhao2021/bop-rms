import { t } from "../i18n/i18n.js";
/**
 * WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): the Store's own privacy notice, entered by its Owner.
 * Customers see the link only when there is one; there is no placeholder.
 */
const pattern = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s<>"]*)?$/u;

/** A safe https link or an error; the server sends none until the Owner entered one. */
export function parsePrivacyNoticeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || !pattern.test(value))
    throw new Error("invalid privacy notice link");
  return value;
}

export function PrivacyNoticeLink({ url }: { readonly url: string | undefined }) {
  if (url === undefined) return null;
  return (
    <a className="privacy-notice-link" href={url} target="_blank" rel="noopener noreferrer">
      {t("Privacy notice")}
      <span className="sr-only"> {t("(opens in a new tab)")}</span>
    </a>
  );
}
