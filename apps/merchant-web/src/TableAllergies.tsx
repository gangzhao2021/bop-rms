import { useRef, useState } from "react";
import {
  createDiningSessionClient,
  type StaffDiningTable,
  type StaffTableAllergenChoice,
} from "./dining-session-client.js";
import { allergenName, currentLanguage, listSeparator, t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";

/** An allergen's name in the staff member's language. */
export function tableAllergenText(choice: StaffTableAllergenChoice): string {
  return currentLanguage() === "zh-Hans" && choice.nameZh !== ""
    ? choice.nameZh
    : allergenName(choice.code, choice.name);
}

/**
 * WP-2423 (M171, Owner decision 17): front-of-house ticks the allergens an open table must avoid.
 * Ticks from the Brand's allergen list only (no free text, so nobody writes a name or a health
 * detail); every kitchen ticket of the table then shows them in red. Cleared when the table
 * closes. A save that fails keeps the ticks and says so; pressing again repeats the same
 * operation, so nothing is recorded twice.
 */
export function TableAllergies({
  table,
  choices,
  csrf,
  locked,
  onSaved,
}: {
  readonly table: StaffDiningTable;
  readonly choices: readonly StaffTableAllergenChoice[];
  readonly csrf: string;
  readonly locked: boolean;
  readonly onSaved: (codes: readonly string[]) => void;
}) {
  const session = table.currentDiningSessionReference;
  const saved = table.tableAllergies ?? [];
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(saved));
  const [state, setState] = useState<"Idle" | "Saving" | "Failed" | "NotOpen">("Idle");
  const operation = useRef<{ key: string; reference: string } | null>(null);
  if (session === null || choices.length === 0) return null;
  const changed = picked.size !== saved.length || saved.some((code) => !picked.has(code));
  const named = (codes: Iterable<string>) =>
    [...codes]
      .map((code) => choices.find((choice) => choice.code === code))
      .filter((choice): choice is StaffTableAllergenChoice => choice !== undefined)
      .map(tableAllergenText)
      .join(listSeparator());
  const save = async () => {
    const codes = choices.map((c) => c.code).filter((code) => picked.has(code));
    const key = session + ":" + codes.join(",");
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setState("Saving");
    try {
      const result = await createDiningSessionClient().setTableAllergies(
        csrf,
        operation.current.reference,
        session,
        codes,
      );
      operation.current = null;
      if (result.status === "TableNotOpen") {
        setState("NotOpen");
        return;
      }
      setState("Idle");
      onSaved(result.allergenCodes);
    } catch {
      setState("Failed");
    }
  };
  return (
    <section
      className="table-allergies"
      aria-labelledby={`table-allergies-${table.tableReference}`}
    >
      <h3 id={`table-allergies-${table.tableReference}`}>{t("Allergies at this table")}</h3>
      <p className="table-allergies__hint">
        {t("Ticks only: ask the guest, and never write their name or health details.")}
      </p>
      <div className="table-allergies__choices" role="group">
        {choices.map((choice) => (
          <label key={choice.code} className="table-allergies__choice">
            <input
              type="checkbox"
              checked={picked.has(choice.code)}
              disabled={locked || state === "Saving"}
              onChange={(event) => {
                const next = new Set(picked);
                if (event.currentTarget.checked) next.add(choice.code);
                else next.delete(choice.code);
                setPicked(next);
                if (state !== "Saving") setState("Idle");
              }}
            />
            <span>{tableAllergenText(choice)}</span>
          </label>
        ))}
      </div>
      <p className="table-allergies__now" role="status">
        {saved.length === 0
          ? t("No allergies marked for this table.")
          : t("Kitchen tickets for this table will show: {list}.", { list: named(saved) })}
      </p>
      {state === "Failed" ? (
        <p className="table-allergies__problem" role="alert">
          {t("Allergies couldn't be saved. Try again.")}
        </p>
      ) : state === "NotOpen" ? (
        <p className="table-allergies__problem" role="alert">
          {t("This table is no longer open.")}
        </p>
      ) : null}
      <button
        type="button"
        className="table-panel__text-step"
        disabled={locked || state === "Saving" || (!changed && state !== "Failed")}
        onClick={() => void save()}
      >
        {state === "Saving" ? t("Saving…") : t("Save allergies")}
      </button>
    </section>
  );
}
