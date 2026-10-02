import { ProductCategoryPicker, type InitialCategoryProposal } from "./ProductCategoryPicker.js";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createCompleteProductDraftEditor,
  CompleteDraftEditorError,
  type CompleteProductDraftEditor,
} from "./product-complete-draft-editor.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
import { createProductEditorClient, type ProductEditorView } from "./product-editor-client.js";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { ProductRecordedConfigurationFields } from "./ProductRecordedConfigurationFields.js";
import type { ProductVersion } from "./catalog-product-command-values.js";
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
}: {
  readonly entry: ProductEditorView | null;
  readonly productReference: string;
  readonly storeReference: string;
  readonly csrf: string;
}) {
  const editor = useRef<CompleteProductDraftEditor | null>(null),
    pending = useRef<AbortController | null>(null),
    active = useRef(true),
    original = useRef<ProductVersion | null>(null);
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
  const [categoryProposal, setCategoryProposal] = useState<InitialCategoryProposal | undefined>();
  const [categoryReady, setCategoryReady] = useState(true);
  const configurationValid = !Object.values(integerInputs).some((input) => !input.valid);
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
    if (!dirty && !view?.pendingSave) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, view?.pendingSave]);
  async function run(action: "Open" | "Refresh" | "Discard" | "Save" | "Retry") {
    if (busy || pending.current || offline || background) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    focusSummary.current = true;
    try {
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
          commands: createProductCommandClient(),
        });
      }
      const current = editor.current;
      if (action === "Save") {
        if (!candidate || !dirty || !configurationValid || !categoryReady)
          throw new CompleteDraftEditorError("Invalid");
        current.edit(candidate, categoryProposal?.source);
        await current.save(serviceOperationReference(), csrf, controller.signal);
        original.current = null;
        setRequiresRefresh(false);
        setCandidate(null);
        setCategoryProposal(undefined);
        setCategoryReady(true);
        setIntegerInputs({});
        setDirty(false);
      } else if (action === "Retry") {
        await current.retry(csrf, controller.signal);
        original.current = null;
        setRequiresRefresh(false);
        setCandidate(null);
        setCategoryProposal(undefined);
        setCategoryReady(true);
        setIntegerInputs({});
        setDirty(false);
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
          setCandidate(next);
          setCategoryProposal(undefined);
          setCategoryReady(true);
          setIntegerInputs({});
          setDirty(false);
        }
      }
    } catch (value) {
      if (active.current)
        setError(
          value instanceof CompleteDraftEditorError || value instanceof StoreCapabilityClientError
            ? value.code
            : "Unavailable",
        );
    } finally {
      if (active.current) {
        if (editor.current) setView(editor.current.view());
        setBusy(false);
      }
      if (pending.current === controller) pending.current = null;
    }
  }
  const current =
    view?.draft &&
    !view.pendingSave &&
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
        Current server checks govern every save. Validation and publication remain unavailable.
      </p>
      {!view ? (
        <button
          disabled={busy || offline || background || !entry?.draft.editorContent}
          onClick={() => void run("Open")}
        >
          Open Draft editor
        </button>
      ) : (
        <div className="product-content-actions">
          <button
            disabled={busy || offline || background || view.pendingSave}
            onClick={() => void run("Refresh")}
          >
            Refresh editable Draft
          </button>
          <button
            disabled={busy || offline || background || view.pendingSave}
            onClick={() => void run("Discard")}
          >
            Discard local edits and reload
          </button>
          {view.pendingSave && (
            <button disabled={busy || offline || background} onClick={() => void run("Retry")}>
              Retry original Draft save
            </button>
          )}
        </div>
      )}
      <p ref={summary} tabIndex={-1} role="status" className="product-draft-result">
        {busy
          ? "Checking current Draft access…"
          : view?.pendingSave
            ? "Save result is unknown. Retry the original request before editing or creating another save."
            : offline
              ? "Draft editor offline. Reconnect and refresh before editing."
              : background
                ? "Draft editor paused. Return and refresh current access."
                : requiresRefresh
                  ? "Refresh current Draft access before editing."
                  : error
                    ? `Draft save not confirmed: ${error}. Refresh or discard local edits to recover.`
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
      {current?.editorContent && (
        <form
          onSubmit={submit}
          aria-label="Recorded Draft text form"
          className="product-complete-draft-fields"
        >
          <fieldset disabled={busy}>
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
            locked={busy}
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
          <fieldset disabled={busy}>
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
              integerInputs={integerInputs}
              onIntegerInput={integerInput}
              onChange={(next) => {
                setCandidate(next);
                setDirty(true);
                setError(null);
              }}
            />
          </fieldset>
          <p id="complete-draft-validation">
            Plain text, decimal strings and whole-number selections only. Existing owning and
            foreign references are retained unless explicitly changed through current Category
            choices. Other reference selection, new SKU/Variant generation and publication controls
            remain unavailable.
          </p>
          <button type="submit" disabled={busy || !dirty || !configurationValid || !categoryReady}>
            Save recorded Draft
          </button>
        </form>
      )}
    </section>
  );
}
