import { t } from "./i18n/i18n.js";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { composingEnter } from "./form-enter.js";
import { newOperationReference } from "./operation-reference.js";
import { choiceRule } from "./store-option-set-page.js";
import type { TypedChoice } from "./dish-editor-source.js";
import { MenuPageError, type MenuClient, type NewChoiceGroupCommand } from "./store-menu-pages.js";
import { dollarsToMinor } from "./store-price-pages.js";

interface Row {
  readonly name: string;
  readonly nameZh: string;
  /** WP-2423 item 3 D: what it adds on this dish (dollars); nothing is stored until it is saved. */
  readonly extra?: string;
}
const maximumChoices = 20;
const emptyRow: Row = { name: "", nameZh: "", extra: "0.00" };

/**
 * WP-2423 item 3b: the limits an "any number" group may have. The server and the domain refuse the
 * same (at most 50 in total, 20 of one choice, and never more of one choice than the group allows).
 */
export function choiceGroupLimitsAllowed(most: number | null, perChoice: number): boolean {
  return (
    (most === null || (Number.isSafeInteger(most) && most >= 1 && most <= 50)) &&
    Number.isSafeInteger(perChoice) &&
    perChoice >= 1 &&
    perChoice <= 20 &&
    (most === null || perChoice <= most)
  );
}

/**
 * The command for a simple group: choose one (required or not) or any, up to a limit and up to a
 * number of each; the first one may be the default.
 */
export function newChoiceGroupCommand(input: {
  readonly operationReference: string;
  readonly name: string;
  readonly nameZh: string;
  readonly kind: "One" | "Any";
  readonly required: boolean;
  readonly firstIsDefault: boolean;
  readonly options: readonly Row[];
  /** "Any": the most in total (absent or null: no limit). */
  readonly most?: number | null;
  /** "Any": the most of one choice (absent: 1). */
  readonly perChoice?: number;
}): NewChoiceGroupCommand | null {
  const options = input.options
    .map((o) => ({ name: o.name.trim(), nameZh: o.nameZh.trim() }))
    .filter((o) => o.name !== "");
  if (input.name.trim() === "" || options.length === 0) return null;
  if (new Set(options.map((o) => o.name.toLowerCase())).size !== options.length) return null;
  const most = input.kind === "One" ? 1 : (input.most ?? null);
  const perChoice = input.kind === "One" ? 1 : (input.perChoice ?? 1);
  if (!choiceGroupLimitsAllowed(most, perChoice)) return null;
  return {
    action: "Create",
    operationReference: input.operationReference,
    name: input.name.trim(),
    nameZh: input.nameZh.trim(),
    kind: input.kind === "Any" && perChoice > 1 ? "Quantity" : input.kind,
    minimum: input.required ? 1 : 0,
    maximum: most,
    perOptionMaximum: perChoice,
    options: options.map((o, index) => ({
      optionReference: null,
      name: o.name,
      nameZh: o.nameZh,
      offered: true,
      defaultChoice: input.kind === "One" && input.firstIsDefault && index === 0,
    })),
  };
}

/**
 * WP-2423 item 8 ⑥ (v15 2026-10-28 finding g): a simple choice group made from the dish editor —
 * e.g. 辣度 (choose one: 微辣 by default, 中辣, 特辣, 不辣) or 加饭 (optional). It is saved directly,
 * as on the choice groups page; extra prices are set per dish and go live with "List it".
 */
