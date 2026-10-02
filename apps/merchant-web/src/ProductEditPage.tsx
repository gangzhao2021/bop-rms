import { ProductCurrentContent } from "./ProductCurrentContent.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  createStoreCapabilityClient,
  StoreCapabilityClientError,
} from "./store-capability-client.js";
import {
  createProductScopeJournalClient,
  ProductScopeJournalClientError,
  type ProductScopeJournalView,
} from "./product-scope-journal-client.js";
import { parseCatalogReference, productCommandRecord } from "./catalog-product-command-values.js";
function navigationRevision(value: unknown, product: unknown): string {
  try {
    const r = productCommandRecord(value, ["productReference", "expectedAggregateVersion"]);
    if (
      r.productReference !== product ||
      !Number.isSafeInteger(r.expectedAggregateVersion) ||
      (r.expectedAggregateVersion as number) < 1 ||
      (r.expectedAggregateVersion as number) > 2147483647
    )
      return "";
    return String(r.expectedAggregateVersion);
  } catch {
    return "";
  }
}
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
  | { key: string; kind: "Found"; view: ProductScopeJournalView };
interface Props {
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly brandLabel: string;
  readonly csrf: string;
}
export function ProductEditPage(props: Props) {
  const { id } = useParams(),
    location = useLocation();
  return (
    <ProductHistoryWorkspace
      key={JSON.stringify([id, location.key])}
      {...props}
      id={id}
      initialRevision={navigationRevision(location.state, id)}
    />
  );
}
function ProductHistoryWorkspace({
  storeReference,
  storeLabel,
  brandLabel,
  csrf,
  id,
  initialRevision,
}: Props & { readonly id: string | undefined; readonly initialRevision: string }) {
  const client = useMemo(() => createProductScopeJournalClient(), []),
    capability = useMemo(() => createStoreCapabilityClient(), []);
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
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (!navigator.onLine) offline();
    else if (!request.revision) setState({ key, kind: "Idle" });
    else {
      setState({ key, kind: "Loading" });
      void (async () => {
        let productReference: string;
        try {
          productReference = parseCatalogReference(id);
        } catch {
          throw new ProductScopeJournalClientError("Invalid");
        }
        const expectedAggregateVersion = Number(request.revision);
        if (!/^[1-9][0-9]{0,9}$/u.test(request.revision) || expectedAggregateVersion > 2147483647)
          throw new ProductScopeJournalClientError("Invalid");
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
              error instanceof ProductScopeJournalClientError ||
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
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [capability, client, csrf, id, key, request.revision, storeReference]);
  const current = state.key === key ? state : { kind: "Loading" as const, key };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!/^[1-9][0-9]{0,9}$/u.test(revision) || Number(revision) > 2147483647) {
      setState({ key, kind: "Invalid" });
      return;
    }
    setRequest((previous) => ({ revision, refresh: previous.refresh + 1 }));
  };
  const copy = {
    Idle: [
      "Choose a Product revision",
      "Use the current revision shown in Products to read its publication scope history.",
    ],
    Loading: [
      "Loading publication scope history",
      "Checking current access and recorded publication scopes…",
    ],
    Invalid: [
      "Invalid Product revision",
      "Enter a whole revision number from 1 to 2147483647 for this Product.",
    ],
    Offline: ["Offline", "Connect and refresh before reading publication history."],
    Disabled: [
      "Product management disabled",
      "Current Product editing capability is disabled or unavailable for this Store.",
    ],
    Denied: [
      "Permission denied",
      "Publication scope history is unavailable for this session and scope.",
    ],
    Unavailable: [
      "Publication history unavailable",
      "Current records could not be read. Check the revision in Products and try again.",
    ],
    Stale: [
      "Publication history stale",
      "This observation has expired or the Product revision changed. Refresh using the current revision.",
    ],
    ScopeChanged: [
      "Product scope changed",
      "Select the correct Brand and Store, then refresh publication history.",
    ],
  } as const;
  return (
    <AppFrame
      className="product-history-screen"
      title="Product workspace"
      description={`${brandLabel} · ${storeLabel}`}
    >
      <Link to="/app/commerce/products">Back to products</Link>
      <ProductCurrentContent
        storeReference={storeReference}
        storeLabel={storeLabel}
        brandLabel={brandLabel}
        csrf={csrf}
        id={id}
        initialRevision={initialRevision}
      />
      <section className="product-history-tools" aria-labelledby="product-history-heading">
        <h2 id="product-history-heading">Publication scope history</h2>
        <form onSubmit={submit}>
          <label htmlFor="product-history-revision">Product revision</label>
          <input
            id="product-history-revision"
            inputMode="numeric"
            value={revision}
            maxLength={10}
            aria-describedby="product-history-revision-help"
            aria-invalid={current.kind === "Invalid" || undefined}
            onChange={(e) => setRevision(e.currentTarget.value)}
          />
          <button type="submit" disabled={current.kind === "Loading" || current.kind === "Offline"}>
            Refresh publication history
          </button>
          <p id="product-history-revision-help">
            Use the current revision from Products. Reading records does not change a Product.
          </p>
        </form>
      </section>
      {current.kind === "Found" ? (
        <section aria-label="Recorded publication scopes">
          <p role="status">
            {current.view.versions.length === 0
              ? "No publication history is recorded for this revision."
              : `${current.view.versions.length} version records loaded.`}
          </p>
          <p>
            These are original publication records. Current sale eligibility and scope replacement
            have not been checked.
          </p>
          <p>
            Read at <time dateTime={current.view.observedAt}>{current.view.observedAt}</time>
          </p>
          <div className="product-history-records">
            {current.view.versions.map((version, index) => (
              <article key={version.versionReference}>
                <h3>Version record {index + 1}</h3>
                <p>
                  {version.state} · Publication revision {version.publicationVersion}
                </p>
                {version.recordStatus === "NotRecorded" ? (
                  <p>Original scope record was not recorded for this publication.</p>
                ) : version.recordStatus === "NotApplicable" ? (
                  <p>Scope recording is not applicable to this unpublished version.</p>
                ) : version.journal ? (
                  <>
                    <p>Original scope record available.</p>
                    <dl className="detail-list">
                      <div>
                        <dt>Recorded</dt>
                        <dd>
                          <time dateTime={version.journal.recordedAt}>
                            {version.journal.recordedAt}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Original evidence deadline</dt>
                        <dd>
                          <time dateTime={version.journal.originalEvidenceValidUntil}>
                            {version.journal.originalEvidenceValidUntil}
                          </time>{" "}
                          · Historical evidence
                        </dd>
                      </div>
                    </dl>
                    {version.journal.relations.length === 0 ? (
                      <p>No overlaps were recorded at publication.</p>
                    ) : (
                      <details>
                        <summary>
                          {version.journal.relations.length} recorded scope relationships
                        </summary>
                        <ul>
                          {version.journal.relations.map((relation, n) => (
                            <li key={n}>
                              {relation.relation === "IncomingSelectorPreferred"
                                ? "This version's selector was preferred"
                                : relation.relation === "ExistingSelectorPreferred"
                                  ? "The previous version's selector was preferred"
                                  : "Equal priority overlap was recorded"}{" "}
                              against version record{" "}
                              {current.view.versions.findIndex(
                                (v) => v.versionReference === relation.previousVersionReference,
                              ) + 1}
                              .
                              <p>
                                {relation.storeReference === null
                                  ? "All matching Stores"
                                  : relation.storeReference === storeReference
                                    ? "Selected Store"
                                    : "Another Store in this Brand"}{" "}
                                · Channels: {relation.channelCodes.join(", ") || "All"} · Order
                                types: {relation.orderTypeCodes.join(", ") || "All"}
                              </p>
                              <p>
                                <time dateTime={relation.effectiveFrom}>
                                  {relation.effectiveFrom}
                                </time>{" "}
                                to{" "}
                                {relation.effectiveUntil === null ? (
                                  "No recorded end"
                                ) : (
                                  <time dateTime={relation.effectiveUntil}>
                                    {relation.effectiveUntil}
                                  </time>
                                )}
                              </p>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : (
        <StatePanel
          heading={copy[current.kind][0]}
          tone={current.kind === "Denied" || current.kind === "Invalid" ? "error" : "neutral"}
          status
        >
          <p>{copy[current.kind][1]}</p>
        </StatePanel>
      )}
      <StatePanel heading="Content editing and publication unavailable" tone="neutral">
        <p>
          Current reference validation and publication services must be available before editing,
          review or publication can proceed.
        </p>
      </StatePanel>
    </AppFrame>
  );
}
