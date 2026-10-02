import { AppFrame } from "@bop-rms/ui";
import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from "react";
import { Link } from "react-router";
import {
  createProductCreationController,
  ProductCreationError,
} from "./product-creation-controller.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
import { createStoreCapabilityClient } from "./store-capability-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { ProductCategoryPicker, type InitialCategoryProposal } from "./ProductCategoryPicker.js";
import type { ProductType } from "./catalog-product-command-values.js";

const messages = {
  Unavailable: "Product creation is unavailable. Refresh current access to try again.",
  Ready: "Current creation access loaded. Review the proposed initial Draft.",
  Stale: "Creation access has expired. Refresh current access before creating.",
  Denied: "Product creation access denied. No new Draft was confirmed.",
  Disabled: "Product creation is disabled for the current Store.",
  ScopeChanged: "The creation context changed. Return to the current Products workspace.",
  Invalid: "Check the code, type, locale, name and initial configuration acknowledgement.",
  Conflict:
    "The original creation request conflicts with current data. No new Draft was confirmed.",
  OutcomeUnknown: "Creation result is unknown. Keep this page open and retry the original request.",
  Confirmed: "Original creation confirmed. The initial Draft has no SKUs and is not published.",
} as const;
export function ProductCreatePage({
  storeReference,
  storeLabel,
  brandLabel,
  csrf,
}: {
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly brandLabel: string;
  readonly csrf: string;
}) {
  const active = useRef(true),
    pending = useRef<AbortController | null>(null),
    result = useRef<HTMLParagraphElement>(null),
    flight = useRef<"Refresh" | "Create" | "Retry" | null>(null);
  const [controller] = useState(() =>
    createProductCreationController({
      storeReference,
      currentContext: () => (active.current ? 0 : 1),
      now: Date.now,
      capabilities: createStoreCapabilityClient(),
      commands: createProductCommandClient(),
    }),
  );
  const [view, setView] = useState(() => controller.view()),
    [busy, setBusy] = useState(false),
    [offline, setOffline] = useState(!navigator.onLine),
    [background, setBackground] = useState(document.visibilityState === "hidden"),
    [acknowledged, setAcknowledged] = useState(false),
    [category, setCategory] = useState<InitialCategoryProposal | undefined>(),
    [categoryReady, setCategoryReady] = useState(true),
    [fields, setFields] = useState({
      code: "",
      type: "",
      locale: "",
      name: "",
      short: "",
      description: "",
      notes: "",
    });
  const locked =
    busy ||
    view.pending ||
    view.receipt !== null ||
    view.state !== "Ready" ||
    offline ||
    background;
  async function run(action: "Refresh" | "Create" | "Retry", focus = true) {
    if (
      pending.current ||
      !active.current ||
      !navigator.onLine ||
      document.visibilityState === "hidden"
    )
      return;
    const request = new AbortController();
    pending.current = request;
    flight.current = action;
    setBusy(true);
    try {
      if (action === "Refresh") await controller.refresh(csrf, request.signal);
      else if (action === "Retry") await controller.retry(csrf, request.signal);
      else {
        if (!acknowledged) throw new ProductCreationError("Invalid");
        const localized = (text: string) => (text ? { [fields.locale]: text } : {});
        await controller.create(
          {
            internalCode: fields.code,
            ...(category ? { categoryClassification: category.classification } : {}),
            productType: fields.type as ProductType,
            defaultLocale: fields.locale,
            localizedNames: { [fields.locale]: fields.name },
            taxClassificationReference: null,
            operationReference: serviceOperationReference(),
            skus: [],
            editorContent: {
              profile: "CatalogProductEditorContentV1",
              localizedShortDescriptions: localized(fields.short),
              localizedDescriptions: localized(fields.description),
              preparationNotes: localized(fields.notes),
              tagReferences: [],
              attributeValues: [],
              media: [],
              variantDimensions: [],
              variantCombinations: [],
              optionRules: [],
              allergenReferences: [],
              nutritionProfile: null,
            },
          },
          csrf,
          request.signal,
          category?.source,
        );
      }
      if (active.current) setView(controller.view());
    } catch (error) {
      if (active.current) {
        const next = controller.view();
        setView(
          error instanceof ProductCreationError &&
            error.code === "Invalid" &&
            next.state === "Ready"
            ? { ...next, state: "Invalid" }
            : next,
        );
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        flight.current = null;
      }
      if (active.current) {
        setBusy(false);
        if (focus) result.current?.focus();
      }
    }
  }
  useEffect(() => {
    active.current = true;
    const network = () => {
      setOffline(!navigator.onLine);
      if (!navigator.onLine) pending.current?.abort();
    };
    const visibility = () => {
      setBackground(document.visibilityState === "hidden");
      if (document.visibilityState === "hidden") pending.current?.abort();
    };
    window.addEventListener("offline", network);
    window.addEventListener("online", network);
    document.addEventListener("visibilitychange", visibility);
    void run("Refresh", false);
    return () => {
      active.current = false;
      pending.current?.abort();
      window.removeEventListener("offline", network);
      window.removeEventListener("online", network);
      document.removeEventListener("visibilitychange", visibility);
    };
    // This page is keyed by authenticated scope/CSRF; entry loads only once.
  }, []);
  useEffect(() => {
    if (view.validUntil === null) return;
    const timer = setTimeout(
      () => {
        if (active.current) setView(controller.view());
      },
      Math.max(0, view.validUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [controller, view.validUntil]);
  useEffect(() => {
    if (!view.pending && !busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [view.pending, busy]);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!locked && categoryReady) void run("Create");
  }
  const invalid = view.state === "Invalid";
  function field(
    key: "code" | "locale" | "name" | "short" | "description" | "notes",
    label: string,
    maximum: number,
    multiline = false,
  ) {
    const props = {
      value: fields[key],
      maxLength: maximum,
      disabled: locked,
      "aria-invalid": invalid,
      "aria-describedby": invalid ? "product-create-result" : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setFields((old) => ({ ...old, [key]: event.target.value })),
    };
    return (
      <label>
        {label}
        {multiline ? <textarea {...props} /> : <input {...props} />}
      </label>
    );
  }
  return (
    <AppFrame
      className="bop-shell--product-create"
      title="Create product"
      description="CAT-PRODUCT-CREATE · Initial Draft"
      navigation={
        <>
          {view.pending || (busy && flight.current !== "Refresh") ? (
            <span>Resolve the original request before leaving.</span>
          ) : (
            <Link to="/app/commerce/products">Back to products</Link>
          )}
        </>
      }
    >
      <section className="product-creation product-complete-draft">
        <p>
          {brandLabel} · {storeLabel}
        </p>
        <p>
          Create an initial Draft, then configure its content and publication in the editor. Current
          backend field and reference checks must allow creation.
        </p>
        <p
          id="product-create-result"
          className="product-draft-result"
          ref={result}
          tabIndex={-1}
          role="status"
          aria-live="polite"
        >
          {busy
            ? "Checking current access and request…"
            : offline
              ? "Offline. Creation and recovery require current access."
              : background
                ? "Return to this page before continuing."
                : messages[view.state]}
        </p>
        <form noValidate onSubmit={submit} className="product-complete-draft-fields">
          <fieldset disabled={locked}>
            <legend>Initial Draft proposal</legend>
            {field("code", "Internal code", 64)}
            <label>
              Product type
              <select
                value={fields.type}
                onChange={(event) => setFields((old) => ({ ...old, type: event.target.value }))}
                aria-invalid={invalid}
                aria-describedby={invalid ? "product-create-result" : undefined}
              >
                <option value="">Choose a type</option>
                <option value="PreparedFood">Prepared food</option>
                <option value="NonAlcoholicBeverage">Non-alcoholic beverage</option>
              </select>
            </label>
            {field("locale", "Default locale (for example en-CA)", 35)}
            {field("name", "Product name", 120)}
            {field("short", "Short description", 240, true)}
            {field("description", "Description", 4096, true)}
            {field("notes", "Preparation notes", 1000, true)}
            <ProductCategoryPicker
              key={`${view.brandReference}/${storeReference}/${fields.locale}`}
              brandReference={view.brandReference}
              storeReference={storeReference}
              locale={fields.locale}
              locked={locked}
              proposal={category}
              onChange={setCategory}
              onReadiness={setCategoryReady}
            />
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                aria-invalid={invalid}
                aria-describedby={invalid ? "product-create-result" : "product-create-unconfigured"}
              />
              Start without SKUs or other content reference assignments
            </label>
            <p id="product-create-unconfigured">
              Media, tags, attributes, variants, options, allergens, nutrition and tax are
              unconfigured. Empty fields do not establish safety, readiness or selling eligibility.
              Other reference pickers and new SKU configuration are unavailable here.
            </p>
          </fieldset>
          <div className="bop-actions">
            <button type="submit" disabled={locked || !categoryReady || !acknowledged}>
              Create initial Draft
            </button>
            <button
              type="button"
              disabled={busy || offline || background || view.receipt !== null}
              onClick={() => void run("Refresh")}
            >
              Refresh current creation access
            </button>
            {view.pending && (
              <button
                type="button"
                disabled={busy || offline || background}
                onClick={() => void run("Retry")}
              >
                Retry original creation
              </button>
            )}
          </div>
        </form>
        {view.receipt && (
          <Link
            to={`/app/commerce/products/${view.receipt.productReference}/edit`}
            state={{
              productReference: view.receipt.productReference,
              expectedAggregateVersion: view.receipt.aggregateVersion,
            }}
          >
            Open created Draft
          </Link>
        )}
        {view.pending && (
          <p>
            This page retains the original request while open. Reload or leaving this workspace can
            lose local recovery details; owning operation discovery is unavailable.
          </p>
        )}
      </section>
    </AppFrame>
  );
}
