import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { MenuPageError, type MenuClient } from "./store-menu-pages.js";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner 2026-10-28 decision 2, coordinator 2026-10-29): the
 * owner marks a dish the kitchen does not prepare (a bottled drink, the per-head tea). It never
 * reaches the kitchen board, counts as served once ordered and never holds up checkout. Saved on
 * its own (the Kitchen's record), against the mark the owner saw; rounds already sent keep what
 * the kitchen decided for them. A dish not saved yet is marked after its first save.
 */
export function DishKitchenMark({
  productReference,
  client,
}: {
  readonly productReference: string | null;
  readonly client: MenuClient;
}) {
  const [mark, setMark] = useState<{ notPrepared: boolean; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const call = client.kitchenNotPrepared;
  useEffect(() => {
    if (productReference === null || call === undefined) return;
    let active = true;
    void call({ action: "Read", productReferences: [productReference] })
      .then((value) => {
        if (!active) return;
        const found = (value as { products?: unknown } | null)?.products;
        const entry = Array.isArray(found)
          ? (found as Record<string, unknown>[]).find(
              (item) => item.productReference === productReference,
            )
          : undefined;
        if (
          entry === undefined ||
          typeof entry.notPrepared !== "boolean" ||
          !Number.isSafeInteger(entry.version)
        )
          throw new Error("unreadable");
        setMark({ notPrepared: entry.notPrepared, version: entry.version as number });
      })
      .catch(() => {
        if (active) setProblem(t("Whether the kitchen prepares this dish could not be read."));
      });
    return () => {
      active = false;
    };
  }, [call, productReference, reload]);
  if (call === undefined) return null;
  const change = async (notPrepared: boolean) => {
    if (productReference === null || mark === null || busy) return;
    const key = `${mark.version}:${notPrepared}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const value = (await call({
        action: "Change",
        productReference,
        operationReference: operation.current.reference,
        expectedVersion: mark.version,
        notPrepared,
      })) as { products?: Record<string, unknown>[] };
      const entry = value.products?.[0];
      operation.current = null;
      if (entry && typeof entry.notPrepared === "boolean" && Number.isSafeInteger(entry.version))
        setMark({ notPrepared: entry.notPrepared, version: entry.version as number });
      else setReload((current) => current + 1);
    } catch (error) {
      operation.current = null;
      setProblem(
        error instanceof MenuPageError && error.code === "PermissionDenied"
          ? t("Your access doesn't allow this. Ask a manager.")
          : t("This wasn't saved. It has been read again: check it and try again."),
      );
      setReload((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="dish-editor__kitchen">
      <legend>{t("Kitchen")}</legend>
      {productReference === null ? (
        <p className="dish-editor__note">
          {t("After the dish is saved you can mark it as not prepared by the kitchen.")}
        </p>
      ) : (
        <label className="dish-editor__confirm">
          <input
            type="checkbox"
            checked={mark?.notPrepared ?? false}
            disabled={mark === null || busy}
            onChange={(event) => void change(event.target.checked)}
          />
          <span>
            <strong>{t("Not prepared by the kitchen")}</strong>{" "}
            <span className="dish-editor__note">
              {t(
                "This dish does not appear on the kitchen board; it counts as served once ordered and never holds up checkout. For example bottled drinks or the tea charge.",
              )}
            </span>
          </span>
        </label>
      )}
      {productReference === null ? null : (
        <DishKitchenSection productReference={productReference} client={client} />
      )}
      {problem ? <p role="alert">{problem}</p> : null}
    </fieldset>
  );
}

interface SectionState {
  readonly sections: readonly { readonly sectionReference: string; readonly name: string }[];
  readonly sectionReference: string | null;
  readonly version: number;
}
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function parseSectionState(value: unknown, productReference: string): SectionState {
  const raw = value as Record<string, unknown> | null;
  const sections = Array.isArray(raw?.sections) ? (raw.sections as Record<string, unknown>[]) : [];
  const products = Array.isArray(raw?.products) ? (raw.products as Record<string, unknown>[]) : [];
  const entry = products.find((item) => item.productReference === productReference);
  if (
    entry === undefined ||
    !Number.isSafeInteger(entry.version) ||
    (entry.sectionReference !== null &&
      (typeof entry.sectionReference !== "string" || !reference.test(entry.sectionReference))) ||
    sections.some(
      (s) =>
        typeof s.sectionReference !== "string" ||
        !reference.test(s.sectionReference) ||
        typeof s.name !== "string",
    )
  )
    throw new Error("unreadable");
  return {
    sections: sections.map((s) => ({
      sectionReference: s.sectionReference as string,
      name: s.name as string,
    })),
    sectionReference: entry.sectionReference as string | null,
    version: entry.version as number,
  };
}

/**
 * WP-2423 item 8 ⑧ (Owner decision 5): the kitchen section (档口) that makes this dish, so one
 * kitchen screen can show one section. The Store's sections are named on Store features. Saved on
 * its own (the Kitchen's record), against the section the owner saw.
 */
function DishKitchenSection({
  productReference,
  client,
}: {
  readonly productReference: string;
  readonly client: MenuClient;
}) {
  const [state, setState] = useState<SectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const call = client.kitchenSections;
  useEffect(() => {
    if (call === undefined) return;
    let active = true;
    void call({ action: "Read", productReferences: [productReference] })
      .then((value) => {
        if (active) setState(parseSectionState(value, productReference));
      })
      .catch(() => {
        if (active) setProblem(t("The dish's kitchen section could not be read."));
      });
    return () => {
      active = false;
    };
  }, [call, productReference, reload]);
  if (call === undefined) return null;
  const change = async (sectionReference: string | null) => {
    if (state === null || busy) return;
    const key = `${state.version}:${sectionReference ?? "none"}`;
    if (operation.current?.key !== key)
      operation.current = { key, reference: newOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      setState(
        parseSectionState(
          await call({
            action: "ChangeDish",
            productReference,
            operationReference: operation.current.reference,
            expectedVersion: state.version,
            sectionReference,
          }),
          productReference,
        ),
      );
      operation.current = null;
    } catch (error) {
      operation.current = null;
      setProblem(
        error instanceof MenuPageError && error.code === "PermissionDenied"
          ? t("Your access doesn't allow this. Ask a manager.")
          : t("This wasn't saved. It has been read again: check it and try again."),
      );
      setReload((current) => current + 1);
    } finally {
      setBusy(false);
    }
  };
  if (state !== null && state.sections.length === 0)
    return (
      <p className="dish-editor__note">
        {t(
          "No kitchen sections yet. Name them on Store features to show one section per kitchen screen.",
        )}
      </p>
    );
  return (
    <label className="dish-editor__field">
      <span>{t("Kitchen section")}</span>
      <select
        value={state?.sectionReference ?? ""}
        disabled={state === null || busy}
        onChange={(event) =>
          void change(event.currentTarget.value === "" ? null : event.currentTarget.value)
        }
      >
        <option value="">{t("No section")}</option>
        {(state?.sections ?? []).map((section) => (
          <option key={section.sectionReference} value={section.sectionReference}>
            {section.name}
          </option>
        ))}
      </select>
      {problem ? <span role="alert">{problem}</span> : null}
    </label>
  );
}
