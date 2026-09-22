import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
export function CheckoutDetailsForm({
  selection: provided,
  now = Date.now,
  onBusyChange,
  onReadyChange,
}: {
  readonly selection: CheckoutFormSelection;
  readonly now?: () => number;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onReadyChange?: (selection: CheckoutFormSelection | null) => void;
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
      policies: policy.documents.map((document) => ({
        documentReference: document.documentReference,
        documentVersion: document.documentVersion,
        documentDigest: document.documentDigest,
        purposeCode: document.purposeCode,
      })),
    });
    savedRevision();
  };
  if (loading)
    return (
      <section aria-label="Checkout details">
        <p role="status">Loading checkout details…</p>
      </section>
    );
  if (failed || !authorized || draft === null || policy === null)
    return (
      <section aria-label="Checkout details">
        <p role="alert">Checkout details are unavailable. Refresh your checkout to try again.</p>
        <button type="button" disabled={!online || busy} onClick={() => void load()}>
          Reload checkout details
        </button>
      </section>
    );
  const contact = draft.pickupContact;
  return (
    <section aria-labelledby="checkout-details-heading">
      <h2 id="checkout-details-heading">Contact and receipt</h2>
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
            {selection.orderType === "Pickup" ? "Pickup contact" : "Receipt preferences"}
          </legend>
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
                {draft.pickupContact.channel === "Phone"
                  ? "Phone number (include country code)"
                  : "Pickup email"}
                <input
                  required
                  type={draft.pickupContact.channel === "Phone" ? "tel" : "email"}
                  pattern={
                    draft.pickupContact.channel === "Phone" ? "[+][1-9][0-9]{6,14}" : undefined
                  }
                  maxLength={draft.pickupContact.channel === "Phone" ? 16 : 254}
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
            Check your contact and receipt fields. Phone numbers must include a country code.
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
        <button
          type="submit"
          disabled={
            busy || !online || expired || !dirty || (policy.documents.length > 0 && !confirmed)
          }
        >
          Save checkout details
        </button>
        <button type="button" disabled={busy || !online} onClick={() => void load()}>
          Reload checkout details
        </button>
      </form>
    </section>
  );
}
