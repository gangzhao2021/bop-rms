import { useState } from "react";
import { orderStatusText } from "../journey/messages.js";
import { PrivacyNoticeLink } from "../journey/PrivacyNotice.js";
import {
  ContactRemovalError,
  type ContactRemovalClient,
  type ContactRemovalResult,
} from "./contact-removal-client.js";

const text = orderStatusText.contact;
const outcomeText: Readonly<Record<ContactRemovalResult, string>> = text.outcome;

/**
 * WP-2423 Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): the customer's own contact details on the order page —
 * what the Store keeps, for how long, and a way to remove it now. Shown only while this visit can
 * still act on the order; never shows the phone number or email itself.
 */
export function ContactDetailsSection({
  orderReference,
  contactDetails,
  privacyNoticeUrl,
  storeName,
  client,
  onChanged,
}: {
  readonly orderReference: string;
  readonly contactDetails: "Stored" | "Removed" | "NotGiven" | undefined;
  readonly privacyNoticeUrl: string | undefined;
  readonly storeName: string | undefined;
  readonly client: ContactRemovalClient | undefined;
  readonly onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // What this page's own removal request found; replaces the section's static text so the guest
  // reads one sentence, and a repeat request says plainly that nothing was left to remove.
  const [outcome, setOutcome] = useState<ContactRemovalResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const store = storeName ?? text.defaultStoreName;
  if (contactDetails === undefined || (contactDetails === "NotGiven" && !privacyNoticeUrl))
    return null;
  const remove = async () => {
    if (busy || client === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await client.remove(orderReference);
      setConfirming(false);
      setOutcome(result);
      onChanged();
    } catch (error) {
      setFailure(
        error instanceof ContactRemovalError && error.code === "VisitEnded"
          ? text.visitEnded
          : text.removalFailed,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="contact-details" aria-labelledby="contact-details-heading">
      <h2 id="contact-details-heading">{text.heading}</h2>
      {outcome !== null ? (
        <p role="status">{outcomeText[outcome]}</p>
      ) : contactDetails === "Stored" ? (
        <>
          <p>{text.storeKeeps(store)}</p>
          {client !== undefined && !confirming ? (
            <button type="button" onClick={() => setConfirming(true)}>
              {text.remove}
            </button>
          ) : null}
          {confirming ? (
            <div className="contact-details__confirm" role="group" aria-label={text.confirmLabel}>
              <p>{text.confirm}</p>
              <div className="contact-details__actions">
                <button type="button" disabled={busy} onClick={() => void remove()}>
                  {busy ? text.removing : text.removeNow}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  {text.keep}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : contactDetails === "Removed" ? (
        <p>{text.removed}</p>
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
      {privacyNoticeUrl ? (
        <p>
          <PrivacyNoticeLink url={privacyNoticeUrl} />
        </p>
      ) : null}
    </section>
  );
}
