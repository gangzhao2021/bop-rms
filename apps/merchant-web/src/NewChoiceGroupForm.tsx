import { t } from "./i18n/i18n.js";
import { useState } from "react";
import { newOperationReference } from "./operation-reference.js";
import { MenuPageError, type MenuClient, type NewChoiceGroupCommand } from "./store-menu-pages.js";

interface Row {
  readonly name: string;
  readonly nameZh: string;
}

/** The command for a simple group: choose one (required or not) or any; the first one may be the default. */
export function newChoiceGroupCommand(input: {
  readonly operationReference: string;
  readonly name: string;
  readonly nameZh: string;
  readonly kind: "One" | "Any";
  readonly required: boolean;
  readonly firstIsDefault: boolean;
  readonly options: readonly Row[];
}): NewChoiceGroupCommand | null {
  const options = input.options
    .map((o) => ({ name: o.name.trim(), nameZh: o.nameZh.trim() }))
    .filter((o) => o.name !== "");
  if (input.name.trim() === "" || options.length === 0) return null;
  if (new Set(options.map((o) => o.name.toLowerCase())).size !== options.length) return null;
  return {
    action: "Create",
    operationReference: input.operationReference,
    name: input.name.trim(),
    nameZh: input.nameZh.trim(),
    kind: input.kind,
    minimum: input.required ? 1 : 0,
    maximum: input.kind === "One" ? 1 : null,
    perOptionMaximum: 1,
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
  readonly onCreated: (optionSetReference: string | null) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [nameZh, setNameZh] = useState("");
  const [kind, setKind] = useState<"One" | "Any">("One");
  const [required, setRequired] = useState(true);
  const [rows, setRows] = useState<readonly Row[]>([
    { name: "", nameZh: "" },
    { name: "", nameZh: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const create = async () => {
    if (client.createChoiceGroup === undefined || busy) return;
    const reference = operation ?? newOperationReference();
    const command = newChoiceGroupCommand({
      operationReference: reference,
      name,
      nameZh,
      kind,
      required: kind === "One" && required,
      firstIsDefault: kind === "One" && required,
      options: rows,
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
      onCreated(result?.optionSet?.optionSetReference ?? null);
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
        ) : null}
      </fieldset>
      <ol className="dish-editor__choices">
        {rows.map((row, index) => (
          <li key={index}>
            <label className="dish-editor__field">
              <span>{t("Choice {n} (English)", { n: index + 1 })}</span>
              <input
                value={row.name}
                maxLength={80}
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
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, nameZh: e.target.value } : r)),
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
          disabled={rows.length >= 20}
          onClick={() => setRows((current) => [...current, { name: "", nameZh: "" }])}
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
