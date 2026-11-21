import { useEffect, useRef, useState } from "react";
import { allergenName, currentLanguage, listSeparator, t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";

/**
 * WP-2423 sold-out-and-allergen-safety (M178): what the kitchen says about cross-contact. The
 * owner ticks the allergens the kitchen handles and the equipment it shares; guests read it above
 * every dish's own allergens. Ticks only, so it is always in the guest's language.
 */
export const kitchenEquipment = [
  "Woks",
  "FryerOil",
  "Grill",
  "Utensils",
  "PrepSurfaces",
  "Steamers",
] as const;
export function equipmentText(item: string): string {
  return item === "Woks"
    ? t("Woks")
    : item === "FryerOil"
      ? t("Fryer oil")
      : item === "Grill"
        ? t("Grill")
        : item === "Utensils"
          ? t("Utensils")
          : item === "PrepSurfaces"
            ? t("Prep surfaces")
            : t("Steamers");
}
interface Choice {
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
}
export interface KitchenStatementView {
  readonly statement: {
    readonly handledAllergenCodes: readonly string[];
    readonly sharedEquipment: readonly string[];
  } | null;
  readonly allergenChoices: readonly Choice[];
}
export function parseKitchenStatementView(value: unknown): KitchenStatementView {
  const raw = value as Record<string, unknown> | null;
  const fail = (): never => {
    throw new Error("KITCHEN_STATEMENT_INVALID");
  };
  if (raw === null || typeof raw !== "object" || raw.status !== "Current") return fail();
  const statement = raw.statement as Record<string, unknown> | null;
  const choices = raw.allergenChoices;
  if (!Array.isArray(choices) || choices.length > 64) return fail();
  const codes = (list: unknown, allowed?: readonly string[]) =>
    Array.isArray(list) &&
    list.every(
      (entry) =>
        typeof entry === "string" &&
        (allowed === undefined ? /^[A-Z][A-Z0-9_-]{1,39}$/u.test(entry) : allowed.includes(entry)),
    )
      ? (list as string[])
      : fail();
  return {
    statement:
      statement === null || statement === undefined
        ? null
        : {
            handledAllergenCodes: codes(statement.handledAllergenCodes),
            sharedEquipment: codes(statement.sharedEquipment, kitchenEquipment),
          },
    allergenChoices: choices.map((entry: unknown) => {
      const choice = entry as Record<string, unknown> | null;
      if (
        choice === null ||
        typeof choice.code !== "string" ||
        typeof choice.name !== "string" ||
        typeof choice.nameZh !== "string"
      )
        return fail();
      return { code: choice.code, name: choice.name, nameZh: choice.nameZh };
    }),
  };
}
const choiceText = (choice: Choice) =>
  currentLanguage() === "zh-Hans" && choice.nameZh !== ""
    ? choice.nameZh
    : allergenName(choice.code, choice.name);

async function send(csrf: string, command: unknown): Promise<KitchenStatementView> {
  const response = await fetch("/merchant/store/kitchen-statement", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-bop-csrf": csrf },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(response.status === 403 ? "Denied" : "Unavailable");
  return parseKitchenStatementView(await response.json());
}

export function StoreKitchenStatement({
  csrf,
  locked,
}: {
  readonly csrf: string;
  readonly locked: boolean;
}) {
  const [view, setView] = useState<KitchenStatementView | null>(null);
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const show = (next: KitchenStatementView) => {
    setView(next);
    setHandled(new Set(next.statement?.handledAllergenCodes ?? []));
    setShared(new Set(next.statement?.sharedEquipment ?? []));
  };
  useEffect(() => {
    let live = true;
    send(csrf, { action: "Read" })
      .then((next) => live && show(next))
      .catch(
        () =>
          live &&
          setMessage({
            tone: "alert",
            text: t("The kitchen's allergen statement could not be read."),
          }),
      );
    return () => {
      live = false;
    };
  }, [csrf]);
  const save = async () => {
    if (view === null) return;
    const handledAllergenCodes = view.allergenChoices
      .map((choice) => choice.code)
      .filter((code) => handled.has(code));
    const sharedEquipment = kitchenEquipment.filter((item) => shared.has(item));
    const key = handledAllergenCodes.join(",") + "|" + sharedEquipment.join(",");
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setMessage(null);
    try {
      show(
        await send(csrf, {
          action: "Change",
          operationReference: operation.current.reference,
          handledAllergenCodes,
          sharedEquipment,
        }),
      );
      operation.current = null;
      setMessage({ tone: "status", text: t("Saved. Guests see it on the menu.") });
    } catch {
      setMessage({
        tone: "alert",
        text: t("We couldn't confirm this was saved. Save again: it is never recorded twice."),
      });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (set: ReadonlySet<string>, value: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(value);
    else next.delete(value);
    return next;
  };
  return (
    <fieldset className="store-features__modules" disabled={busy || locked || view === null}>
      <legend>{t("Kitchen allergens")}</legend>
      <p className="store-features__detail">
        {t("Tick what your kitchen uses and shares. Guests read it above every dish's allergens.")}
      </p>
      {view !== null && view.statement === null ? (
        <p className="store-features__detail">{t("Not set yet.")}</p>
      ) : null}
      <p className="store-features__detail">{t("Our kitchen uses:")}</p>
      <div className="table-allergies__choices" role="group" aria-label={t("Our kitchen uses:")}>
        {(view?.allergenChoices ?? []).map((choice) => (
          <label key={choice.code} className="table-allergies__choice">
            <input
              type="checkbox"
              checked={handled.has(choice.code)}
              onChange={(event) =>
                setHandled(toggle(handled, choice.code, event.currentTarget.checked))
              }
            />
            <span>{choiceText(choice)}</span>
          </label>
        ))}
      </div>
      <p className="store-features__detail">{t("Shared in our kitchen:")}</p>
      <div
        className="table-allergies__choices"
        role="group"
        aria-label={t("Shared in our kitchen:")}
      >
        {kitchenEquipment.map((item) => (
          <label key={item} className="table-allergies__choice">
            <input
              type="checkbox"
              checked={shared.has(item)}
              onChange={(event) => setShared(toggle(shared, item, event.currentTarget.checked))}
            />
            <span>{equipmentText(item)}</span>
          </label>
        ))}
      </div>
      {message ? <p role={message.tone === "alert" ? "alert" : "status"}>{message.text}</p> : null}
      <div className="store-features__actions">
        <button type="button" className="store-features__save" onClick={() => void save()}>
          {t("Save kitchen allergens")}
        </button>
      </div>
      {view !== null && handled.size > 0 ? (
        <p className="store-features__detail">
          {t("Guests read: {statement}", {
            statement: [...view.allergenChoices]
              .filter((choice) => handled.has(choice.code))
              .map(choiceText)
              .join(listSeparator()),
          })}
        </p>
      ) : null}
    </fieldset>
  );
}
