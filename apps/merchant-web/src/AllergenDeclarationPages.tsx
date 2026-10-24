import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime, StoreDate } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import {
  AllergenPageError,
  allergenName,
  declarationSummary,
  oneYearAfter,
  parseAllergenItemView,
  parseAllergenListView,
  parseAllergenRouteReference,
  unavailableAllergenClient,
  type AllergenClassification,
  type AllergenClient,
  type AllergenCommand,
  type AllergenErrorCode,
  type AllergenItemView,
  type AllergenListView,
  type DeclarationStatus,
} from "./allergen-declaration-pages.js";

/** WP-2423 / DEC-ALLERGEN-DECLARATIONS: Brand allergen registry and ingredient declarations. */
const copy: Record<AllergenErrorCode | "Loading", string> = {
  Loading: t("Loading allergens…"),
  PermissionDenied: t("You do not have permission for this allergen action at Brand level."),
  NotFound: t("This ingredient does not exist or is not active."),
  Conflict: t(
    "The ingredient or the allergen list changed since you opened it. Refresh and declare again.",
  ),
  RegistryMissing: t("Approve the Brand allergen list before declaring ingredients."),
  Invalid: t(
    "The declaration is not valid. Choose where it comes from, name the document and give a future valid-until date.",
  ),
  ApprovalRequired: t(
    "You recorded this list: someone else holding allergen list approval approves it.",
  ),
  SoleOperatorNotInEffect: t(
    "Someone else now holds allergen list approval, so they must approve this list. Refresh to see who.",
  ),
  NeedsReverification: t("Confirm it is you with your authenticator code, then approve again."),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Allergens are unavailable."),
};
const statusText: Record<DeclarationStatus, string> = {
  Current: "Declared",
  ExpiringSoon: t("Declared — expires within 30 days"),
  ItemChanged: t("Ingredient changed — declare again"),
  RegistryChanged: t("Allergen list changed — declare again"),
  Missing: t("Not declared"),
};
const sourceText: Record<string, string> = {
  SupplierSpecification: t("Supplier specification"),
  ProductLabel: t("Product label"),
  ManufacturerStatement: t("Manufacturer statement"),
};
type State<V> =
  { readonly kind: "Loading" | AllergenErrorCode } | { readonly kind: "Found"; readonly view: V };
function useAllergenView<V>(
  client: AllergenClient,
  itemReference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(itemReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof AllergenPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, itemReference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { readonly code: AllergenErrorCode | "Loading" }) {
  return (
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Allergens")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
    </StatePanel>
  );
}
/** One command at a time; an unconfirmed attempt is retried with the same operation. */
function useCommand(client: AllergenClient, onDone: () => void) {
  const [pending, setPending] = useState<AllergenCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  const send = async (fresh: AllergenCommand, done: string) => {
    if (!client.command) return;
    const command = pending !== null && pending.action === fresh.action ? pending : fresh;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      await client.command(command);
      setPending(null);
      setMessage({ tone: "neutral", text: done });
      onDone();
    } catch (error) {
      const code = error instanceof AllergenPageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
    } finally {
      setBusy(false);
    }
  };
  return { send, busy, pending, message };
}

