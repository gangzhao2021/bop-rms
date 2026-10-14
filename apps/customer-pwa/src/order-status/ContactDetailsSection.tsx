import { useState } from "react";
import { PrivacyNoticeLink } from "../journey/PrivacyNotice.js";
import {
  ContactRemovalError,
  type ContactRemovalClient,
  type ContactRemovalResult,
} from "./contact-removal-client.js";

const outcomeText: Record<ContactRemovalResult, string> = {
  Removed: "Your contact details have been removed from this order.",
  AlreadyRemoved:
    "Your contact details had already been removed from this order. There is nothing more to remove.",
  NotGiven: "There were no contact details on this order.",
};

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
  const store = storeName ?? "The store";
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
          ? "Your visit on this phone has ended, so this can't be changed here. Ask a staff member to remove your contact details."
          : "Your contact details could not be removed right now. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="contact-details" aria-labelledby="contact-details-heading">
      <h2 id="contact-details-heading">Your contact details</h2>
      {outcome !== null ? (
        <p role="status">{outcomeText[outcome]}</p>
      ) : contactDetails === "Stored" ? (
        <>
          <p>
            {store} keeps the phone number or email you gave only to contact you about this order,
            and deletes it 30 days after your order.
          </p>
          {client !== undefined && !confirming ? (
            <button type="button" onClick={() => setConfirming(true)}>
              Remove my contact details
            </button>
          ) : null}
          {confirming ? (
            <div className="contact-details__confirm" role="group" aria-label="Confirm removal">
              <p>
                Remove them now? The store won't be able to call or email you about this order. You
                can still collect it by showing your order number.
              </p>
              <div className="contact-details__actions">
                <button type="button" disabled={busy} onClick={() => void remove()}>
                  {busy ? "Removing…" : "Remove now"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep them
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : contactDetails === "Removed" ? (
        <p>Your contact details have been removed from this order.</p>
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