export function NewChoiceGroupForm({
  client,
  onCreated,
  onClose,
}: {
  readonly client: MenuClient;
  /** The group made, and each choice as typed (in order) with its extra. */
  readonly onCreated: (optionSetReference: string | null, typed: readonly TypedChoice[]) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [nameZh, setNameZh] = useState("");
  const [kind, setKind] = useState<"One" | "Any">("One");
  const [required, setRequired] = useState(true);
  // "Up to [ ] in total" (empty: no limit) and, when guests may repeat a choice, "Up to [2] of each".
  const [limit, setLimit] = useState("");
  const [repeats, setRepeats] = useState(false);
  const [each, setEach] = useState("2");
  const [rows, setRows] = useState<readonly Row[]>([emptyRow, emptyRow]);
  // Enter in a choice goes to the next one, adding it at the end (never saves the dish around it).
  const list = useRef<HTMLOListElement>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  useEffect(() => {
    if (focusRow === null) return;
    list.current?.querySelectorAll<HTMLInputElement>("input[data-choice-name]")[focusRow]?.focus();
    setFocusRow(null);
  }, [focusRow, rows.length]);
  const nextRow = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== "Enter" || composingEnter(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const last = index === rows.length - 1;
    if (last && rows.length >= maximumChoices) return;
    if (last) setRows((current) => [...current, emptyRow]);
    setFocusRow(index + 1);
  };
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const most = kind === "One" || limit.trim() === "" ? null : Number(limit);
  const perChoice = kind === "Any" && repeats ? Number(each) : 1;
  const limitsAllowed = choiceGroupLimitsAllowed(most, perChoice);
  const create = async () => {
    if (client.createChoiceGroup === undefined || busy) return;
    if (!limitsAllowed) {
      setProblem(
        most !== null && perChoice > most
          ? t("The most of one choice can't be more than the group's limit.")
          : t("Use a limit from 1 to 50 in total, and from 1 to 20 of each."),
      );
      return;
    }
    const named = rows.filter((row) => row.name.trim() !== "");
    if (named.some((row) => dollarsToMinor(row.extra ?? "0.00") === null)) {
      setProblem(t("Enter each extra like 0.80, or 0.00 if it is included."));
      return;
    }
    const reference = operation ?? newOperationReference();
    const command = newChoiceGroupCommand({
      operationReference: reference,
      name,
      nameZh,
      kind,
      required: kind === "One" && required,
      firstIsDefault: kind === "One" && required,
      options: rows,
      most,
      perChoice,
    });
    if (command === null) {
      setProblem(t("Give the group a name and at least one choice, each with its own name."));
      return;
    }
    setBusy(true);
    setProblem(null);
    setOperation(reference);
    try {
      const result = (await client.createChoiceGroup(command)) as {
        optionSet?: { optionSetReference?: string };
      } | null;
      setOperation(null);
      onCreated(
        result?.optionSet?.optionSetReference ?? null,
        named.map((row) => ({ name: row.name, nameZh: row.nameZh, extra: row.extra ?? "0.00" })),
      );
    } catch (error) {
      if (!(error instanceof MenuPageError) || error.code !== "Offline") setOperation(null);
      setProblem(
        error instanceof MenuPageError && error.code === "PermissionDenied"
          ? t("You do not have permission to make choice groups.")
          : t("That didn't go through. Read the menu again and retry."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dish-editor__new-group" role="group" aria-label={t("New choice group")}>
      <div className="dish-editor__grid">
        <label className="dish-editor__field">
          <span>{t("Group name (English)")}</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="dish-editor__field">
          <span>{t("Group name (Chinese)")}</span>
          <input
            lang="zh-Hans"
            value={nameZh}
            maxLength={80}
            onChange={(e) => setNameZh(e.target.value)}
          />
        </label>
      </div>
      <fieldset>
        <legend>{t("Guests choose")}</legend>
        <label>
          <input type="radio" checked={kind === "One"} onChange={() => setKind("One")} />
          {t("One")}
        </label>
        <label>
          <input type="radio" checked={kind === "Any"} onChange={() => setKind("Any")} />
          {t("Any number, or none")}
        </label>
        {kind === "One" ? (
          <label>
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            {t("Required; the first choice is the default")}
          </label>
        ) : (
          <>
            <label className="dish-editor__field">
              <span>{t("Up to this many in total (empty for no limit)")}</span>
              <input
                type="number"
                min={1}
                max={50}
                inputMode="numeric"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={repeats}
                onChange={(e) => setRepeats(e.target.checked)}
              />
              {t("Guests can take more than one of the same choice")}
            </label>
            {repeats ? (
              <label className="dish-editor__field">
                <span>{t("Up to this many of each")}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  inputMode="numeric"
                  value={each}
                  onChange={(e) => setEach(e.target.value)}
                />
              </label>
            ) : null}
          </>
        )}
        {limitsAllowed ? (
          <p className="dish-editor__note">
            {t("Customers see: {value}", {
              value: choiceRule({
                kind: kind === "Any" && perChoice > 1 ? "Quantity" : kind,
                minimum: kind === "One" && required ? 1 : 0,
                maximum: kind === "One" ? 1 : most,
                perOptionMaximum: perChoice,
              }),
            })}
          </p>
        ) : (
          <p className="dish-editor__problem">
            {most !== null && perChoice > most
              ? t("The most of one choice can't be more than the group's limit.")
              : t("Use a limit from 1 to 50 in total, and from 1 to 20 of each.")}
          </p>
        )}
      </fieldset>
      <ol className="dish-editor__choices" ref={list}>
        {rows.map((row, index) => (
          <li key={index}>
            <label className="dish-editor__field">
              <span>{t("Choice {n} (English)", { n: index + 1 })}</span>
              <input
                data-choice-name
                value={row.name}
                maxLength={80}
                onKeyDown={(e) => nextRow(e, index)}
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)),
                  )
                }
              />
            </label>
            <label className="dish-editor__field">
              <span>{t("Choice {n} (Chinese)", { n: index + 1 })}</span>
              <input
                lang="zh-Hans"
                value={row.nameZh}
                maxLength={80}
                onKeyDown={(e) => nextRow(e, index)}
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, nameZh: e.target.value } : r)),
                  )
                }
              />
            </label>
            <label className="dish-editor__field">
              <span>{t("Choice {n} extra ($)", { n: index + 1 })}</span>
              <input
                inputMode="decimal"
                value={row.extra ?? "0.00"}
                onKeyDown={(e) => nextRow(e, index)}
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, extra: e.target.value } : r)),
                  )
                }
              />
            </label>
          </li>
        ))}
      </ol>
      <div className="dish-editor__actions">
        <button
          type="button"
          disabled={rows.length >= maximumChoices}
          onClick={() => setRows((current) => [...current, emptyRow])}
        >
          {t("Add a choice")}
        </button>
      </div>
      {problem ? (
        <p className="dish-editor__problem" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="dish-editor__actions">
        <button
          type="button"
          className="one-menu__primary"
          disabled={busy}
          onClick={() => void create()}
        >
          {busy ? t("Saving…") : t("Make the group")}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </div>
  );
}
