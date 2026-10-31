import { useState } from "react";
import { FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { orderMoney } from "./order-money.js";
import {
  centsFromDollars,
  chargedHere,
  StorePriceError,
  type ChangeStorePrice,
  type StorePrice,
  type StorePriceErrorCode,
} from "./store-prices-client.js";

const money = (minor: string | null) =>
  minor === null ? t("No price") : orderMoney({ amountMinor: minor, currencyCode: "CAD" });
export const storePriceErrorText: Record<StorePriceErrorCode, string> = {
  PermissionDenied: t("You do not have permission to change prices at this Store."),
  NotFound: t("This item has no Brand price yet."),
  Invalid: t("That price is not valid."),
  Changed: t(
    "The price changed since you opened the page. Check the price now shown and confirm again.",
  ),
  NoPriceBook: t("This Store has no prices yet. The Brand Owner lists the menu first."),
  NotMultiStore: t("At a Brand with one Store, change prices on the menu page."),
  NotCovered: t("Some items this Store sells have no price."),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  Offline: t("Offline. Nothing was confirmed; try again when you are back online."),
  Unavailable: t("Prices are unavailable right now. Nothing was changed."),
};

/**
 * DEC-BRAND-MULTI-STORE segment 9: one item's price at this Store, and (for whoever may change it)
 * changing it here: type the new price, then confirm "from old to new" before it takes effect.
 */
export function StorePriceCell({
  item,
  price,
  mayChange,
  busy,
  onChange,
}: {
  readonly item: string;
  readonly price: StorePrice | undefined;
  readonly mayChange: boolean;
  readonly busy: boolean;
  /** Sends the change; resolves when it is done, rejects with a StorePriceError. */
  readonly onChange: (command: ChangeStorePrice, done: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  // The change confirmed (kept for a retry with the same operation), or null while typing.
  const [confirming, setConfirming] = useState<ChangeStorePrice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const charged = chargedHere(price);
  const own = price?.storePriceMinor ?? null;
  const brand = price?.brandPriceMinor ?? null;
  const ask = (amountMinor: string | null) => {
    if (charged === null) return;
    setProblem(null);
    setConfirming({
      action: "ChangeStorePrice",
      operationReference: newOperationReference(),
      sellableReference: price?.sellableReference ?? "",
      expectedAmountMinor: charged,
      amountMinor,
    });
  };
  const close = () => {
    setEditing(false);
    setConfirming(null);
    setValue("");
    setProblem(null);
  };
  const confirm = async () => {
    if (confirming === null) return;
    const next = confirming.amountMinor ?? brand;
    try {
      await onChange(
        confirming,
        t("{item} now costs {price} at this Store.", { item, price: money(next) }),
      );
      close();
    } catch (error) {
      const code = error instanceof StorePriceError ? error.code : "Unavailable";
      // A refused change starts again from the price now shown; an unanswered one is retried as is.
      if (code !== "Offline" && code !== "Unavailable") {
        setConfirming(null);
        setEditing(false);
        setValue("");
      }
      setProblem(storePriceErrorText[code]);
    }
  };
  return (
    <div className="store-price">
      <span>{money(charged)}</span>
      {own !== null ? (
        <p className="store-price__note">
          {t("This Store's price; Brand price {price}", { price: money(brand) })}
        </p>
      ) : null}
      {mayChange && charged !== null && !editing ? (
        <button
          type="button"
          disabled={busy}
          aria-label={t("Change the price of {item} at this Store", { item })}
          onClick={() => {
            setProblem(null);
            setEditing(true);
          }}
        >
          {t("Change price")}
        </button>
      ) : null}
      {editing && confirming === null ? (
        <form
          className="store-price__form"
          onSubmit={(event) => {
            event.preventDefault();
            const cents = centsFromDollars(value);
            if (cents === null) {
              setProblem(t("Enter a price such as 7.25."));
              return;
            }
            ask(cents === brand ? null : cents);
          }}
        >
          <label>
            {t("New price for {item} at this Store", { item })}
            <input
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <button type="submit">{t("Continue")}</button>
          {own !== null ? (
            <button type="button" onClick={() => ask(null)}>
              {t("Use the Brand price ({price})", { price: money(brand) })}
            </button>
          ) : null}
          <button type="button" onClick={close}>
            {t("Cancel")}
          </button>
        </form>
      ) : null}
      {confirming !== null ? (
        <div className="store-price__confirm" role="group" aria-label={t("Confirm the price")}>
          <p>
            {t("Change {item} at this Store from {old} to {new}? Guests here see it at once.", {
              item,
              old: money(confirming.expectedAmountMinor),
              new: money(confirming.amountMinor ?? brand),
            })}
          </p>
          <div className="store-price__buttons">
            <button type="button" disabled={busy} onClick={() => void confirm()}>
              {t("Change price")}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {problem !== null ? (
        <p className="store-price__problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
