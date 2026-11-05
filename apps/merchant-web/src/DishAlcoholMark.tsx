import { useEffect, useRef, useState } from "react";
import type { DishMarks } from "./dish-marks.js";
import { t } from "./i18n/i18n.js";
import { newOperationReference } from "./operation-reference.js";
import { MenuPageError, type MenuClient } from "./store-menu-pages.js";

/**
 * WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): the owner marks a dish that contains alcohol.
 * Saved on its own and applied at once, without listing the menu again. A marked dish is sold only
 * at tables, only while the Store's alcohol switch is on and within the hours. A new dish holds it
 * as a form value, set right after its first save.
 */
export function DishAlcoholMark({
  productReference,
  client,
  form,
  onForm,
  onUnfold,
}: {
  readonly productReference: string | null;
  readonly client: MenuClient;
  /** A new dish: the marks as form values. */
  readonly form: DishMarks;
  readonly onForm: (change: Partial<DishMarks>) => void;
  /** A form carried on from another dish: one line with Change, until it is pressed. */
  readonly onUnfold?: () => void;
}) {
  const [mark, setMark] = useState<{ containsAlcohol: boolean; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const call = client.productAlcohol;
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
          typeof entry.containsAlcohol !== "boolean" ||
          !Number.isSafeInteger(entry.version)
        )
          throw new Error("unreadable");
        setMark({ containsAlcohol: entry.containsAlcohol, version: entry.version as number });
      })
      .catch(() => {
        if (active) setProblem(t("Whether this dish contains alcohol could not be read."));
      });
    return () => {
      active = false;
    };
  }, [call, productReference, reload]);
  if (call === undefined) return null;
  const change = async (containsAlcohol: boolean) => {
    if (productReference === null || mark === null || busy) return;
    const key = `${mark.version}:${containsAlcohol}`;
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
        containsAlcohol,
      })) as { products?: Record<string, unknown>[] };
      const entry = value.products?.[0];
      operation.current = null;
      if (
        entry &&
        typeof entry.containsAlcohol === "boolean" &&
        Number.isSafeInteger(entry.version)
      )
        setMark({ containsAlcohol: entry.containsAlcohol, version: entry.version as number });
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
  if (onUnfold !== undefined)
    return (
      <p className="dish-editor__carried dish-editor__carried--mark">
        <span>
          <strong>{t("Alcohol")}</strong>:{" "}
          {form.containsAlcohol ? t("Contains alcohol") : t("No alcohol")}
        </span>{" "}
        <button type="button" aria-label={t("Change alcohol")} onClick={onUnfold}>
          {t("Change")}
        </button>
      </p>
    );
  return (
    <fieldset className="dish-editor__kitchen">
      <legend>{t("Alcohol")}</legend>
      <label className="dish-editor__confirm">
        <input
          type="checkbox"
          checked={
            productReference === null ? form.containsAlcohol : (mark?.containsAlcohol ?? false)
          }
          disabled={productReference !== null && (mark === null || busy)}
          onChange={(event) =>
            productReference === null
              ? onForm({ containsAlcohol: event.target.checked })
              : void change(event.target.checked)
          }
        />
        <span>
          <strong>{t("Contains alcohol")}</strong>{" "}
          <span className="dish-editor__note">
            {t(
              "Sold only at tables, from 9 am to 2 am, and only while Alcohol at tables is on in Store features. Guests see that they must be 19 or older, and staff see a reminder to check ID.",
            )}
          </span>
        </span>
      </label>
      {problem ? <p role="alert">{problem}</p> : null}
    </fieldset>
  );
}
