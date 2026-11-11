import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CHINESE_LOCALE, currentLanguage, t } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
import type { CartLinePrice } from "../menu/menu-line-prices.js";
import {
  createCheckoutScopeClient,
  type CheckoutScopeClient,
  type CheckoutScopeCommand,
  type CheckoutScopeOutcome,
} from "./checkout-scope-client.js";
import type { CartTablePay, CartView } from "./types.js";

/**
 * WP-2423 shared-table-checkout (a), pay first (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账: 默认付全桌,
 * 只付我加的, 选几道菜帮别人付). The payer of a round chooses its dishes; what they don't choose waits
 * for the next round and comes back to the cart. Every phone sees plainly what waits and whether
 * someone is paying; the payer is warned before their choice stops being kept (AGENTS.md "Warn
 * before timeouts"). No phone, guest or reference is ever named.
 */

/** A dish's menu name in the guest's language (the menu's when there is none), or "A dish". */
export function waitingDishName(names: Readonly<Record<string, string>>): string {
  const chosen =
    currentLanguage() === "zh-Hans"
      ? (names[CHINESE_LOCALE] ?? Object.values(names)[0])
      : (Object.entries(names).find(([locale]) => locale.startsWith("en"))?.[1] ??
        Object.values(names)[0]);
  return chosen === undefined || chosen.trim() === "" ? t("A dish") : chosen;
}

