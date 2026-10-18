import { PrivacyNoticeLink } from "../journey/PrivacyNotice.js";
import { checkoutText } from "../journey/messages.js";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { v7 as uuidv7 } from "uuid";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";
import { createCheckoutDetailsReadClient } from "./details-read-client.js";
import { createCheckoutPolicyClient, type CheckoutPolicyView } from "./policy-client.js";
import {
  createCheckoutDetailsClient,
  createCheckoutDetailsController,
  type CheckoutDetailsDraft,
} from "./details-client.js";

export interface CheckoutFormSelection {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly quoteReference: string;
  readonly quoteVersion: 1 | 2;
  readonly orderType: "DineIn" | "Pickup";
  readonly quoteExpiresAt: string;
}
/** What the checkout page can ask the form to do. */
export interface CheckoutDetailsFormHandle {
  /**
   * Save the current details. Resolves when the save attempt has settled: with the selection the
   * Store acknowledged, or null when nothing was saved (the form shows why and how to recover).
   */
  save(): Promise<CheckoutFormSelection | null>;
}

/**
 * E.164 for the Store's SMS and calls. A bare North American number gets +1; an explicit
 * international number keeps its own code. Anything else is sent as typed and rejected by the server.
 */
export function normalizePhoneNumber(value: string): string {
  const compact = value.replace(/[\s().-]/gu, "");
  if (/^\d{10}$/u.test(compact)) return "+1" + compact;
  if (/^1\d{10}$/u.test(compact)) return "+" + compact;
  if (/^00\d{7,14}$/u.test(compact)) return "+" + compact.slice(2);
  return compact;
}

export type PickupContactDraft = NonNullable<CheckoutDetailsDraft["pickupContact"]>;

/**
 * The pickup contact a freshly loaded form starts from. Contact the guest typed but has not saved
 * yet (kept by the checkout page across a re-price, for example after reconnecting) wins over the
 * Store's last saved copy; it is only shown again, never sent until the guest continues.
 */
export function startingPickupContact(
  orderType: CheckoutFormSelection["orderType"],
  unsaved: PickupContactDraft | null,
  saved: PickupContactDraft | null | undefined,
): PickupContactDraft | null {
  if (orderType !== "Pickup") return null;
  return unsaved ?? saved ?? { name: "", channel: "Phone", value: "" };
}

/**
 * Whether the form says it could not confirm a save and offers its retry. While offline the
 * checkout page's single offline notice is all the guest sees; the retry comes back on reconnect.
 */
export function showsUnconfirmedSave(uncertain: boolean, online: boolean): boolean {
  return uncertain && online;
}

