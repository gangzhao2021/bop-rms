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
  createOrderMessageOptionsClient,
  noOrderMessages,
  type OrderMessageOptions,
} from "./order-messages-client.js";
import {
  CheckoutDetailsClientError,
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
  /**
   * WP-2423 M112: check the details before saving. On a problem the field is marked, explained,
   * scrolled into view and focused, and its name is returned; null when nothing needs fixing.
   */
  validate(): DetailsField | null;
}

/** WP-2423 M112: the fields Continue can send the guest to. */
export type DetailsField = "name" | "value" | "receiptEmail" | "policies";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+[1-9][0-9]{6,14}$/u;

/**
 * WP-2423 M112: the first field that would be refused (the same rules the Store applies), or null.
 */
export function firstDetailsProblem(
  draft: Pick<CheckoutDetailsDraft, "pickupContact" | "receipt">,
  policiesToAccept: number,
  accepted: boolean,
): DetailsField | null {
  const contact = draft.pickupContact;
  if (contact !== null) {
    const name = contact.name.trim();
    if (name.length < 1 || name.length > 120) return "name";
    if (contact.channel === "Phone" && !phonePattern.test(normalizePhoneNumber(contact.value)))
      return "value";
    if (contact.channel === "Email" && !emailPattern.test(contact.value.trim())) return "value";
  }
  if (
    draft.receipt.choice === "TransactionalEmail" &&
    !emailPattern.test(draft.receipt.email.trim())
  )
    return "receiptEmail";
  if (policiesToAccept > 0 && !accepted) return "policies";
  return null;
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
  onCheckoutChanged,
  payLater = false,
  ref,
}: {
  /**
   * WP-2423 item 6: a table that pays at the end comes here only for the Store's documents, so that
   * is all the form asks: no receipt choice, no save or reload of its own (the one button does it).
   */
  readonly payLater?: boolean;
  readonly selection: CheckoutFormSelection;
  readonly now?: () => number;
  /** Contact typed but not yet saved, held by the page so a re-price does not clear it. */
  readonly unsavedContact?: PickupContactDraft | null;
  readonly onUnsavedContactChange?: (contact: PickupContactDraft | null) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onReadyChange?: (selection: CheckoutFormSelection | null) => void;
  /** Whether a save could be attempted now (details loaded, policies accepted, online, not expired). */
  readonly onSubmittableChange?: (submittable: boolean) => void;
  /**
   * WP-2423 live minor 24: the cart moved under this checkout (details answered "changed"): the
   * page reads the cart again — an order placed from it in another tab then shows as that order,
   * never a details form that keeps answering the same conflict.
   */
  readonly onCheckoutChanged?: () => void;
  readonly ref?: React.Ref<CheckoutDetailsFormHandle>;
}) {
  const [selection] = useState(() => Object.freeze({ ...provided }));
  const [reader] = useState(createCheckoutDetailsReadClient);
  const [policies] = useState(() => createCheckoutPolicyClient(now));
  const [messageOptions] = useState(createOrderMessageOptionsClient);
  const [messages, setMessages] = useState<OrderMessageOptions>(noOrderMessages);
  const [saver] = useState(() => createCheckoutDetailsController(createCheckoutDetailsClient()));
  const save = useSyncExternalStore(saver.subscribe, saver.getState, saver.getState);
  const [draft, setDraft] = useState<CheckoutDetailsDraft | null>(null);
  const [policy, setPolicy] = useState<CheckoutPolicyView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState(true);
  /** WP-2423 M112: the field Continue found a problem with (marked until the guest edits it). */
  const [problem, setProblem] = useState<DetailsField | null>(null);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const [, tick] = useState(0);
  const generation = useRef(0);
  const unsaved = useRef(unsavedContact);
  unsaved.current = unsavedContact;
  const context = useRef<(() => boolean) | null>(null);
  const changed = useRef(onCheckoutChanged);
  changed.current = onCheckoutChanged;
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
      // Only once this checkout's details are readable: which order messages can be sent now.
      const channels = payLater ? noOrderMessages : await messageOptions.read();
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
        // WP-2423 Q10 / DEC-PILOT-NOTIFICATIONS: "Email my receipt" is offered (and an address
        // collected) only while the store's email account can send; otherwise the receipt is on
        // the order page.
        receipt:
          channels.email && prior?.receipt.choice === "TransactionalEmail"
            ? prior.receipt
            : { choice: "InSession", email: null },
        policies: [],
      });
      setPolicy(requirements);
      setMessages(channels);
      setDirty(true);
    } catch (error) {
      if (run === generation.current) setFailed(true);
      if (
        run === generation.current &&
        error instanceof CheckoutDetailsClientError &&
        error.code === "conflict"
      )
        changed.current?.();
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [payLater, policies, reader, selection]);
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
  useEffect(() => {
    if (save.status === "conflict") changed.current?.();
  }, [save.status]);
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
    draft !== null && policy !== null && !expired && online && authorized && !busy && !failed;
  useEffect(() => {
    onSubmittableChange?.(submittable);
    return () => onSubmittableChange?.(false);
  }, [onSubmittableChange, submittable]);

  const edit = (patch: Partial<Pick<CheckoutDetailsDraft, "pickupContact" | "receipt">>) => {
    if (busy || !authorized || !online || expired) return;
    setProblem(null);
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
  const showProblem = (field: DetailsField) => {
    setProblem(field);
    // After the marked field renders: bring it into view and put the cursor in it.
    window.setTimeout(() => {
      const element = document.getElementById("checkout-details-" + field);
      element?.scrollIntoView({ block: "center" });
      element?.focus();
    }, 0);
  };
  const validate = (): DetailsField | null => {
    if (draft === null || policy === null) return null;
    const field = firstDetailsProblem(draft, policy.documents.length, confirmed);
    if (field !== null) showProblem(field);
    return field;
  };
  useImperativeHandle(ref, () => ({ save: submit, validate }));
  // A server "invalid" answer goes to the field too (the first one the rules find, else the name).
  useEffect(() => {
    if (save.status !== "invalid" || draft === null || policy === null) return;
    showProblem(firstDetailsProblem(draft, policy.documents.length, confirmed) ?? "name");
    // Once per answer.
  }, [save.status]);
  const fieldProps = (field: DetailsField) => ({
    id: "checkout-details-" + field,
    "aria-invalid": problem === field ? (true as const) : undefined,
    "aria-describedby": problem === field ? "checkout-details-" + field + "-error" : undefined,
  });
  const fieldError = (field: DetailsField, text: string) =>
    problem === field ? (
      <span className="checkout-details-form__error" id={"checkout-details-" + field + "-error"}>
        {text}
      </span>
    ) : null;
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
  if (payLater)
    return policy.documents.length === 0 ? null : (
      <section aria-label={checkoutText.detailsLabel}>
        <form
          className="checkout-details-form"
          autoComplete="off"
          onSubmit={(event) => event.preventDefault()}
        >
          <fieldset disabled={busy || !online || expired}>
            {policy.documents.map((document) => (
              <details key={document.documentReference}>
                <summary>{document.title}</summary>
                <p style={{ whiteSpace: "pre-wrap" }}>{document.bodyText}</p>
              </details>
            ))}
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
          </fieldset>
          {expired ? <p role="alert">{checkoutText.detailsExpired}</p> : null}
          {["conflict", "policy", "requote", "denied", "invalid"].includes(save.status) ? (
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
        </form>
      </section>
    );
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
              {draft.pickupContact !== null &&
              (draft.pickupContact.channel === "Phone" ? messages.sms : messages.email) ? (
                <>
                  {" "}
                  {draft.pickupContact.channel === "Phone"
                    ? checkoutText.orderTextsPhone
                    : checkoutText.orderTextsEmail}
                </>
              ) : null}
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
                  {...fieldProps("name")}
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
                {fieldError("name", checkoutText.enterYourName)}
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
                  {...fieldProps("value")}
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
                {fieldError(
                  "value",
                  draft.pickupContact.channel === "Phone"
                    ? checkoutText.enterMobileNumber
                    : checkoutText.enterEmail,
                )}
              </label>
            </>
          ) : (
            <p>{checkoutText.dineInNoContact}</p>
          )}
          {messages.email ? (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={draft.receipt.choice === "TransactionalEmail"}
                  onChange={(event) =>
                    edit({
                      receipt: event.target.checked
                        ? { choice: "TransactionalEmail", email: "" }
                        : { choice: "InSession", email: null },
                    })
                  }
                />
                {checkoutText.emailReceipt}
              </label>
              {draft.receipt.choice === "TransactionalEmail" ? (
                <>
                  <p className="checkout-details-form__hint">{checkoutText.receiptEmailPurpose}</p>
                  <label>
                    {checkoutText.receiptEmail}
                    <input
                      {...fieldProps("receiptEmail")}
                      required
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      value={draft.receipt.email}
                      onChange={(event) =>
                        edit({
                          receipt: { choice: "TransactionalEmail", email: event.target.value },
                        })
                      }
                    />
                    {fieldError("receiptEmail", checkoutText.enterEmail)}
                  </label>
                </>
              ) : (
                <p className="checkout-details-form__hint">{checkoutText.receiptOnOrderPage}</p>
              )}
            </>
          ) : (
            <p className="checkout-details-form__hint">{checkoutText.receiptOnOrderPage}</p>
          )}
          {policy.documents.map((document) => (
            <details key={document.documentReference}>
              <summary>{document.title}</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{document.bodyText}</p>
            </details>
          ))}
          {policy.documents.length > 0 ? (
            <label>
              <input
                {...fieldProps("policies")}
                type="checkbox"
                checked={confirmed}
                onChange={(event) => {
                  setProblem(null);
                  setConfirmed(event.target.checked);
                  setDirty(true);
                }}
              />
              {checkoutText.agreePolicies}
              {fieldError("policies", checkoutText.acceptPoliciesToContinue)}
            </label>
          ) : null}
        </fieldset>
        {/* WP-2423 M125: once the hold ended, the page's one message says so; never "saved". */}
        {save.status === "pending" ? <p role="status">{checkoutText.savingDetails}</p> : null}
        {save.status === "saved" && !dirty && !expired ? (
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
        {/* WP-2423 M113: Continue saves the details; no separate Save or Reload here. */}
      </form>
    </section>
  );
}