/** One tap = one operation reference, kept until it is answered (a lost answer is resent). */
function useScopeCommand(client: CheckoutScopeClient) {
  const pending = useRef<{ readonly key: string; readonly reference: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (command: CheckoutScopeCommand): Promise<CheckoutScopeOutcome> => {
    const key = JSON.stringify(command);
    if (pending.current?.key !== key)
      pending.current = { key, reference: client.newOperationReference() };
    setBusy(true);
    try {
      const outcome = await client.send(pending.current.reference, command);
      if (outcome.status !== "Unknown") pending.current = null;
      return outcome;
    } finally {
      setBusy(false);
    }
  };
  return { send, busy };
}

let sharedClient: CheckoutScopeClient | null = null;
export const browserCheckoutScopeClient = () => (sharedClient ??= createCheckoutScopeClient());

/**
 * The dishes waiting for the next round, and who they wait on. Shown on every phone at the table.
 */
export function TableWaitingDishes({ tablePay }: { readonly tablePay: CartTablePay }) {
  const otherPaying =
    tablePay.payer !== null && !tablePay.payer.thisPhone && tablePay.payer.reserved;
  if (tablePay.waiting.length === 0 && !otherPaying) return null;
  return (
    <section className="cart-waiting" aria-labelledby="cart-waiting-heading">
      {otherPaying ? (
        <p className="cart-stale" role="status">
          {tablePay.waiting.some((line) => line.mine)
            ? t(
                "Someone at your table is paying for their dishes. Yours are kept and come back here when they finish.",
              )
            : t("Someone at your table is paying for their dishes. Wait until they finish.")}
        </p>
      ) : null}
      {tablePay.waiting.length === 0 ? null : (
        <>
          <h2 id="cart-waiting-heading">{t("Next round")}</h2>
          <p className="cart-waiting__note">
            {tablePay.returnable && tablePay.payer?.thisPhone !== true
              ? t("Putting these dishes back in the cart…")
              : t("These dishes come back to the cart when the payment is done.")}
          </p>
          <ul>
            {tablePay.waiting.map((line) => (
              <li key={line.waitingLineReference}>
                <span>
                  {waitingDishName(line.names)}
                  {line.withOptions ? <small> · {t("options chosen")}</small> : null}
                  {line.mine ? <small> · {t("you added")}</small> : null}
                </span>
                <span>×{line.quantity}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Gives the waiting dishes back to the cart once nobody is paying for them (the server says
 * `returnable`). A read never writes: this phone asks, once per cart version, and reads again.
 * The payer's own phone never does this by itself: its choice ends only by its own "Back to cart"
 * (or the round being sent), so a lapsed reservation never cancels it behind the payer's back.
 * Someone else started paying meanwhile, or the store couldn't be reached: it asks again after
 * the wait the store named (or a few seconds), still at most once per cart version that succeeds.
 */
export function useWaitingReturn(
  cart: CartView | null,
  reload: () => void,
  client: CheckoutScopeClient = browserCheckoutScopeClient(),
) {
  const { send } = useScopeCommand(client);
  const asked = useRef<number | null>(null);
  const [retry, setRetry] = useState(0);
  const version = cart?.cart.version ?? null;
  const payerHere = cart?.cart.tablePay?.payer?.thisPhone === true;
  const returnable = cart?.cart.tablePay?.returnable === true && !payerHere;
  useEffect(() => {
    if (!returnable || version === null || asked.current === version) return;
    asked.current = version;
    let timer: number | undefined;
    let live = true;
    void send({ action: "Return" }).then((outcome) => {
      if (!live) return;
      if (outcome.status === "Unknown" || outcome.status === "OtherPaying") {
        asked.current = null;
        const seconds = outcome.status === "OtherPaying" ? outcome.retryAfterSeconds : 5;
        timer = window.setTimeout(() => setRetry((n) => n + 1), seconds * 1000);
      }
      if (outcome.status !== "OtherPaying") reload();
    });
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [returnable, version, retry]);
}

type Scope = "Whole" | "Mine" | "Chosen";

/**
 * Before paying a round at a table whose cart holds other phones' dishes: which dishes this round
 * pays. Starts on the Store's choice. "Continue" goes to the ordinary checkout of the dishes chosen.
 */
export function TablePayChooser({
  cart,
  prices,
  onChanged,
  client = browserCheckoutScopeClient(),
}: {
  readonly cart: CartView;
  readonly prices: ReadonlyMap<string, CartLinePrice | null>;
  /** The cart changed under the choice (or now is the round): read it again. */
  readonly onChanged: () => void;
  readonly client?: CheckoutScopeClient;
}) {
  const navigate = useNavigate();
  const onContinue = () => {
    onChanged();
    void navigate("/checkout");
  };
  const items = cart.cart.items;
  const mine = items.filter((item) => !item.warnings.includes("OTHER_PARTICIPANT_ITEM"));
  const startWith: Scope =
    cart.cart.tablePay?.defaultChoice === "OwnDishes" && mine.length > 0 ? "Mine" : "Whole";
  const [scope, setScope] = useState<Scope>(startWith);
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(new Map());
  const [problem, setProblem] = useState<string | null>(null);
  const { send, busy } = useScopeCommand(client);
  const sum = (lines: readonly { readonly reference: string; readonly units: number }[]) => {
    let total = 0n;
    let currency: string | null = null;
    for (const line of lines) {
      const item = items.find((candidate) => candidate.cartItemReference === line.reference);
      const price = prices.get(line.reference);
      if (item === undefined || price === null || price === undefined) return null;
      if (currency !== null && price.currency !== currency) return null;
      currency = price.currency;
      // The line's price is for all its units; a part is priced by the server on the next step.
      if (line.units !== item.quantity) return null;
      total += price.amountMinor;
    }
    return currency === null ? null : formatMoney(total, currency);
  };
  const count = (lines: readonly { readonly units: number }[]) =>
    lines.reduce((total, line) => total + line.units, 0);
  const wholeLines = items.map((item) => ({
    reference: item.cartItemReference,
    units: item.quantity,
  }));
  const mineLines = mine.map((item) => ({
    reference: item.cartItemReference,
    units: item.quantity,
  }));
  const chosenLines = items
    .map((item) => ({
      reference: item.cartItemReference,
      units: Math.min(quantities.get(item.cartItemReference) ?? 0, item.quantity),
    }))
    .filter((line) => line.units > 0);
  const wholeAmount = sum(wholeLines);
  const mineAmount = sum(mineLines);
  const proceed = async () => {
    setProblem(null);
    if (scope === "Whole") return onContinue();
    const outcome = await send({
      action: "Choose",
      cartReference: cart.cart.cartReference,
      expectedCartVersion: cart.cart.version,
      choice: scope,
      lines:
        scope === "Mine"
          ? []
          : chosenLines.map((line) => ({
              cartItemReference: line.reference,
              quantity: line.units,
            })),
    });
    if (outcome.status === "Chosen" || outcome.status === "WholeCart") return onContinue();
    if (outcome.status === "NothingChosen")
      return setProblem(t("There is nothing of yours in the cart to pay for."));
    if (outcome.status === "OtherPaying")
      return setProblem(
        t("Someone at your table is paying now. Try again in {seconds} seconds.", {
          seconds: String(outcome.retryAfterSeconds),
        }),
      );
    if (outcome.status === "Changed") {
      setProblem(t("The cart just changed. Check the dishes and choose again."));
      return onChanged();
    }
    setProblem(t("We couldn't reach the store. Try again; nothing was charged."));
  };
  return (
    <fieldset className="dining-session__pay-scope cart-pay-scope">
      <legend>{t("Which dishes are you paying for?")}</legend>
      <label>
        <input
          type="radio"
          name="cart-pay-scope"
          checked={scope === "Whole"}
          onChange={() => setScope("Whole")}
        />{" "}
        {wholeAmount === null
          ? t("The whole table ({count} dishes)", { count: String(count(wholeLines)) })
          : t("The whole table ({count} dishes · {amount})", {
              count: String(count(wholeLines)),
              amount: wholeAmount,
            })}
      </label>
      {mine.length === 0 ? null : (
        <label>
          <input
            type="radio"
            name="cart-pay-scope"
            checked={scope === "Mine"}
            onChange={() => setScope("Mine")}
          />{" "}
          {mineAmount === null
            ? t("Only what I added ({count})", { count: String(count(mineLines)) })
            : t("Only what I added ({count} · {amount})", {
                count: String(count(mineLines)),
                amount: mineAmount,
              })}
        </label>
      )}
      <label>
        <input
          type="radio"
          name="cart-pay-scope"
          checked={scope === "Chosen"}
          onChange={() => setScope("Chosen")}
        />{" "}
        {t("Choose dishes to pay for")}
      </label>
      {scope === "Chosen" ? (
        <ul className="dining-session__pay-choose">
          {items.map((item) => {
            const quantity = Math.min(quantities.get(item.cartItemReference) ?? 0, item.quantity);
            const name = item.displayName || t("A dish");
            const set = (next: number) =>
              setQuantities((current) => new Map(current).set(item.cartItemReference, next));
            return (
              <li key={item.cartItemReference}>
                <span className="dining-session__pay-dish">
                  {name}
                  {item.warnings.includes("OTHER_PARTICIPANT_ITEM") ? null : (
                    <small> · {t("you added")}</small>
                  )}
                  {item.quantity > 1 ? (
                    <small> · {t("{count} in the cart", { count: String(item.quantity) })}</small>
                  ) : null}
                </span>
                <span className="dining-session__pay-stepper">
                  <button
                    type="button"
                    aria-label={t("One less {dish}", { dish: name })}
                    disabled={quantity === 0}
                    onClick={() => set(quantity - 1)}
                  >
                    −
                  </button>
                  <output aria-live="polite">{quantity}</output>
                  <button
                    type="button"
                    aria-label={t("One more {dish}", { dish: name })}
                    disabled={quantity >= item.quantity}
                    onClick={() => set(quantity + 1)}
                  >
                    +
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="dining-session__pay-note">
        {scope === "Whole"
          ? t("Tax shows on the next step.")
          : t(
              "Dishes you don't choose stay for the others at your table. Tax shows on the next step.",
            )}
      </p>
      {problem === null ? null : <p role="alert">{problem}</p>}
      <button
        className="cart-checkout-link"
        type="button"
        disabled={busy || (scope === "Chosen" && chosenLines.length === 0)}
        onClick={() => void proceed()}
      >
        {busy ? t("One moment…") : t("Continue to pay")}
      </button>
    </fieldset>
  );
}

/**
 * On the payer's own cart while their choice is kept: what this round is, the way back, and, as on
 * the checkout page, the warning a minute before the choice stops being kept with "Keep them".
 */
export function PayerChoiceBanner({
  payer,
  now,
  onCancelled,
  client = browserCheckoutScopeClient(),
}: {
  readonly payer: NonNullable<CartTablePay["payer"]>;
  readonly now?: () => number;
  /** The choice ended (went back, or the cart changed): read the cart again. */
  readonly onCancelled: () => void;
  readonly client?: CheckoutScopeClient;
}) {
  const { send, busy } = useScopeCommand(client);
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = async () => {
    setProblem(null);
    const outcome = await send({ action: "Cancel" });
    if (outcome.status === "Unknown")
      return setProblem(t("We couldn't reach the store. Try again; nothing was charged."));
    onCancelled();
  };
  return (
    <section className="cart-pay-scope cart-pay-scope--chosen" aria-labelledby="cart-payer-heading">
      <h2 id="cart-payer-heading">{t("You're paying for the dishes in this cart")}</h2>
      <p>{t("The others' dishes wait for the next round.")}</p>
      <ScopeExpiryWarning
        payer={payer}
        {...(now === undefined ? {} : { now })}
        onBack={onCancelled}
        onEnded={onCancelled}
        client={client}
        withBack={false}
      />
      <Link className="cart-checkout-link" to="/checkout">
        {t("Continue to pay")}
      </Link>
      <button type="button" disabled={busy} onClick={() => void cancel()}>
        {t("Back to cart (your choice is cancelled; nothing was charged)")}
      </button>
      {problem === null ? null : <p role="alert">{problem}</p>}
    </section>
  );
}

/** Seconds before the payer's choice stops being kept that the warning shows. */
export const scopeWarningSeconds = 60;

/**
 * On the checkout page of the payer: a minute before their choice of dishes stops being kept,
 * "Keep them" (another 5 minutes) or "Back to cart". Once it ran out the others may take their
 * dishes back; keeping them is still possible until they do.
 */
export function ScopeExpiryWarning({
  payer,
  now = Date.now,
  onBack,
  onEnded,
  client = browserCheckoutScopeClient(),
  withBack = true,
}: {
  readonly payer: NonNullable<CartTablePay["payer"]>;
  /** False where the page already shows its own "Back to cart". */
  readonly withBack?: boolean;
  readonly now?: () => number;
  /** The payer went back: the cart has every dish again. */
  readonly onBack: () => void;
  /** The choice can't be kept any more (the cart changed): read the cart again. */
  readonly onEnded: () => void;
  readonly client?: CheckoutScopeClient;
}) {
  const [expiresAt, setExpiresAt] = useState(Date.parse(payer.expiresAt));
  useEffect(() => setExpiresAt(Date.parse(payer.expiresAt)), [payer.expiresAt]);
  const [, tick] = useState(0);
  const remaining = Math.ceil((expiresAt - now()) / 1000);
  const visible = remaining <= scopeWarningSeconds;
  useEffect(() => {
    // Each second while it shows; otherwise once, when it is due.
    const wait = visible ? 1000 : Math.max(1000, (remaining - scopeWarningSeconds) * 1000);
    const timer = window.setTimeout(() => tick((n) => n + 1), wait);
    return () => window.clearTimeout(timer);
  });
  const { send, busy } = useScopeCommand(client);
  const [problem, setProblem] = useState<string | null>(null);
  if (!visible) return null;
  const keep = async () => {
    setProblem(null);
    const outcome = await send({ action: "Extend" });
    if (outcome.status === "Extended") return setExpiresAt(Date.parse(outcome.expiresAt));
    if (outcome.status === "NotLive") return onEnded();
    setProblem(t("We couldn't reach the store. Try again; nothing was charged."));
  };
  const back = async () => {
    setProblem(null);
    const outcome = await send({ action: "Cancel" });
    if (outcome.status === "Unknown")
      return setProblem(t("We couldn't reach the store. Try again; nothing was charged."));
    onBack();
  };
  return (
    <section className="checkout-attention" role="alert">
      <p>
        {remaining > 0
          ? t("The dishes you chose are kept for {seconds} more seconds.", {
              seconds: String(remaining),
            })
          : t(
              "The dishes you chose are no longer kept: the others at your table can take theirs back.",
            )}
      </p>
      <div className="cart-state__actions">
        <button type="button" disabled={busy} onClick={() => void keep()}>
          {t("Keep them")}
        </button>
        {withBack ? (
          <button type="button" disabled={busy} onClick={() => void back()}>
            {t("Back to cart")}
          </button>
        ) : null}
      </div>
      {problem === null ? null : <p>{problem}</p>}
    </section>
  );
}

/** Another phone is paying for dishes it chose: nobody else can pay this cart until it finishes. */
export function OtherPayerWaits() {
  return (
    <button className="cart-checkout-link" type="button" disabled>
      {t("Someone at your table is paying")}
    </button>
  );
}
