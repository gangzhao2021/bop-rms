import { useEffect, useRef, useState } from "react";
import {
  createProductCategoryLookupClient,
  ProductCategoryLookupClientError,
  type ProductCategoryLookupView,
  type ProductCategoryLookupScreen,
} from "./catalog-product-category-lookup-client.js";
import { selectProductCategoryClassification } from "./catalog-product-category-selection.js";
import type { ProductCategoryClassification } from "./catalog-product-command-values.js";

export interface InitialCategoryProposal {
  readonly classification: ProductCategoryClassification;
  readonly source: ProductCategoryLookupView;
}
/** Related choices constrain authoring; they never supply native mutation authority. */
export function ProductCategoryPicker({
  screenId = "CAT-PRODUCT-CREATE",
  storedClassification,
  brandReference,
  storeReference,
  locale,
  locked,
  proposal,
  onChange,
  onReadiness,
}: {
  readonly screenId?: ProductCategoryLookupScreen;
  readonly storedClassification?: ProductCategoryClassification | undefined;
  readonly brandReference: string | null;
  readonly storeReference: string;
  readonly locale: string;
  readonly locked: boolean;
  readonly proposal: InitialCategoryProposal | undefined;
  readonly onChange: (value: InitialCategoryProposal) => void;
  readonly onReadiness: (ready: boolean) => void;
}) {
  const [client] = useState(() => createProductCategoryLookupClient());
  const [source, setSource] = useState<ProductCategoryLookupView | null>(null);
  const [status, setStatus] = useState(
    "Categories unspecified. Load current choices to configure.",
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const request = useRef<AbortController | null>(null);
  const context = `${screenId}|${brandReference}|${storeReference}|${locale}`;
  const currentContext = useRef(context);
  currentContext.current = context;
  const at = Date.now();
  const fresh =
    source !== null &&
    source.lookup.parentScreenId === screenId &&
    source.scope.brandReference === brandReference &&
    source.scope.storeReference === storeReference &&
    source.lookup.locale === locale &&
    at >= Date.parse(source.lookup.source.asOfUtc) &&
    at < Date.parse(source.lookup.source.asOfUtc) + 5000;
  let eligible = !proposal;
  if (proposal && fresh && source && brandReference) {
    try {
      selectProductCategoryClassification(
        proposal.classification,
        source,
        screenId,
        { brandReference, storeReference, locale },
        at,
      );
      eligible = true;
    } catch {
      eligible = false;
    }
  }
  useEffect(() => onReadiness(eligible && !busy), [eligible, busy, onReadiness]);
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.max(0, Date.parse(source.lookup.source.asOfUtc) + 5000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [source]);
  useEffect(() => {
    const abort = () => {
      if (!navigator.onLine || document.visibilityState === "hidden") request.current?.abort();
    };
    window.addEventListener("offline", abort);
    document.addEventListener("visibilitychange", abort);
    return () => {
      currentContext.current = "";
      request.current?.abort();
      window.removeEventListener("offline", abort);
      document.removeEventListener("visibilitychange", abort);
    };
  }, [context]);
  async function load() {
    if (locked || request.current || !brandReference || !locale) return;
    const captured = context,
      controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setSource(null);
    setStatus("Loading current Category choices…");
    try {
      const next = await client.load(
        screenId,
        { brandReference, storeReference, locale },
        controller.signal,
      );
      if (controller.signal.aborted || captured !== currentContext.current) return;
      setSource(next);
      setStatus(
        next.lookup.items.length
          ? "Current Draft configuration choices loaded."
          : "No eligible current Category choices.",
      );
      if (proposal) onChange({ classification: proposal.classification, source: next });
    } catch (error) {
      if (!controller.signal.aborted && captured === currentContext.current)
        setStatus(
          error instanceof ProductCategoryLookupClientError && error.code === "Denied"
            ? "Category access denied. Existing proposal retained; no assignment inferred."
            : error instanceof ProductCategoryLookupClientError && error.code === "FeatureDisabled"
              ? "Category configuration is disabled for the current Store. Existing proposal retained."
              : error instanceof ProductCategoryLookupClientError && error.code === "Stale"
                ? "Category source expired. Refresh current choices; existing proposal retained."
                : "Current Categories unavailable. Existing proposal retained; no assignment inferred.",
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (captured === currentContext.current) {
        setBusy(false);
        if (controller.signal.aborted)
          setStatus(
            "Current Categories unavailable. Existing proposal retained; no assignment inferred.",
          );
      }
    }
  }
  function select(classification: ProductCategoryClassification) {
    if (locked || busy || !fresh || !source || !brandReference) return;
    try {
      const checked = selectProductCategoryClassification(
        classification,
        source,
        screenId,
        { brandReference, storeReference, locale },
        Date.now(),
      );
      onChange({ classification: checked, source });
    } catch {
      setStatus("Selection unavailable. Refresh current choices before continuing.");
      setSource(null);
    }
  }
  const classification = proposal?.classification ?? storedClassification;
  const selected = classification?.categoryReferences ?? [];
  const primary = classification?.primaryCategoryReference ?? null;
  const matches =
    fresh && source
      ? source.lookup.items.filter((item) =>
          `${item.name} ${item.internalCode}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
      : [];
  return (
    <fieldset disabled={locked || busy}>
      <legend>{screenId === "CAT-PRODUCT-EDIT" ? "Draft Categories" : "Initial Categories"}</legend>
      <p role="status" aria-live="polite">
        {source && !fresh
          ? `Category choices expired or context changed. Refresh before configuring or ${screenId === "CAT-PRODUCT-EDIT" ? "saving" : "creating"}.`
          : status}
      </p>
      {screenId === "CAT-PRODUCT-EDIT" && storedClassification && (
        <p>
          {storedClassification.categoryReferences.length} recorded Categories. Loading choices
          keeps existing assignments.
        </p>
      )}
      {proposal && (
        <p>
          {selected.length} proposed Categories.{" "}
          {!eligible &&
            `Refresh and correct the selection before ${screenId === "CAT-PRODUCT-EDIT" ? "saving" : "creating"}.`}
        </p>
      )}
      <button
        type="button"
        disabled={locked || busy || !brandReference || !locale}
        onClick={() => void load()}
      >
        Load current Categories
      </button>
      {fresh && source && !locked && (
        <>
          <p>
            Partial Draft configuration lookup. Choices do not establish publication or selling
            eligibility.
          </p>
          <label>
            Search Category choices
            <input
              value={query}
              maxLength={120}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p>{matches.length} matches; showing up to 100. Search to narrow results.</p>
          {matches.slice(0, 100).map((item) => (
            <label key={item.categoryReference}>
              <input
                type="checkbox"
                checked={selected.includes(item.categoryReference)}
                onChange={(event) => {
                  const refs = event.target.checked
                    ? [...selected, item.categoryReference]
                    : selected.filter((ref) => ref !== item.categoryReference);
                  select({
                    categoryReferences: refs,
                    primaryCategoryReference: primary && refs.includes(primary) ? primary : null,
                  });
                }}
              />
              {item.name} · {item.internalCode} · {item.lifecycle}
              {item.localeFallback ? " · fallback label" : ""}
            </label>
          ))}
          <label>
            Primary Category
            <select
              value={primary ?? ""}
              onChange={(event) =>
                select({
                  categoryReferences: selected,
                  primaryCategoryReference: event.target.value || null,
                })
              }
            >
              <option value="">No primary Category</option>
              {primary &&
                !source.lookup.items.some((item) => item.categoryReference === primary) && (
                  <option value={primary}>Recorded primary outside current choices</option>
                )}
              {source.lookup.items
                .filter((item) => selected.includes(item.categoryReference))
                .map((item) => (
                  <option key={item.categoryReference} value={item.categoryReference}>
                    {item.name} · {item.internalCode}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => select({ categoryReferences: [], primaryCategoryReference: null })}
          >
            Use no Categories
          </button>
        </>
      )}
    </fieldset>
  );
}
