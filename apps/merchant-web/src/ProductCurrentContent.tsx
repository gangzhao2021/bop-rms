import type { ProductPublicationManagementViewV2 } from "./product-publication-management-client-v2.js";
import { ProductPublicationForm } from "./ProductPublicationForm.js";
import { ProductOptionPrices } from "./ProductOptionPrices.js";
import { ProductCompleteDraftForm } from "./ProductCompleteDraftForm.js";
import { StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState, useRef, type FormEvent } from "react";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  createProductEditorClient,
  ProductEditorClientError,
  type ProductEditorView,
} from "./product-editor-client.js";
import { parseCatalogReference } from "./catalog-product-command-values.js";
type State =
  | {
      key: string;
      kind:
        | "Idle"
        | "Loading"
        | "Offline"
        | "Disabled"
        | "Invalid"
        | "Denied"
        | "Unavailable"
        | "Stale"
        | "ScopeChanged";
    }
  | { key: string; kind: "Found"; view: ProductEditorView };
interface Props {
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly brandLabel: string;
  readonly csrf: string;
}
export function ProductCurrentContent({
  storeReference,
  csrf,
  id,
  initialRevision,
  onConfirmed,
  onManagement,
}: Props & {
  readonly id: string | undefined;
  readonly initialRevision: string;
  readonly onConfirmed?: (revision: number) => void;
  readonly onManagement?: (view: ProductPublicationManagementViewV2 | null) => void;
}) {
  const client = useMemo(() => createProductEditorClient(), []),
    capability = useMemo(() => createStoreCapabilityClient(), []);
  const [publicationRefresh, setPublicationRefresh] = useState(0);
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const [publicationBlocked, setPublicationBlocked] = useState(false),
    [draftBlocked, setDraftBlocked] = useState(false);
  const [revision, setRevision] = useState(initialRevision),
    [request, setRequest] = useState({ revision: initialRevision, refresh: 0 });
  const key = JSON.stringify([id, storeReference, csrf, request]),
    [state, setState] = useState<State>({ key, kind: request.revision ? "Loading" : "Idle" });
  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const offline = () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      if (active) setState({ key, kind: "Offline" });
    };
    const online = () => {
      if (active) setState({ key, kind: "Unavailable" });
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        controller.abort();
        if (timer) clearTimeout(timer);
        if (active) setState({ key, kind: "Stale" });
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (!navigator.onLine) offline();
    else if (document.visibilityState === "hidden") visibility();
    else if (!request.revision) setState({ key, kind: "Idle" });
    else {
      setState({ key, kind: "Loading" });
      void (async () => {
        let productReference: string;
        try {
          productReference = parseCatalogReference(id);
        } catch {
          throw new ProductEditorClientError("Invalid");
        }
        const expectedAggregateVersion = Number(request.revision);
        if (!/^[1-9][0-9]{0,9}$/u.test(request.revision) || expectedAggregateVersion > 2147483647)
          throw new ProductEditorClientError("Invalid");
        const gate = await capability.load(
          { scope: { storeReference }, capabilityKey: "catalog.cat_product_edit", csrf },
          controller.signal,
        );
        if (!active || controller.signal.aborted) return;
        if (gate.backendExecution !== "Allow" || gate.frontendVisibility !== "Show") {
          setState({ key, kind: "Disabled" });
          return;
        }
        const view = await client.load(
          {
            request: {
              brandReference: gate.brandReference,
              storeReference,
              productReference,
              expectedAggregateVersion,
            },
            csrf,
          },
          controller.signal,
        );
        if (!active || controller.signal.aborted) return;
        const deadline = Math.min(Date.parse(gate.observedAt) + 5000, Date.parse(view.validUntil));
        if (Date.now() < Date.parse(gate.observedAt) || Date.now() >= deadline) {
          setState({ key, kind: "Stale" });
          return;
        }
        setState({ key, kind: "Found", view });
        timer = setTimeout(() => {
          if (active) setState({ key, kind: "Stale" });
        }, deadline - Date.now());
      })().catch((error: unknown) => {
        if (active && !controller.signal.aborted)
          setState({
            key,
            kind:
              error instanceof ProductEditorClientError ||
              error instanceof StoreCapabilityClientError
                ? error.code
                : "Unavailable",
          });
      });
    }
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [capability, client, csrf, id, key, request.revision, storeReference]);
  const confirmed = (next: number, receiptRevision = next) => {
    setConfirmedRevision(receiptRevision);
    setRevision(String(next));
    setRequest((previous) => ({ revision: String(next), refresh: previous.refresh + 1 }));
    onConfirmed?.(next);
  };
  const current = state.key === key ? state : { kind: "Loading" as const, key };
  const summary = useRef<HTMLDivElement>(null),
    focusResult = useRef(false);
  useEffect(() => {
    if (focusResult.current && current.kind !== "Loading") {
      focusResult.current = false;
      summary.current?.focus();
    }
  }, [current.kind]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    focusResult.current = true;
    if (!/^[1-9][0-9]{0,9}$/u.test(revision) || Number(revision) > 2147483647) {
      setState({ key, kind: "Invalid" });
      return;
    }
    setRequest((previous) => ({ revision, refresh: previous.refresh + 1 }));
  };
  const copy = {
    Idle: [
      "Choose a current content revision",
      "Use the current revision shown in Products to read its current Product content.",
    ],
    Loading: [
      "Loading current Product content",
      "Checking current access and recorded complete Product content…",
    ],
    Invalid: [
      "Invalid current content revision",
      "Enter a whole revision number from 1 to 2147483647 for this Product.",
    ],
    Offline: ["Current content offline", "Connect and refresh before reading current content."],
    Disabled: [
      "Current content disabled",
      "Current Product editing capability is disabled or unavailable for this Store.",
    ],
    Denied: [
      "Current content permission denied",
      "Current Product content is unavailable for this session and scope.",
    ],
    Unavailable: [
      "Current content unavailable",
      "Current records could not be read. Return to Products and reopen this Product at its current revision; any original publication request is retained for retry.",
    ],
    Stale: [
      "Current content stale",
      "This observation has expired or the Product revision changed. Return to Products and reopen the current revision to restore any original publication request.",
    ],
    ScopeChanged: [
      "Current content scope changed",
      "Select the correct Brand and Store, then refresh current content.",
    ],
  } as const;
  return (
    <section className="product-current-content" aria-labelledby="product-current-title">
      <h2 id="product-current-title">Current Product content</h2>
      {confirmedRevision !== null && (
        <p role="status">Product change confirmed · Revision {confirmedRevision}.</p>
      )}
      <form className="product-history-tools" onSubmit={submit}>
        <label htmlFor="product-content-revision">Current content revision</label>
        <input
          id="product-content-revision"
          inputMode="numeric"
          value={revision}
          maxLength={10}
          aria-describedby="product-content-revision-help"
          aria-invalid={current.kind === "Invalid" || undefined}
          onChange={(e) => setRevision(e.currentTarget.value)}
        />
        <button type="submit" disabled={current.kind === "Loading" || current.kind === "Offline"}>
          Refresh current content
        </button>
        <p id="product-content-revision-help">
          Use the current revision in Products. Open the recorded Draft editor for supported text
          changes; current server access and reference checks govern every save.
        </p>
      </form>
      <div ref={summary} tabIndex={-1} className="product-content-result">
        {current.kind === "Found" ? (
          <CurrentCanvas view={current.view} />
        ) : (
          <StatePanel
            heading={copy[current.kind][0]}
            tone={current.kind === "Denied" || current.kind === "Invalid" ? "error" : "neutral"}
            status
          >
            <p>{copy[current.kind][1]}</p>
          </StatePanel>
        )}
      </div>
      {id && (
        <ProductPublicationForm
          key={JSON.stringify([id, storeReference, csrf])}
          entry={current.kind === "Found" ? current.view : null}
          productReference={id}
          storeReference={storeReference}
          csrf={csrf}
          blocked={draftBlocked}
          onBlockedChange={setPublicationBlocked}
          onConfirmed={(next, receiptRevision) => {
            setPublicationRefresh((previous) => previous + 1);
            confirmed(next, receiptRevision);
          }}
          onResolved={(next) => {
            setConfirmedRevision(null);
            setRevision(String(next));
            setRequest((previous) => ({ revision: String(next), refresh: previous.refresh + 1 }));
            setPublicationRefresh((previous) => previous + 1);
          }}
          {...(onManagement ? { onManagement } : {})}
        />
      )}
      {id && (
        <ProductCompleteDraftForm
          key={JSON.stringify([id, storeReference, csrf, publicationRefresh])}
          entry={current.kind === "Found" ? current.view : null}
          productReference={id}
          storeReference={storeReference}
          csrf={csrf}
          blocked={publicationBlocked}
          onBlockedChange={setDraftBlocked}
          onConfirmed={confirmed}
        />
      )}
      {id && (
        <ProductOptionPrices
          entry={current.kind === "Found" ? current.view : null}
          productReference={id}
          storeReference={storeReference}
          csrf={csrf}
        />
      )}
    </section>
  );
}
function Localized({ values }: { readonly values: Readonly<Record<string, string>> }) {
  return Object.keys(values).length === 0 ? (
    <p>No content recorded.</p>
  ) : (
    <dl className="detail-list">
      {Object.entries(values).map(([locale, text]) => (
        <div key={locale}>
          <dt>{locale}</dt>
          <dd className="product-content-prose">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
function CurrentCanvas({ view }: { readonly view: ProductEditorView }) {
  const content = view.content;
  return (
    <div className="product-content-canvas">
      <p role="status">Current Draft content loaded · Revision {view.revision} · Read-only</p>
      <p>This view expires shortly. Refresh to read current content again.</p>
      <p>
        Read at <time dateTime={view.observedAt}>{view.observedAt}</time>
      </p>
      <nav aria-label="Product content sections">
        <a href="#product-content-identity">Identity</a>
        <a href="#product-content-copy">Copy</a>
        <a href="#product-content-skus">SKUs and variants</a>
        <a href="#product-content-media">Media</a>
        <a href="#product-content-options">Options</a>
        <a href="#product-content-references">References and validation</a>
      </nav>
      <div className="product-content-sections">
        <section id="product-content-identity" aria-labelledby="product-content-identity-title">
          <h3 id="product-content-identity-title">Identity and classification</h3>
          <p>
            {view.internalCode} · {view.productType} · {view.lifecycle}
          </p>
          <Localized values={view.draft.localizedNames} />
          <p>
            Category classification:{" "}
            {view.draft.categoryClassification
              ? `${view.draft.categoryClassification.categoryReferences.length} references configured`
              : "Unavailable"}
          </p>
          <p>
            Tax classification:{" "}
            {view.draft.taxClassificationReference === null
              ? "Not configured"
              : "Reference configured"}
          </p>
        </section>
        <section id="product-content-copy" aria-labelledby="product-content-copy-title">
          <h3 id="product-content-copy-title">Descriptions and preparation</h3>
          {content ? (
            <>
              <h4>Short descriptions</h4>
              <Localized values={content.shortDescriptions} />
              <h4>Descriptions</h4>
              <Localized values={content.descriptions} />
              <h4>Preparation notes</h4>
              <Localized values={content.preparation} />
            </>
          ) : (
            <p>
              Complete content was not recorded for this Draft. An empty editable form cannot be
              supplied.
            </p>
          )}
        </section>
        <section id="product-content-skus" aria-labelledby="product-content-skus-title">
          <h3 id="product-content-skus-title">SKUs and variants</h3>
          {view.draft.skus.length === 0 ? (
            <p>No SKUs recorded.</p>
          ) : (
            view.draft.skus.map((sku, i) => (
              <article key={sku.skuReference}>
                <h4>
                  SKU {i + 1}: {sku.skuCode}
                </h4>
                <Localized values={sku.localizedNames} />
                <p>
                  {sku.lifecycle} · {sku.unitQuantity} {sku.unitOfSale}
                </p>
                <p>{sku.variantSelections.length} variant selections recorded.</p>
              </article>
            ))
          )}
          {content && (
            <>
              <p>
                {content.dimensions.length} dimensions · {content.combinations.length} recorded
                combinations
              </p>
              {content.dimensions.map((dimension, i) => (
                <article key={dimension.reference}>
                  <h4>
                    Dimension {i + 1}: {dimension.code}
                  </h4>
                  <Localized values={dimension.names} />
                  <p>{dimension.requirement}</p>
                  <ul>
                    {dimension.values.map((v) => (
                      <li key={v.reference}>
                        {v.code} · {Object.values(v.names).join(" · ")}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
              {content.combinations.map((c, i) => (
                <p key={i}>
                  Combination {i + 1}: {c.disposition} · {c.selections.length} selections ·{" "}
                  {c.skuReference === null ? "No SKU linked" : "SKU linked"}
                </p>
              ))}
            </>
          )}
        </section>
        <section id="product-content-media" aria-labelledby="product-content-media-title">
          <h3 id="product-content-media-title">Media configuration</h3>
          {!content ? (
            <p>Complete media configuration unavailable.</p>
          ) : content.media.length === 0 ? (
            <p>No media references recorded.</p>
          ) : (
            content.media.map((m, i) => (
              <article key={i}>
                <h4>
                  Media {i + 1}: {m.role}
                </h4>
                <p>Sort order {m.sortOrder} · Asset reference configured</p>
                <Localized values={m.altText} />
              </article>
            ))
          )}
          <p>Asset preview and current readiness are unavailable.</p>
        </section>
        <section id="product-content-options" aria-labelledby="product-content-options-title">
          <h3 id="product-content-options-title">Option bindings and rules</h3>
          {view.draft.optionBindings.length === 0 ? (
            <p>No Option bindings recorded.</p>
          ) : (
            view.draft.optionBindings.map((b, i) => (
              <article key={b.bindingReference}>
                <h4>
                  Binding {i + 1}: {b.purpose}
                </h4>
                <p>
                  Sort order {b.sortOrder} · {b.channelCodes.join(", ") || "All channels"}
                </p>
                <p>
                  Selection minimum {b.minimumSelectionOverride ?? "Inherited"} · maximum{" "}
                  {b.maximumSelectionOverride ?? "Inherited"}
                </p>
                <p>
                  {b.enabledOptionReferences.length} enabled Option references ·{" "}
                  {b.defaultSelections.length} default selections
                </p>
                <p>
                  {b.includedSkuReferences.length} included SKUs · {b.excludedSkuReferences.length}{" "}
                  excluded SKUs · Store override {b.storeOverrideAllowed ? "allowed" : "disabled"}
                </p>
              </article>
            ))
          )}
          {content?.optionRules.map((r, i) => (
            <article key={i}>
              <h4>
                Option rule {i + 1}: {r.resolution}
              </h4>
              <p>
                Pricing {r.pricing ? "configured" : "not configured"} · condition{" "}
                {r.condition ? "configured" : "not configured"} · conflict{" "}
                {r.conflict ? "configured" : "not configured"} · {r.variants.length} variant
                conditions
              </p>
            </article>
          ))}
          <p>Current Option eligibility and pricing have not been checked.</p>
        </section>
        <section id="product-content-references" aria-labelledby="product-content-references-title">
          <h3 id="product-content-references-title">References and validation</h3>
          {content ? (
            <>
              <p>
                {content.tagCount} Tag references configured · {content.attributeValues.length}{" "}
                typed attributes
              </p>
              <ul>
                {content.attributeValues.map((a, i) => (
                  <li key={i}>
                    Attribute {i + 1}: {a.type} · {a.display}
                  </li>
                ))}
              </ul>
              <p>
                {content.allergenCount} Safety references configured · Nutrition profile{" "}
                {content.nutritionConfigured ? "configured" : "not configured"}
              </p>
            </>
          ) : (
            <p>Additional reference configuration unavailable.</p>
          )}
          <p>
            Reference labels, current approval and professional evidence are unavailable.
            Availability, price, tax and sale eligibility have not been checked.
          </p>
          <p>
            Current publication validation is incomplete. Publication requests require current
            server admission; recorded metadata does not establish qualification.
          </p>
          <div className="product-content-actions" aria-label="Product content actions">
            <button disabled>Save Draft</button>
            <button disabled>Validate</button>
            <button disabled>Submit review</button>
            <button disabled>Publish</button>
          </div>
        </section>
      </div>
    </div>
  );
}
