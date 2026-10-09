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
  /** Save the current details; resolves when the save attempt has settled. */
  save(): Promise<void>;
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

export function CheckoutDetailsForm({
  selection: provided,
  now = Date.now,
  onBusyChange,
  onReadyChange,
  onSubmittableChange,
  ref,
}: {
  readonly selection: CheckoutFormSelection;
  readonly now?: () => number;
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
        pickupContact:
          selection.orderType === "Pickup"
            ? (prior?.pickupContact ?? { name: "", channel: "Phone", value: "" })
            : null,
        receipt: prior?.receipt ?? { choice: "InSession", email: null },
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
    setDirty(true);
  };
  const savedRevision = () => {
    const result = saver.getState();
    if (result.status === "saved" && context.current?.()) {
      setDraft((value) =>
        value === null
          ? null
          : { ...value, expectedVersion: result.acknowledgement.detailsVersion },
      );
      setDirty(false);
    }
  };
  const submit = async () => {
    if (
      draft === null ||
      policy === null ||
      expired ||
      !online ||
      !authorized ||
      busy ||
      (policy.documents.length > 0 && !confirmed)
    )
      return;
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
    savedRevision();
  };
  useImperativeHandle(ref, () => ({ save: submit }));
  if (loading)
    return (
      <section className="checkout-details-form" aria-label="Checkout details">
        <p role="status">Loading checkout details…</p>
      </section>
    );
  if (failed || !authorized || draft === null || policy === null)
    return (
      <section className="checkout-details-form" aria-label="Checkout details">
        <p role="alert">Checkout details are unavailable. Refresh your checkout to try again.</p>
        <button type="button" disabled={!online || busy} onClick={() => void load()}>
          Reload checkout details
        </button>
      </section>
    );
  const contact = draft.pickupContact;
  return (
    <section aria-labelledby="checkout-details-heading">
      <h2 id="checkout-details-heading">
        {selection.orderType === "Pickup" ? "Your details" : "Receipt"}
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
          <legend>{selection.orderType === "Pickup" ? "Pickup contact" : "Receipt"}</legend>
          {selection.orderType === "Pickup" ? (
            <p className="checkout-details-form__hint">
              We’ll use this to reach you if there’s a problem with your order.
            </p>
          ) : null}
          {draft.pickupContact !== null ? (
            <>
              <label>
                Pickup name
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
                Contact method
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
                  <option value="Phone">Phone</option>
                  <option value="Email">Email</option>
                </select>
              </label>
              <label>
                {draft.pickupContact.channel === "Phone" ? "Mobile number" : "Pickup email"}
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
            <p>No contact details are required for your dine-in order.</p>
          )}
          <label>
            Receipt
            <select
              value={draft.receipt.choice}
              onChange={(event) =>
                edit({
                  receipt:
                    event.target.value === "TransactionalEmail"
                      ? { choice: "TransactionalEmail", email: "" }
                      : { choice: "InSession", email: null },
                })
              }
            >
              <option value="InSession">View receipt here</option>
              <option value="TransactionalEmail">Email my receipt</option>
            </select>
          </label>
          {draft.receipt.choice === "TransactionalEmail" ? (
            <label>
              Receipt email
              <input
                required
                type="email"
                maxLength={254}
                value={draft.receipt.email}
                onChange={(event) =>
                  edit({ receipt: { choice: "TransactionalEmail", email: event.target.value } })
                }
              />
            </label>
          ) : null}
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
              I have read and agree to the policies above
            </label>
          ) : null}
        </fieldset>
        {expired ? (
          <p role="alert">
            Checkout information expired. Get a current quote and reload details before saving.
          </p>
        ) : null}
        {!online ? (
          <p role="status">You are offline. Your details will not be submitted automatically.</p>
        ) : null}
        {save.status === "pending" ? <p role="status">Saving checkout details…</p> : null}
        {save.status === "saved" && !dirty ? <p role="status">Checkout details saved.</p> : null}
        {save.status === "invalid" ? (
          <p role="alert">
            Check your contact and receipt fields. Enter a mobile number such as 416 555 0123, or
            include the country code for numbers outside North America.
          </p>
        ) : null}
        {["conflict", "policy", "requote", "denied"].includes(save.status) ? (
          <p role="alert">Your checkout changed. Reload details before trying again.</p>
        ) : null}
        {uncertain ? (
          <>
            <p role="alert">
              The save result is not confirmed. Retry the same request before changing these
              details.
            </p>
            <button
              type="button"
              disabled={!online}
              onClick={() => {
                void saver.retry().then(savedRevision);
              }}
            >
              Retry saving details
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
            Save details
          </button>
        )}
        <button
          type="button"
          className="checkout-details-form__reload"
          disabled={busy || !online}
          onClick={() => void load()}
        >
          Reload checkout details
        </button>
      </form>
    </section>
  );
}
