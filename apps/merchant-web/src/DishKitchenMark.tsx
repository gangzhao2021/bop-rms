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
      {problem ? <p role="alert">{problem}</p> : null}
    </fieldset>
  );
}