export function CheckoutDetailsForm({
  selection: provided,
  now = Date.now,
  unsavedContact = null,
  onUnsavedContactChange,
  onBusyChange,
  onReadyChange,
  onSubmittableChange,
  ref,
}: {
  readonly selection: CheckoutFormSelection;
  readonly now?: () => number;
  /** Contact typed but not yet saved, held by the page so a re-price does not clear it. */
  readonly unsavedContact?: PickupContactDraft | null;
  readonly onUnsavedContactChange?: (contact: PickupContactDraft | null) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onReadyChange?: (selection: CheckoutFormSelection | null) => void;
  /** Whether a save could be attempted now (details loaded, policies accepted, online, not expired). */
  readonly onSubmittableChange?: (submittable: boolean) => void;
  readonly ref?: React.Ref<CheckoutDetailsFormHandle>;
}) {
  const [selection] = useState(() => Object.freeze({ ...provided }));
  const [reader] = useState(createCheckoutDetailsReadClient);
  const [policies] = useState(() => createCheckoutPolicyClient(now));
  const [saver] = useState(() => createCheckoutDetailsController(createCheckoutDetailsClient()));
  const save = useSyncExternalStore(saver.subscribe, saver.getState, saver.getState);
  const [draft, setDraft] = useState<CheckoutDetailsDraft | null>(null);
  const [policy, setPolicy] = useState<CheckoutPolicyView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(true);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const [, tick] = useState(0);
  const generation = useRef(0);
  const unsaved = useRef(unsavedContact);
  unsaved.current = unsavedContact;
  const context = useRef<(() => boolean) | null>(null);
  const load = useCallback(async () => {
    const run = ++generation.current,
      current = captureCustomerCsrfContext();
    context.current = current;
    setLoading(true);
    setFailed(false);
    setConfirmed(false);
    try {
      const [saved, requirements] = await Promise.all([
        reader.read(selection),
        policies.read(selection),
      ]);
      if (run !== generation.current || !current()) return;
      const prior = saved.details;
      setDraft({
        detailsReference: prior?.detailsReference ?? uuidv7(),
        expectedVersion: prior?.detailsVersion ?? 0,
        cartReference: selection.cartReference,
        cartVersion: selection.cartVersion,
        quoteReference: selection.quoteReference,
        quoteVersion: selection.quoteVersion,
        orderType: selection.orderType,
        pickupContact: startingPickupContact(
          selection.orderType,
          unsaved.current,
          prior?.pickupContact,
        ),
        // WP-2423 Q10: emailing a receipt needs the store's email account (an external gate); until
        // it is connected the receipt is shown on the order page, and no email is collected.
        receipt: { choice: "InSession", email: null },
        policies: [],
      });
      setPolicy(requirements);
      setDirty(true);
    } catch {
      if (run === generation.current) setFailed(true);
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [policies, reader, selection]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    const offline = () => {
      setOnline(false);
      saver.setOnline(false);
    };
    const online = () => {
      setOnline(true);
      saver.setOnline(true);
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [saver]);
  const expiresAt = Math.min(
    Date.parse(selection.quoteExpiresAt),
    Date.parse(policy?.validUntil ?? ""),
  );
  const expired = !Number.isFinite(expiresAt) || now() >= expiresAt;
  useEffect(() => {
    if (!Number.isFinite(expiresAt) || expired) return;
    const timer = window.setTimeout(
      () => tick((n) => n + 1),
      Math.min(expiresAt - now() + 1, 2147483647),
    );
    return () => window.clearTimeout(timer);
  }, [expired, expiresAt, now]);
  const uncertain = "canRetry" in save && save.canRetry;
  const busy = save.status === "pending" || uncertain;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const authorized = context.current?.() ?? false;
  const ready = save.status === "saved" && !dirty && !busy && authorized && online && !expired;
  useEffect(() => {
    onReadyChange?.(ready ? selection : null);
    return () => onReadyChange?.(null);
  }, [onReadyChange, ready, selection]);
  const submittable =
    draft !== null &&
    policy !== null &&
    !expired &&
    online &&
    authorized &&
    !busy &&
    !failed &&
    (policy.documents.length === 0 || confirmed);
  useEffect(() => {
    onSubmittableChange?.(submittable);
    return () => onSubmittableChange?.(false);
  }, [onSubmittableChange, submittable]);

  const edit = (patch: Partial<Pick<CheckoutDetailsDraft, "pickupContact" | "receipt">>) => {
    if (busy || !authorized || !online || expired) return;
    setDraft((value) => (value === null ? null : { ...value, ...patch }));
    if (patch.pickupContact !== undefined) onUnsavedContactChange?.(patch.pickupContact);
    setDirty(true);
  };
  const savedRevision = (): boolean => {
    const result = saver.getState();
    if (result.status === "saved" && context.current?.()) {
      setDraft((value) =>
        value === null
          ? null
          : { ...value, expectedVersion: result.acknowledgement.detailsVersion },
      );
      setDirty(false);
      onUnsavedContactChange?.(null);
      return true;
    }
    return false;
  };
  const submit = async (): Promise<CheckoutFormSelection | null> => {
    if (
      draft === null ||
      policy === null ||
      expired ||
      !online ||
      !authorized ||
      busy ||
      (policy.documents.length > 0 && !confirmed)
    )
      return null;
    await saver.save({
      ...draft,
      pickupContact:
        draft.pickupContact !== null && draft.pickupContact.channel === "Phone"
          ? { ...draft.pickupContact, value: normalizePhoneNumber(draft.pickupContact.value) }
          : draft.pickupContact,
      policies: policy.documents.map((document) => ({
        documentReference: document.documentReference,
        documentVersion: document.documentVersion,
        documentDigest: document.documentDigest,
        purposeCode: document.purposeCode,
      })),
    });
    return savedRevision() ? selection : null;
  };
  useImperativeHandle(ref, () => ({ save: submit }));
  if (loading)
    return (
      <section className="checkout-details-form" aria-label={checkoutText.detailsLabel}>
        <p role="status">{checkoutText.detailsLoading}</p>
      </section>
    );
  if (failed || !authorized || draft === null || policy === null)
    return (
      <section className="checkout-details-form" aria-label={checkoutText.detailsLabel}>
        <p role="alert">{checkoutText.detailsLoadFailed}</p>
        <button type="button" disabled={!online || busy} onClick={() => void load()}>
          {checkoutText.reloadDetails}
        </button>
      </section>
    );
  const contact = draft.pickupContact;
  return (
    <section aria-labelledby="checkout-details-heading">
      <h2 id="checkout-details-heading">
        {selection.orderType === "Pickup"
          ? checkoutText.detailsHeadingPickup
          : checkoutText.receipt}
      </h2>
      <form
        className="checkout-details-form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy || !online || expired}>
          <legend>
            {selection.orderType === "Pickup"
              ? checkoutText.pickupContactLegend
              : checkoutText.receipt}
          </legend>
          {selection.orderType === "Pickup" ? (
            <p className="checkout-details-form__hint">
              {checkoutText.pickupContactPurpose}
              {policy.privacyNoticeUrl ? (
                <>
                  {" "}
                  <PrivacyNoticeLink url={policy.privacyNoticeUrl} />
                </>
              ) : null}
            </p>
          ) : null}
          {draft.pickupContact !== null ? (
            <>
              <label>
                {checkoutText.pickupName}
                <input
                  required
                  maxLength={120}
                  value={draft.pickupContact.name}
                  onChange={(event) =>
                    edit({
                      pickupContact: {
                        ...(contact ?? { name: "", channel: "Phone" as const, value: "" }),
                        name: event.target.value,
                      },
                    })
                  }
                />
              </label>
              <label>
                {checkoutText.contactMethod}
                <select
                  value={draft.pickupContact.channel}
                  onChange={(event) =>
                    edit({
                      pickupContact: {
                        ...(contact ?? { name: "", channel: "Phone" as const, value: "" }),
                        channel: event.target.value === "Email" ? "Email" : "Phone",
                        value: "",
                      },
                    })
                  }
                >
                  <option value="Phone">{checkoutText.contactMethodPhone}</option>
                  <option value="Email">{checkoutText.contactMethodEmail}</option>
                </select>
              </label>
              <label>
                {draft.pickupContact.channel === "Phone"
                  ? checkoutText.mobileNumber
                  : checkoutText.pickupEmail}
                <input
                  required
                  type={draft.pickupContact.channel === "Phone" ? "tel" : "email"}
                  autoComplete={draft.pickupContact.channel === "Phone" ? "tel" : "email"}
                  pattern={
                    draft.pickupContact.channel === "Phone"
                      ? "[+0-9][0-9 \\(\\)\\.\\-]{6,24}"
                      : undefined
                  }
                  maxLength={draft.pickupContact.channel === "Phone" ? 25 : 254}
                  value={draft.pickupContact.value}
                  onChange={(event) =>
                    edit({
                      pickupContact: {
                        ...(contact ?? { name: "", channel: "Phone" as const, value: "" }),
                        value: event.target.value,
                      },
                    })
                  }
                />
              </label>
            </>
          ) : (
            <p>{checkoutText.dineInNoContact}</p>
          )}
          <p className="checkout-details-form__hint">{checkoutText.receiptOnOrderPage}</p>
          {policy.documents.map((document) => (
            <details key={document.documentReference}>
              <summary>{document.title}</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{document.bodyText}</p>
            </details>
          ))}
          {policy.documents.length > 0 ? (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                  setDirty(true);
                }}
              />
              {checkoutText.agreePolicies}
            </label>
          ) : null}
        </fieldset>
        {expired ? <p role="alert">{checkoutText.detailsExpired}</p> : null}
        {save.status === "pending" ? <p role="status">{checkoutText.savingDetails}</p> : null}
        {save.status === "saved" && !dirty ? (
          <p role="status">{checkoutText.detailsSaved}</p>
        ) : null}
        {save.status === "invalid" ? <p role="alert">{checkoutText.detailsInvalid}</p> : null}
        {["conflict", "policy", "requote", "denied"].includes(save.status) ? (
          <p role="alert">{checkoutText.detailsCheckoutChanged}</p>
        ) : null}
        {showsUnconfirmedSave(uncertain, online) ? (
          <>
            <p role="alert">{checkoutText.detailsSaveUnconfirmed}</p>
            <button
              type="button"
              onClick={() => {
                void saver.retry().then(savedRevision);
              }}
            >
              {checkoutText.retrySavingDetails}
            </button>
          </>
        ) : null}
        {save.status === "pending" ? null : (
          <button
            type="submit"
            className="checkout-details-form__save"
            disabled={
              busy || !online || expired || !dirty || (policy.documents.length > 0 && !confirmed)
            }
          >
            {checkoutText.saveDetails}
          </button>
        )}
        <button
          type="button"
          className="checkout-details-form__reload"
          disabled={busy || !online}
          onClick={() => void load()}
        >
          {checkoutText.reloadDetails}
        </button>
      </form>
    </section>
  );
}
