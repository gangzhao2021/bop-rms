import { ProductCategoryPicker, type InitialCategoryProposal } from "./ProductCategoryPicker.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createCompleteProductDraftEditor,
  CompleteDraftEditorError,
  type CompleteProductDraftEditor,
} from "./product-complete-draft-editor.js";
import { Link } from "react-router";
import { createProductAuthoringRecovery } from "./product-authoring-recovery.js";
import {
  ProductAuthoringRecoveryError,
  type ProductAuthoringResolutionView,
} from "./product-authoring-recovery-client.js";
import { createProductEditorClient, type ProductEditorView } from "./product-editor-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { ProductRecordedConfigurationFields } from "./ProductRecordedConfigurationFields.js";
import type { ProductVersion } from "./catalog-product-command-values.js";
import { ProductOptionPickerError } from "./product-option-picker-client.js";
import {
  ProductOptionBindings,
  productOptionPickerSaveErrorCode,
  productOptionBindingRawInputsValid,
  type ProductOptionBindingRawInputs,
} from "./ProductOptionBindings.js";
import { ProductSellingUnits } from "./ProductSellingUnits.js";
import {
  ProductNewSkus,
  newSkuRowsValid,
  selectedSellingUnitsChanged,
  type ProductNewSkuRow,
} from "./ProductNewSkus.js";
import {
  createProductSellingUnitsClient,
  ProductSellingUnitsError,
  type ProductSellingUnitsView,
} from "./product-selling-units-client.js";
import { createProductAuthoringRecoveryClient } from "./product-authoring-recovery-client.js";
type View = ReturnType<CompleteProductDraftEditor["view"]>;
const descriptions = [
  "localizedShortDescriptions",
  "localizedDescriptions",
  "preparationNotes",
] as const;
const titles = {
  localizedShortDescriptions: "Short description",
  localizedDescriptions: "Description",
  preparationNotes: "Preparation notes",
};
export function ProductCompleteDraftForm({
  entry,
  productReference,
  storeReference,
  csrf,
  blocked = false,
  onBlockedChange,
  onConfirmed,
}: {
  readonly entry: ProductEditorView | null;
  readonly productReference: string;
  readonly storeReference: string;
  readonly csrf: string;
  readonly blocked?: boolean;
  readonly onBlockedChange?: (blocked: boolean) => void;
  readonly onConfirmed?: (revision: number) => void;
}) {
  const editor = useRef<CompleteProductDraftEditor | null>(null),
    pending = useRef<AbortController | null>(null),
    active = useRef(true),
    original = useRef<ProductVersion | null>(null);
  const [recovery] = useState(() =>
    createProductAuthoringRecovery({
      action: "ReplaceDraft",
      productReference,
      currentContext: () => (active.current ? 0 : 1),
    }),
  );
  const recoveryScope = useRef<{ brandReference: string; storeReference: string } | null>(null);
  const [recoveryView, setRecoveryView] = useState(() => recovery.view()),
    [resolved, setResolved] = useState<ProductAuthoringResolutionView | null>(null);
  const [view, setView] = useState<View | null>(null),
    [candidate, setCandidate] = useState<ProductVersion | null>(null),
    [dirty, setDirty] = useState(false),
    [integerInputs, setIntegerInputs] = useState<Record<string, { text: string; valid: boolean }>>(
      {},
    ),
    [busy, setBusy] = useState(false),
    [requiresRefresh, setRequiresRefresh] = useState(false),
    [error, setError] = useState<string | null>(null),
    [offline, setOffline] = useState(!navigator.onLine),
    [background, setBackground] = useState(document.visibilityState === "hidden");
  const [brandReference, setBrandReference] = useState<string | null>(null);
  const [units, setUnits] = useState<ProductSellingUnitsView | null>(null),
    [unitError, setUnitError] = useState<string | null>(null),
    [unitPending, setUnitPending] = useState(true),
    [newSkus, setNewSkus] = useState<readonly ProductNewSkuRow[]>([]);
  const [categoryProposal, setCategoryProposal] = useState<InitialCategoryProposal | undefined>();
  const [bindingRawInputs, setBindingRawInputs] = useState<ProductOptionBindingRawInputs>({});
  const bindingRawInput = useCallback<
    NonNullable<Parameters<typeof ProductOptionBindings>[0]["onRawInputsChange"]>
  >((next) => {
    setBindingRawInputs(next);
    setDirty(true);
  }, []);
  const [categoryReady, setCategoryReady] = useState(true);
  const [bindingPending, setBindingPending] = useState(true);
  const bindingPrepare = useRef<((signal: AbortSignal) => Promise<void>) | null>(null);
  const registerBindingPrepare = useCallback((prepare: (signal: AbortSignal) => Promise<void>) => {
    bindingPrepare.current = prepare;
  }, []);
  const unitInspectionActive = Boolean(brandReference && candidate);
  useEffect(() => {
    onBlockedChange?.(
      busy ||
        dirty ||
        (unitInspectionActive && (unitPending || bindingPending)) ||
        Boolean(view?.pendingSave) ||
        !recoveryView.checked ||
        recoveryView.pending,
    );
  }, [
    busy,
    dirty,
    unitPending,
    unitInspectionActive,
    bindingPending,
    view?.pendingSave,
    recoveryView.checked,
    recoveryView.pending,
    onBlockedChange,
  ]);
  useEffect(() => () => onBlockedChange?.(false), [onBlockedChange]);
  const configurationValid =
    !Object.values(integerInputs).some((input) => !input.valid) &&
    productOptionBindingRawInputsValid(bindingRawInputs);
  const integerInput = useCallback((key: string, text: string, valid: boolean) => {
    setIntegerInputs((old) => ({ ...old, [key]: { text, valid } }));
    setDirty(true);
  }, []);
  const summary = useRef<HTMLParagraphElement>(null),
    focusSummary = useRef(false);
  useEffect(() => {
    active.current = true;
    const network = () => {
      setOffline(!navigator.onLine);
      if (!navigator.onLine) {
        setRequiresRefresh(true);
        pending.current?.abort();
      }
    };
    const visibility = () => {
      setBackground(document.visibilityState === "hidden");
      if (document.visibilityState === "hidden") {
        setRequiresRefresh(true);
        pending.current?.abort();
      }
    };
    window.addEventListener("offline", network);
    window.addEventListener("online", network);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active.current = false;
      pending.current?.abort();
      window.removeEventListener("offline", network);
      window.removeEventListener("online", network);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (!view?.validUntil) return;
    const timer = setTimeout(
      () => {
        if (active.current && editor.current) setView(editor.current.view());
      },
      Math.max(0, Date.parse(view.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view?.validUntil]);
  useEffect(() => {
    if (focusSummary.current && !busy) {
      focusSummary.current = false;
      summary.current?.focus();
    }
  }, [busy, view]);
  useEffect(() => {
    if (!dirty && !view?.pendingSave && !recoveryView.pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, view?.pendingSave, recoveryView.pending]);
  async function inspectRecovery() {
    if (
      pending.current ||
      !active.current ||
      !navigator.onLine ||
      document.visibilityState === "hidden"
    )
      return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError(null);
    try {
      const gate = await createStoreCapabilityClient().load(
        { scope: { storeReference }, capabilityKey: "catalog.cat_product_edit", csrf },
        request.signal,
      );
      const scope = { brandReference: gate.brandReference, storeReference };
      await recovery.inspect(scope, csrf, request.signal);
      if (active.current) {
        recoveryScope.current = scope;
        setBrandReference(scope.brandReference);
      }
    } catch (value) {
      if (active.current)
        setError(
          value instanceof ProductAuthoringRecoveryError ||
            value instanceof StoreCapabilityClientError
            ? value.code
            : "Unavailable",
        );
    } finally {
      if (pending.current === request) pending.current = null;
      if (active.current) {
        setRecoveryView(recovery.view());
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (entry && !recovery.view().checked) void inspectRecovery();
  }, [entry]);
  async function run(action: "Open" | "Refresh" | "Discard" | "Save" | "Retry" | "Resolve") {
    const readOnly = action === "Open" || action === "Refresh";
    if (
      busy ||
      pending.current ||
      (!readOnly &&
        unitPending &&
        (unitInspectionActive || action === "Save" || action === "Retry")) ||
      (bindingPending && action === "Save") ||
      offline ||
      background ||
      (blocked && !readOnly && action !== "Resolve") ||
      (readOnly && (view?.pendingSave || recoveryView.pending || !recoveryView.checked))
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    focusSummary.current = true;
    try {
      if (action === "Resolve") {
        if (!recoveryScope.current) throw new ProductAuthoringRecoveryError("Unavailable");
        const result = await recovery.resolve(recoveryScope.current, csrf, controller.signal);
        if (!active.current) return;
        setResolved(result);
        // End the old mounted intent after a native terminal outcome. Reopen
        // from a current source; never reuse its pre-write root as live state.
        editor.current = null;
        original.current = null;
        setView(null);
        setCandidate(null);
        setDirty(false);
        setRequiresRefresh(true);
        setIntegerInputs({});
        setBindingRawInputs({});
        setCategoryProposal(undefined);
        setCategoryReady(true);
        if (result.outcome === "Committed" && result.aggregateVersion !== null)
          onConfirmed?.(result.aggregateVersion);
        return;
      }
      if ((!recovery.view().checked || recovery.view().pending) && action !== "Retry")
        throw new ProductAuthoringRecoveryError("PendingOriginal");
      if (!editor.current) {
        if (!entry || entry.draft.editorContent === undefined)
          throw new CompleteDraftEditorError("Unavailable");
        const freshEntry = () => {
          const at = Date.now();
          if (at < Date.parse(entry.observedAt) || at >= Date.parse(entry.validUntil))
            throw new CompleteDraftEditorError("Stale");
        };
        freshEntry();
        const gate = await createStoreCapabilityClient().load(
          { scope: { storeReference }, capabilityKey: "catalog.cat_product_edit", csrf },
          controller.signal,
        );
        if (!active.current || controller.signal.aborted) return;
        freshEntry();
        const selected = {
          brandReference: gate.brandReference,
          storeReference,
          productReference,
        };
        setBrandReference(gate.brandReference);
        recoveryScope.current = { brandReference: gate.brandReference, storeReference };
        // Current owning Store capability resolves Brand independently of existing SKUs.
        editor.current = createCompleteProductDraftEditor({
          request: {
            ...selected,
            expectedAggregateVersion: entry.revision,
          },
          currentScope: () => selected,
          currentContext: () => (active.current ? 0 : 1),
          now: Date.now,
          reads: createProductEditorClient(),
          capabilities: createStoreCapabilityClient(),
          commands: recovery.commands,
        });
      }
      const current = editor.current;
      if (action === "Save") {
        if (
          !candidate ||
          !dirty ||
          !configurationValid ||
          !categoryReady ||
          !newSkuRowsValid(newSkus, units, candidate.defaultLocale, candidate)
        )
          throw new CompleteDraftEditorError("Invalid");
        if (!bindingPrepare.current) throw new CompleteDraftEditorError("Unavailable");
        await bindingPrepare.current(controller.signal);
        if (!active.current || controller.signal.aborted) return;
        let submitted = candidate;
        if (newSkus.length) {
          if (!brandReference || !units) throw new CompleteDraftEditorError("Unavailable");
          const read = await createProductSellingUnitsClient().inspect(
            "ReplaceDraft",
            { brandReference, storeReference },
            csrf,
            controller.signal,
          );
          if (!active.current || controller.signal.aborted) return;
          setUnits(read);
          if (selectedSellingUnitsChanged(newSkus, units, read)) {
            setNewSkus((old) => old.map((row) => ({ ...row, unit: "" })));
            setUnitError(
              "A selected unit definition changed. Refresh the Draft, review its current meaning and precision, and select it again.",
            );
            throw new CompleteDraftEditorError("Conflict");
          }
          setUnitError(null);
          const actual = await createProductAuthoringRecoveryClient().context(
            "ReplaceDraft",
            { brandReference, storeReference },
            csrf,
            controller.signal,
          );
          if (!active.current || controller.signal.aborted) return;
          submitted = {
            ...candidate,
            skus: [
              ...candidate.skus,
              ...newSkus.map((row) => {
                const combo = candidate.editorContent?.variantDimensions.length
                  ? candidate.editorContent.variantCombinations[Number(row.combination)]
                  : null;
                if (
                  candidate.editorContent?.variantDimensions.length &&
                  (!combo || combo.disposition !== "NotGenerated" || combo.skuReference !== null)
                )
                  throw new CompleteDraftEditorError("Conflict");
                return {
                  skuReference: row.reference,
                  productReference,
                  brandReference,
                  skuCode: row.code,
                  lifecycle: "Draft" as const,
                  localizedNames: { [candidate.defaultLocale]: row.name },
                  variantSelections: combo ? combo.selections : [],
                  unitOfSale: row.unit,
                  unitQuantity: row.quantity,
                  createdAt: actual.observedAt,
                  createdByActorReference: actual.actorReference,
                };
              }),
            ],
            ...(candidate.editorContent === undefined
              ? {}
              : {
                  editorContent: {
                    ...candidate.editorContent,
                    variantCombinations: candidate.editorContent.variantCombinations.map(
                      (combo, index) => {
                        const row = newSkus.find((row) => row.combination === String(index));
                        return row
                          ? { ...combo, disposition: "Valid" as const, skuReference: row.reference }
                          : combo;
                      },
                    ),
                  },
                }),
          };
        }
        current.edit(submitted, categoryProposal?.source);
        const receipt = await current.save(serviceOperationReference(), csrf, controller.signal);
        onConfirmed?.(receipt.aggregateVersion);
        original.current = null;
        setRequiresRefresh(false);
        setCandidate(null);
        setCategoryProposal(undefined);
        setCategoryReady(true);
        setIntegerInputs({});
        setBindingRawInputs({});
        setDirty(false);
        setNewSkus([]);
      } else if (action === "Retry") {
        const receipt = await current.retry(csrf, controller.signal);
        onConfirmed?.(receipt.aggregateVersion);
        original.current = null;
        setRequiresRefresh(false);
        setCandidate(null);
        setCategoryProposal(undefined);
        setCategoryReady(true);
        setIntegerInputs({});
        setBindingRawInputs({});
        setDirty(false);
        setNewSkus([]);
      } else {
        if (action === "Discard") await current.discardAndReload(csrf, controller.signal);
        else await current.refresh(csrf, controller.signal);
        const next = current.view().draft;
        if (!next) throw new CompleteDraftEditorError("Unavailable");
        if (
          action !== "Discard" &&
          dirty &&
          original.current &&
          JSON.stringify(original.current) !== JSON.stringify(next)
        )
          throw new CompleteDraftEditorError("Conflict");
        original.current = next;
        setRequiresRefresh(false);
        if (action === "Discard" || !dirty) {
          if (action === "Discard") setNewSkus([]);
          if (!unitInspectionActive) {
            setUnitPending(true);
            setBindingPending(true);
          }
          setCandidate(next);
          setCategoryProposal(undefined);
          setCategoryReady(true);
          setIntegerInputs({});
          setBindingRawInputs({});
          setDirty(false);
        }
      }
    } catch (value) {
      if (active.current && value instanceof ProductSellingUnitsError) {
        setUnitError(
          `Selling unit verification failed: ${value.code}. Refresh current units before another Draft save.`,
        );
        setError(value.code === "Disabled" ? "FeatureDisabled" : value.code);
      } else if (active.current)
        setError(
          value instanceof ProductOptionPickerError
            ? productOptionPickerSaveErrorCode(value)
            : value instanceof CompleteDraftEditorError ||
                value instanceof StoreCapabilityClientError ||
                value instanceof ProductAuthoringRecoveryError
              ? value.code
              : "Unavailable",
        );
    } finally {
      if (active.current) {
        if (editor.current) setView(editor.current.view());
        setRecoveryView(recovery.view());
        setBusy(false);
      }
      if (pending.current === controller) pending.current = null;
    }
  }
  const current =
    view?.draft &&
    !view.pendingSave &&
    recoveryView.checked &&
    !recoveryView.pending &&
    !offline &&
    !background &&
    !requiresRefresh &&
    error !== "Conflict"
      ? candidate
      : null;
  const editNames = (
    key: "localizedNames" | (typeof descriptions)[number],
    locale: string,
    value: string,
  ) => {
    if (!candidate?.editorContent) return;
    if (key === "localizedNames")
      setCandidate({
        ...candidate,
        localizedNames: { ...candidate.localizedNames, [locale]: value },
      });
    else {
      const texts = Object.fromEntries(
        Object.entries({ ...candidate.editorContent[key], [locale]: value }).filter(
          ([, text]) => text !== "",
        ),
      );
      setCandidate({ ...candidate, editorContent: { ...candidate.editorContent, [key]: texts } });
    }
    setDirty(true);
    setError(null);
  };
  const editAttribute = (index: number, value: string | boolean) => {
    if (!candidate?.editorContent) return;
    const attributeValues = candidate.editorContent.attributeValues.map((attribute, n) => {
      if (n !== index) return attribute;
      if (attribute.type === "Boolean" && typeof value === "boolean")
        return { ...attribute, value };
      if ((attribute.type === "Text" || attribute.type === "Decimal") && typeof value === "string")
        return { ...attribute, value };
      return attribute;
    });
    setCandidate({ ...candidate, editorContent: { ...candidate.editorContent, attributeValues } });
    setDirty(true);
    setError(null);
  };
  const editAlt = (index: number, locale: string, value: string) => {
    if (!candidate?.editorContent) return;
    const media = candidate.editorContent.media.map((item, n) =>
      n === index ? { ...item, altText: { ...item.altText, [locale]: value } } : item,
    );
    setCandidate({ ...candidate, editorContent: { ...candidate.editorContent, media } });
    setDirty(true);
    setError(null);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("Save");
  };
  return (
    <section className="product-complete-draft" aria-labelledby="complete-draft-heading">
      <h3 id="complete-draft-heading">Edit recorded Draft content</h3>
      <p>
        Update recorded content and current Categories while keeping other references and versions.
        Current server checks govern every save. Use Publication requests for validation, review and
        publication.
      </p>
      {!view ? (
        <button
          disabled={
            busy ||
            offline ||
            background ||
            recoveryView.pending ||
            !recoveryView.checked ||
            !entry?.draft.editorContent
          }
          onClick={() => void run("Open")}
        >
          Open Draft editor
        </button>
      ) : (
        <div className="product-content-actions">
          <button
            disabled={
              busy ||
              offline ||
              background ||
              view.pendingSave ||
              recoveryView.pending ||
              !recoveryView.checked
            }
            onClick={() => void run("Refresh")}
          >
            Refresh editable Draft
          </button>
          <button
            disabled={
              blocked ||
              busy ||
              offline ||
              background ||
              (unitInspectionActive && (unitPending || bindingPending)) ||
              view.pendingSave ||
              recoveryView.pending ||
              !recoveryView.checked
            }
            onClick={() => void run("Discard")}
          >
            Discard local edits and reload
          </button>
          {view.pendingSave && (
            <button
              disabled={blocked || busy || offline || background}
              onClick={() => void run("Retry")}
            >
              Retry original Draft save
            </button>
          )}
        </div>
      )}
      {!recoveryView.checked && (
        <button disabled={busy || offline || background} onClick={() => void inspectRecovery()}>
          Check original Draft request
        </button>
      )}
      {recoveryView.pending && (
        <button disabled={busy || offline || background} onClick={() => void run("Resolve")}>
          Resolve stored Draft save
        </button>
      )}
      {resolved && (
        <p role="status">
          {resolved.outcome === "Committed"
            ? "Original Draft save confirmed. Reopen the current Product before editing."
            : "The original Draft save was permanently ended without applying. Reopen the current Product to edit."}{" "}
          <Link to="/app/commerce/products">Return to Products</Link>
        </p>
      )}
      <p ref={summary} tabIndex={-1} role="status" className="product-draft-result">
        {busy
          ? "Checking current Draft access…"
          : view?.pendingSave
            ? "Save result is unknown. Retry the original request before editing or creating another save."
            : recoveryView.pending
              ? recoveryView.cleanupFailed
                ? "Original save confirmed. Resolve the retained storage marker before another edit or publication."
                : error
                  ? `Draft save not confirmed: ${error}. Resolve the stored original before editing or publishing.`
                  : "An original Draft request remains stored. Resolve it before another edit or publication. Only its operation identity is stored in this browser."
              : !recoveryView.checked
                ? "Check the original request storage before editing or publishing."
                : offline
                  ? "Draft editor offline. Reconnect and refresh before editing."
                  : background
                    ? "Draft editor paused. Return and refresh current access."
                    : requiresRefresh
                      ? "Refresh current Draft access before editing."
                      : error
                        ? error === "OptionSourceConflict"
                          ? "The selected Option publication changed. Your recorded binding is retained. Refresh its choices and explicitly choose a replacement before saving."
                          : `Draft save not confirmed: ${error}. Refresh or discard local edits to recover.`
                        : view?.status === "NeedsRefresh"
                          ? "Original save confirmed. Refresh to read the current Draft."
                          : view?.draft
                            ? dirty
                              ? "Local unsaved edits."
                              : "Current Draft loaded."
                            : view
                              ? "Editable Draft observation expired or unavailable. Refresh current access."
                              : "Open the current Draft to edit its recorded text."}
      </p>
      {brandReference && candidate && (
        <ProductSellingUnits
          action="ReplaceDraft"
          brandReference={brandReference}
          storeReference={storeReference}
          csrf={csrf}
          locale={candidate.defaultLocale}
          locked={
            blocked ||
            busy ||
            offline ||
            background ||
            !!recoveryView.pending ||
            !recoveryView.checked
          }
          onView={setUnits}
          onPending={setUnitPending}
        />
      )}
      {current?.editorContent && (
        <form
          onSubmit={submit}
          aria-label="Recorded Draft text form"
          className="product-complete-draft-fields"
        >
          <fieldset disabled={blocked || busy}>
            <legend>Product text</legend>
            {Object.entries(current.localizedNames).map(([locale, text]) => (
              <label key={locale}>
                Product name · {locale}
                <input
                  value={text}
                  maxLength={120}
                  required
                  aria-describedby="complete-draft-validation"
                  aria-invalid={error === "Invalid" || undefined}
                  onChange={(e) => editNames("localizedNames", locale, e.currentTarget.value)}
                />
              </label>
            ))}
            {descriptions.map((key) => (
              <div key={key}>
                {[
                  ...new Set([
                    current.defaultLocale,
                    ...Object.keys(current.editorContent?.[key] ?? {}),
                  ]),
                ].map((locale) => (
                  <label key={locale}>
                    {titles[key]} · {locale}
                    <textarea
                      value={current.editorContent?.[key][locale] ?? ""}
                      maxLength={
                        key === "localizedDescriptions"
                          ? 4096
                          : key === "preparationNotes"
                            ? 1000
                            : 240
                      }
                      aria-describedby="complete-draft-validation"
                      aria-invalid={error === "Invalid" || undefined}
                      onChange={(e) => editNames(key, locale, e.currentTarget.value)}
                    />
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <ProductCategoryPicker
            screenId="CAT-PRODUCT-EDIT"
            brandReference={brandReference}
            storeReference={storeReference}
            locale={current.defaultLocale}
            locked={blocked || busy}
            storedClassification={original.current?.categoryClassification}
            proposal={categoryProposal}
            onReadiness={setCategoryReady}
            onChange={(next) => {
              setCategoryProposal(next);
              setCandidate((latest) =>
                latest ? { ...latest, categoryClassification: next.classification } : latest,
              );
              setDirty(true);
              setError(null);
            }}
          />
          <fieldset disabled={blocked || busy}>
            <legend>Recorded attributes and Media text</legend>
            {current.editorContent.attributeValues.map((attribute, i) =>
              attribute.type === "Enum" ? (
                <p key={attribute.attributeReference}>
                  Attribute {i + 1}: existing Enum reference retained
                </p>
              ) : attribute.type === "Boolean" ? (
                <label key={attribute.attributeReference}>
                  <input
                    type="checkbox"
                    checked={attribute.value}
                    onChange={(e) => editAttribute(i, e.currentTarget.checked)}
                  />
                  Attribute {i + 1} · Boolean
                </label>
              ) : (
                <label key={attribute.attributeReference}>
                  Attribute {i + 1} · {attribute.type}
                  {attribute.type === "Decimal" && attribute.unitCode
                    ? ` · ${attribute.unitCode}`
                    : ""}
                  <input
                    value={attribute.value}
                    maxLength={attribute.type === "Text" ? 240 : 22}
                    inputMode={attribute.type === "Decimal" ? "decimal" : "text"}
                    aria-describedby="complete-draft-validation"
                    aria-invalid={error === "Invalid" || undefined}
                    onChange={(e) => editAttribute(i, e.currentTarget.value)}
                  />
                </label>
              ),
            )}
            {current.editorContent.media.map((media, i) => (
              <div key={media.mediaReference}>
                {[...new Set([current.defaultLocale, ...Object.keys(media.altText)])].map(
                  (locale) => (
                    <label key={locale}>
                      Media {i + 1} alt text · {locale}
                      <input
                        value={media.altText[locale] ?? ""}
                        maxLength={240}
                        aria-describedby="complete-draft-validation"
                        aria-invalid={error === "Invalid" || undefined}
                        onChange={(e) => editAlt(i, locale, e.currentTarget.value)}
                      />
                    </label>
                  ),
                )}
              </div>
            ))}
            <ProductRecordedConfigurationFields
              draft={current}
              showOptionBindings={false}
              integerInputs={integerInputs}
              onIntegerInput={integerInput}
              onChange={(next) => {
                setCandidate(next);
                setDirty(true);
                setError(null);
              }}
            />
            {brandReference && (
              <ProductOptionBindings
                draft={current}
                brandReference={brandReference}
                storeReference={storeReference}
                csrf={csrf}
                locked={blocked || busy || Boolean(view?.pendingSave) || recoveryView.pending}
                onBlockedChange={setBindingPending}
                registerBeforeSave={registerBindingPrepare}
                rawInputs={bindingRawInputs}
                onRawInputsChange={bindingRawInput}
                onChange={(next) => {
                  setCandidate(next);
                  setDirty(true);
                  setError(null);
                }}
              />
            )}
            <ProductNewSkus
              rows={newSkus}
              units={units}
              locale={current.defaultLocale}
              locked={blocked || busy || unitPending}
              draft={current}
              onChange={(rows) => {
                setNewSkus(rows);
                setDirty(true);
                setError(null);
              }}
            />
            {unitError && <p role="status">{unitError}</p>}
          </fieldset>
          <p id="complete-draft-validation">
            Plain text, decimal strings and whole-number selections only. Existing owning and
            foreign references are retained unless explicitly changed through current Category
            choices and actual Option binding selections. New Draft SKUs use registered units. Other
            reference selection, new Variant generation and publication controls remain unavailable.
          </p>
          <button
            type="submit"
            disabled={
              blocked ||
              busy ||
              unitPending ||
              bindingPending ||
              !dirty ||
              !configurationValid ||
              !categoryReady ||
              !newSkuRowsValid(newSkus, units, current.defaultLocale, current)
            }
          >
            Save recorded Draft
          </button>
        </form>
      )}
    </section>
  );
}
