import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";

export interface KitchenSectionsView {
  readonly version: number;
  readonly sections: readonly { readonly sectionReference: string; readonly name: string }[];
}
export class KitchenSectionsClientError extends Error {
  constructor(readonly code: "Denied" | "Changed" | "Unavailable") {
    super("kitchen sections " + code);
    this.name = "KitchenSectionsClientError";
  }
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export function parseKitchenSections(value: unknown): KitchenSectionsView {
  const raw = value as Record<string, unknown> | null;
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 0 ||
    !Array.isArray(raw.sections)
  )
    throw new KitchenSectionsClientError("Unavailable");
  return {
    version: Number(raw.version),
    sections: (raw.sections as Record<string, unknown>[]).map((section) => {
      if (
        typeof section.sectionReference !== "string" ||
        !reference.test(section.sectionReference) ||
        typeof section.name !== "string"
      )
        throw new KitchenSectionsClientError("Unavailable");
      return { sectionReference: section.sectionReference, name: section.name };
    }),
  };
}
export interface KitchenSectionsClient {
  read(): Promise<KitchenSectionsView>;
  change(command: {
    readonly operationReference: string;
    readonly expectedVersion: number;
    readonly sections: KitchenSectionsView["sections"];
  }): Promise<KitchenSectionsView>;
}
export function createKitchenSectionsClient(
  csrf: string,
  fetcher: typeof fetch = fetch,
): KitchenSectionsClient {
  const send = async (body: unknown) => {
    let response: Response;
    try {
      response = await fetcher("/merchant/commerce/kitchen-sections/command", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new KitchenSectionsClientError("Unavailable");
    }
    if (response.status === 401 || response.status === 403)
      throw new KitchenSectionsClientError("Denied");
    if (response.status === 409) throw new KitchenSectionsClientError("Changed");
    if (!response.ok) throw new KitchenSectionsClientError("Unavailable");
    return parseKitchenSections(await response.json().catch(() => null));
  };
  return Object.freeze({
    read: () => send({ action: "Read", productReferences: [] }),
    change: (command: Parameters<KitchenSectionsClient["change"]>[0]) =>
      send({ action: "ChangeSections", ...command }),
  });
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): the Store's kitchen sections (档口),
 * named by the owner. Each dish is given one on its menu editor, and one kitchen screen shows all
 * sections or just one (chosen on that screen). Renaming keeps a section's dishes; removing one
 * leaves its dishes with no section. Saved together, against the list the owner saw.
 */
export function StoreKitchenSections({
  csrf,
  locked,
  client: provided,
}: {
  readonly csrf: string;
  readonly locked: boolean;
  readonly client?: KitchenSectionsClient;
}) {
  const [client] = useState(() => provided ?? createKitchenSectionsClient(csrf));
  const [saved, setSaved] = useState<KitchenSectionsView | null>(null);
  const [draft, setDraft] = useState<KitchenSectionsView["sections"]>([]);
  const [added, setAdded] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    client
      .read()
      .then((view) => {
        if (!active) return;
        setSaved(view);
        setDraft(view.sections);
      })
      .catch(() => {
        if (active)
          setMessage({ tone: "alert", text: t("The kitchen sections could not be read.") });
      });
    return () => {
      active = false;
    };
  }, [client, reload]);
  const names = draft.map((section) => section.name.trim());
  const invalid =
    names.some((name) => name.length === 0 || name.length > 24) ||
    new Set(names).size !== names.length;
  const changed = saved !== null && JSON.stringify(saved.sections) !== JSON.stringify(draft);
  const save = async () => {
    if (saved === null || busy || locked || invalid || !changed) return;
    const sections = draft.map((section) => ({ ...section, name: section.name.trim() }));
    const key = `${saved.version}:${JSON.stringify(sections)}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setMessage(null);
    try {
      const view = await client.change({
        operationReference: operation.current.reference,
        expectedVersion: saved.version,
        sections,
      });
      operation.current = null;
      setSaved(view);
      setDraft(view.sections);
      setMessage({ tone: "status", text: t("Saved. Give each dish its section on the menu.") });
    } catch (error) {
      operation.current = null;
      const code = error instanceof KitchenSectionsClientError ? error.code : "Unavailable";
      setMessage({
        tone: "alert",
        text:
          code === "Changed"
            ? t("Someone else changed the sections. They are read again: check and save again.")
            : code === "Denied"
              ? t("Your access doesn't allow this. Ask a manager.")
              : t("This wasn't saved. Check the connection and try again."),
      });
      if (code === "Changed") setReload((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="store-features__modules" disabled={busy || locked || saved === null}>
      <legend>{t("Kitchen sections")}</legend>
      <p className="store-features__detail">
        {t(
          "Name the sections of your kitchen (for example wok, steamer, roast). Give each dish its section on the menu; a kitchen screen can then show one section, and says how many orders wait in the others.",
        )}
      </p>
      <ul className="store-kitchen-sections">
        {draft.map((section, index) => (
          <li key={section.sectionReference}>
            <input
              aria-label={t("Section {number} name", { number: String(index + 1) })}
              value={section.name}
              maxLength={24}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setDraft((current) =>
                  current.map((entry) =>
                    entry.sectionReference === section.sectionReference
                      ? { ...entry, name }
                      : entry,
                  ),
                );
              }}
            />
            <button
              type="button"
              onClick={() =>
                setDraft((current) =>
                  current.filter((entry) => entry.sectionReference !== section.sectionReference),
                )
              }
            >
              {t("Remove {section}", { section: section.name || t("this section") })}
            </button>
          </li>
        ))}
      </ul>
      {draft.length < 12 ? (
        <div className="store-kitchen-sections__add">
          <input
            aria-label={t("New section name")}
            value={added}
            maxLength={24}
            onChange={(event) => setAdded(event.currentTarget.value)}
          />
          <button
            type="button"
            disabled={added.trim() === "" || names.includes(added.trim())}
            onClick={() => {
              setDraft((current) => [
                ...current,
                { sectionReference: newOperationReference(), name: added.trim() },
              ]);
              setAdded("");
            }}
          >
            {t("Add section")}
          </button>
        </div>
      ) : null}
      {invalid ? (
        <p role="alert">{t("Each section needs its own name of up to 24 characters.")}</p>
      ) : null}
      <div className="store-features__actions">
        <button
          type="button"
          className="store-features__save"
          disabled={busy || locked || invalid || !changed}
          onClick={() => void save()}
        >
          {t("Save sections")}
        </button>
      </div>
      {message ? <p role={message.tone}>{message.text}</p> : null}
    </fieldset>
  );
}