export function AllergenListPage({
  client = unavailableAllergenClient,
  csrf,
}: {
  readonly client?: AllergenClient;
  /** For the second-factor check of a sole operator's own approval. */
  readonly csrf?: string;
}) {
  const { state, reload } = useAllergenView(client, null, parseAllergenListView);
  const { send, busy, pending, message } = useCommand(client, reload);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: AllergenListView = state.view;
  const missing = view.items.filter((item) => item.status !== "Current").length;
  return (
    <AppFrame title={t("Allergens")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Allergens · Brand")}</p>
          <h2>{t("Allergens")}</h2>
          <p>
            {t(
              "Every ingredient used in a recipe needs an allergen declaration taken from its supplier specification, label or manufacturer statement. Recipes carry these declarations; a recipe's food safety review approves them, and menus disclose them to customers. Source as of",
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not done") : t("Done")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      <section className="detail-section" aria-labelledby="registry">
        <h3 id="registry">{t("Allergen list")}</h3>
        {view.registry ? (
          <>
            <p>
              {t("{jurisdictionCode} list approved", {
                jurisdictionCode: view.registry.jurisdictionCode,
              })}{" "}
              <StoreDate value={view.registry.reviewedAt} />:{" "}
              {view.registry.entries
                .map((entry) => allergenName(view.registry, entry.allergenReference, view.locale))
                .join(", ")}
            </p>
            <p>{view.registryTemplate.policyDocument}</p>
          </>
        ) : (
          <>
            <p>
              {t(
                "No allergen list is approved for the Brand. Proposed list ({jurisdictionCode}): {value}.",
                {
                  jurisdictionCode: view.registryTemplate.jurisdictionCode,
                  value: view.registryTemplate.allergens.map((a) => a.name).join(", "),
                },
              )}
            </p>
            <p>{view.registryTemplate.policyDocument}</p>
            {/* WP-2423 Q19: one person records the list, another approves it. */}
            {!view.permissions.mayManageRegistry ? (
              <p>{t("Someone holding allergen list approval must record and approve it.")}</p>
            ) : view.registryProposal === null ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void send(
                    {
                      action: "RecordRegistry",
                      operationReference: newOperationReference(),
                      template: "CA_PRIORITY_TEST",
                    },
                    t(
                      "Allergen list recorded. Someone else holding allergen list approval approves it.",
                    ),
                  )
                }
              >
                {pending ? t("Retry") : t("Record this allergen list for approval")}
              </button>
            ) : view.registryProposal.recordedByYou ? (
              <SoleOperatorSelfApproval
                gate={view.soleOperator}
                csrf={csrf}
                what={t("this allergen list")}
                permissionName={t("allergen list approval")}
                busy={busy}
                actionLabel={pending ? t("Retry") : t("Approve this list on my own")}
                summary={
                  <p>
                    {t("{jurisdictionCode} list of {length} allergens, recorded by you", {
                      jurisdictionCode: view.registryTemplate.jurisdictionCode,
                      length: view.registryTemplate.allergens.length,
                    })}{" "}
                    <SourceTime instant={view.registryProposal.recordedAt} />.
                  </p>
                }
                onApprove={() =>
                  void send(
                    {
                      action: "ApproveRegistry",
                      operationReference: newOperationReference(),
                      proposalReference: view.registryProposal?.proposalReference ?? "",
                      approvalMode: "SoleOperator",
                    },
                    t("Allergen list approved."),
                  )
                }
              />
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void send(
                    {
                      action: "ApproveRegistry",
                      operationReference: newOperationReference(),
                      proposalReference: view.registryProposal?.proposalReference ?? "",
                    },
                    t("Allergen list approved."),
                  )
                }
              >
                {pending ? t("Retry") : t("Approve the recorded allergen list")}
              </button>
            )}
          </>
        )}
      </section>
      <section className="detail-section" aria-labelledby="ingredients">
        <h3 id="ingredients">{t("Ingredients")}</h3>
        <p>
          {missing === 0
            ? t("Every active ingredient has a current declaration.")
            : t("{missing} of {length} active ingredients need a declaration.", {
                missing: missing,
                length: view.items.length,
              })}
        </p>
        <table>
          <thead>
            <tr>
              <th>{t("Ingredient")}</th>
              <th>{t("Status")}</th>
              <th>{t("Declared allergens")}</th>
              <th>{t("Valid through")}</th>
            </tr>
          </thead>
          <tbody>
            {view.items.map((item) => (
              <tr key={item.itemReference} data-status={item.status}>
                <td>
                  <Link to={`/app/compliance/allergens/${item.itemReference}`}>{item.name}</Link>
                </td>
                <td>{statusText[item.status]}</td>
                <td>
                  {item.declaration
                    ? declarationSummary(view.registry, item.declaration, view.locale)
                    : "—"}
                </td>
                <td>
                  {item.declaration ? (
                    <StoreDate
                      value={item.declaration.validThrough ?? item.declaration.validUntil}
                    />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppFrame>
  );
}

export function AllergenItemPage({
  client = unavailableAllergenClient,
}: {
  readonly client?: AllergenClient;
}) {
  const params = useParams();
  const reference = parseAllergenRouteReference(params.id);
  if (reference === null) return <Failure code="NotFound" />;
  return <AllergenItem key={reference} client={client} itemReference={reference} />;
}

type Choice = "Absent" | AllergenClassification;
function AllergenItem({
  client,
  itemReference,
}: {
  readonly client: AllergenClient;
  readonly itemReference: string;
}) {
  const { state, reload } = useAllergenView(client, itemReference, parseAllergenItemView);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [sourceKind, setSourceKind] = useState("SupplierSpecification");
  const [documentReference, setDocumentReference] = useState("");
  const [note, setNote] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const { send, busy, pending, message } = useCommand(client, () => {
    setLoadedFor(null);
    reload();
  });
  useEffect(() => {
    if (state.kind !== "Found") return;
    const view = state.view;
    const key = view.item.declaration?.evidenceReference ?? "none";
    if (loadedFor === key) return;
    setLoadedFor(key);
    const previous = view.item.declaration;
    setChoices(
      Object.fromEntries(
        (view.registry?.entries ?? []).map((entry) => [
          entry.allergenReference,
          previous?.allergens.find((a) => a.allergenReference === entry.allergenReference)
            ?.classification ?? "Absent",
        ]),
      ),
    );
    setSourceKind(previous?.sourceKind ?? "SupplierSpecification");
    setDocumentReference(previous?.documentReference ?? "");
    setNote(previous?.note ?? "");
    setValidUntil(oneYearAfter(view.sourceAsOf));
    setConfirmed(false);
  }, [state, loadedFor]);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: AllergenItemView = state.view;
  const item = view.item;
  const registry = view.registry;
  const valid =
    registry !== null &&
    documentReference.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/u.test(validUntil) &&
    validUntil > view.sourceAsOf.slice(0, 10) &&
    confirmed;
  return (
    <AppFrame title={item.name} description={t("Allergens")}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Allergens · Ingredient")}</p>
          <h2>{item.name}</h2>
          <p>
            {statusText[item.status]}
            {item.declaration
              ? " · " + declarationSummary(registry, item.declaration, view.locale)
              : ""}
          </p>
        </div>
        <Link to="/app/compliance/allergens">{t("Back to allergens")}</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not recorded") : t("Recorded")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {registry === null ? (
        <StatePanel heading={t("No allergen list")} status>
          <p>{copy.RegistryMissing}</p>
        </StatePanel>
      ) : view.permissions.mayDeclare ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy) return;
            void send(
              {
                action: "Declare",
                operationReference: newOperationReference(),
                itemReference: item.itemReference,
                expectedItemVersion: item.itemVersionReference,
                allergens: Object.entries(choices)
                  .filter(([, choice]) => choice !== "Absent")
                  .map(([allergenReference, choice]) => ({
                    allergenReference,
                    classification: choice as AllergenClassification,
                  })),
                sourceKind,
                documentReference: documentReference.trim(),
                note: note.trim() || null,
                validUntilDate: validUntil,
              },
              t(
                "Declaration recorded. Recipes using this ingredient must be saved again to carry it.",
              ),
            );
          }}
        >
          <fieldset disabled={busy}>
            <legend>{t("Declaration")}</legend>
            <table>
              <thead>
                <tr>
                  <th>{t("Allergen")}</th>
                  <th>{t("Not present")}</th>
                  <th>{t("Contains")}</th>
                  <th>{t("May contain (cross-contact)")}</th>
                </tr>
              </thead>
              <tbody>
                {registry.entries.map((entry) => {
                  const label = allergenName(registry, entry.allergenReference, view.locale);
                  return (
                    <tr key={entry.allergenReference}>
                      <td>{label}</td>
                      {(["Absent", "Contains", "CrossContactPossible"] as const).map((choice) => (
                        <td key={choice}>
                          <input
                            type="radio"
                            name={"allergen-" + entry.allergenReference}
                            aria-label={`${label}: ${
                              choice === "Absent"
                                ? "not present"
                                : choice === "Contains"
                                  ? "contains"
                                  : "may contain"
                            }`}
                            checked={(choices[entry.allergenReference] ?? "Absent") === choice}
                            onChange={() =>
                              setChoices((current) => ({
                                ...current,
                                [entry.allergenReference]: choice,
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <label>
              {t("Based on")}
              <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value)}>
                {view.sources.map((source) => (
                  <option key={source} value={source}>
                    {sourceText[source] ?? source}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Document (supplier, product and document date or number)")}
              <input
                value={documentReference}
                maxLength={200}
                onChange={(event) => setDocumentReference(event.target.value)}
              />
            </label>
            <label>
              {t("Note (optional)")}
              <input
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <label>
              {t("Valid until")}
              <input
                type="date"
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t("I checked every allergen against the document named above.")}
            </label>
          </fieldset>
          <button type="submit" disabled={!valid || busy}>
            {pending ? t("Retry") : t("Record declaration")}
          </button>
        </form>
      ) : (
        <p>{t("You may view declarations but not record them.")}</p>
      )}
      <section className="detail-section" aria-labelledby="history">
        <h3 id="history">{t("Declarations")}</h3>
        {view.history.length === 0 ? (
          <p>{t("None yet.")}</p>
        ) : (
          <ul>
            {view.history.map((d) => (
              <li key={d.evidenceReference}>
                <StoreDate value={d.reviewedAt} />
                {t(": {registry} · {value}: {documentReference} · valid through", {
                  registry: declarationSummary(registry, d, view.locale),
                  value: sourceText[d.sourceKind] ?? d.sourceKind,
                  documentReference: d.documentReference,
                })}{" "}
                <StoreDate value={d.validThrough ?? d.validUntil} />
                {d.declaredBy === view.viewer ? t(" · by you") : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppFrame>
  );
}
