import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { SourceTime } from "./StoreTime.js";
import { createCounterOrderClient, type CounterMenuItem } from "./staff-order-entry.js";
import {
  StoreFeaturesClientError,
  type StoreFeatures,
  type StoreFeaturesClient,
} from "./store-features-client.js";

/**
 * WP-2423 item 8 ⑦ 4b-2 (Owner decision 2, coordinator 2026-10-29): the per-head tea charge. None
 * until the owner chooses the dine-in menu item charged per guest; then recording how many guests
 * sit at a table that pays at the end adds that many to its bill. Tables that pay each round get
 * none (known limit). Saved on its own, against the version the owner saw.
 */
export function StoreTeaCharge({
  csrf,
  view,
  client,
  locked,
  onSaved,
  menu: injectedMenu,
}: {
  readonly csrf: string;
  readonly view: StoreFeatures;
  readonly client: StoreFeaturesClient;
  readonly locked: boolean;
  readonly onSaved: (next: StoreFeatures) => void;
  readonly menu?: () => Promise<readonly CounterMenuItem[]>;
}) {
  const [items, setItems] = useState<readonly CounterMenuItem[] | null>(null);
  const [menuProblem, setMenuProblem] = useState(false);
  const [chosen, setChosen] = useState<string>(view.teaCharge.teaSellableReference ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  useEffect(() => setChosen(view.teaCharge.teaSellableReference ?? ""), [view.teaCharge]);
  useEffect(() => {
    let active = true;
    const load =
      injectedMenu ??
      (async () =>
        (await createCounterOrderClient(csrf).loadMenu(undefined, "DineIn")).sections.flatMap(
          (section) => section.items,
        ));
    void load()
      .then((value) => {
        if (active) setItems(value);
      })
      .catch(() => {
        if (active) setMenuProblem(true);
      });
    return () => {
      active = false;
    };
  }, [csrf, injectedMenu]);
  const current = view.teaCharge.teaSellableReference ?? "";
  const save = async () => {
    if (busy || locked || chosen === current) return;
    const key = `${view.teaCharge.version}:${chosen}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setMessage(null);
    try {
      const next = await client.changeTeaCharge({
        operationReference: operation.current.reference,
        expectedVersion: view.teaCharge.version,
        teaSellableReference: chosen === "" ? null : chosen,
      });
      operation.current = null;
      onSaved(next);
      setMessage({
        tone: "status",
        text:
          chosen === ""
            ? t("Saved. No tea charge is added from now on.")
            : t("Saved. Tea is added for each guest from the next party size recorded."),
      });
    } catch (error) {
      operation.current = null;
      setMessage({
        tone: "alert",
        text:
          error instanceof StoreFeaturesClientError && error.code === "Changed"
            ? t(
                "Someone else changed these settings. The page now shows them; check and save again.",
              )
            : t("This wasn't saved. Check the connection and try again."),
      });
    } finally {
      setBusy(false);
    }
  };
  const named = (item: CounterMenuItem) =>
    item.priceMinor === null
      ? item.name
      : `${item.name} · $${(Number(item.priceMinor) / 100).toFixed(2)}`;
  return (
    <fieldset className="store-features__modules" disabled={busy || locked}>
      <legend>{t("Tea charge")}</legend>
      <p className="store-features__detail">
        {t(
          "Choose the menu item charged per guest. When staff record how many guests sit at a table, that many are added to its bill; it is shown to guests as tea per person.",
        )}
      </p>
      <p className="store-features__detail" role="note">
        {t(
          "Tea is only added at tables that pay at the end. Tables that pay for each round are not charged tea automatically.",
        )}
      </p>
      <label className="store-features__row">
        <span>{t("Tea charge item")}</span>
        <select value={chosen} onChange={(event) => setChosen(event.currentTarget.value)}>
          <option value="">{t("No tea charge")}</option>
          {(items ?? []).map((item) => (
            <option key={item.sellableReference} value={item.sellableReference}>
              {named(item)}
            </option>
          ))}
          {chosen !== "" && items !== null && !items.some((i) => i.sellableReference === chosen) ? (
            <option value={chosen}>{t("The item set before (no longer on the menu)")}</option>
          ) : null}
        </select>
      </label>
      {menuProblem ? (
        <p role="alert">{t("The menu could not be read, so the items can't be listed.")}</p>
      ) : null}
      <p className="store-features__detail">
        {t(
          "Mark that item “Not prepared by the kitchen” on the menu, so it never goes to the kitchen board.",
        )}
      </p>
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          disabled={busy || locked || chosen === current}
          onClick={() => void save()}
        >
          {t("Save tea charge")}
        </button>
        {view.teaCharge.changedAt === null ? null : (
          <span className="store-features__changed">
            {t("Last changed")} <SourceTime instant={view.teaCharge.changedAt} />
          </span>
        )}
      </div>
      {message ? <p role={message.tone}>{message.text}</p> : null}
    </fieldset>
  );
}
