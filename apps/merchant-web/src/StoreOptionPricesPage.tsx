import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { newOperationReference } from "./operation-reference.js";
import { FULL_SIGN_IN_REQUIRED, FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { SoleOperatorSelfApproval } from "./SoleOperatorSelfApproval.js";
import {
  OptionPricePageError,
  moneyText,
  parseMoney,
  parseOptionPriceView,
  unavailableOptionPriceClient,
  type OptionPriceClient,
  type OptionPriceCommand,
  type OptionPriceErrorCode,
  type OptionPriceRow,
  type OptionPriceView,
} from "./store-option-prices-page.js";

/** WP-2423 slice 4.3: what each option costs on each product; another approver publishes, or the
 * author alone as sole operator (DEC-SOLE-OPERATOR-APPROVAL). */
const copy: Record<OptionPriceErrorCode | "Loading", string> = {
  Loading: t("Loading option prices…"),
  PermissionDenied: t("You do not have permission for this price action."),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  NotFound: t("That option is no longer offered on the product. Refresh and check."),
  Conflict: t("Prices changed since you opened the page. Refresh and check again."),
  ApprovalRequired: t(
    "A price you set yourself must be published by another person who may approve prices.",
  ),
  Invalid: t("A price is not valid. Enter an amount such as 0.75, or 0 for no charge."),
  SoleOperatorNotInEffect: t(
    "Someone else now holds price approval, so they must publish these prices. Refresh to see who.",
  ),
  NeedsReverification: t("Confirm it is you with your authenticator code, then publish again."),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Option prices are unavailable."),
};
const key = (binding: string, option: string) => binding + ":" + option;
/** "$" for CAD in en-CA (the amount itself stays an exact decimal string, never a float). */
const currencySymbol = (code: string) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: code })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? code + " ";

export function StoreOptionPricesPage({
  client = unavailableOptionPriceClient,
  csrf,
  fetcher,
}: {
  readonly client?: OptionPriceClient;
  /** For confirming a PIN sign-in when a change is refused until then. */
  readonly csrf?: string | undefined;
  /** For the authenticator check (tests). */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [state, setState] = useState<
    | { readonly kind: "Loading" | OptionPriceErrorCode }
    | { readonly kind: "Found"; readonly view: OptionPriceView }
  >({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [everywhere, setEverywhere] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<OptionPriceCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "error" | "neutral";
    text: string;
    fullSignIn?: boolean;
  } | null>(null);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseOptionPriceView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof OptionPricePageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, generation]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading={state.kind === "PermissionDenied" ? noAccessHeading : t("Option prices")}
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{state.kind === "PermissionDenied" ? pageAccessDeniedText : copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const exponent = view.currency.minorUnitExponent;
  const money = (minor: string) => currencySymbol(view.currency.code) + moneyText(minor, exponent);
  const rows = view.products.flatMap((product) =>
    product.optionSets.flatMap((set) => set.options.map((option) => ({ product, set, option }))),
  );
  const shown = (option: OptionPriceRow) => option.pending?.priceMinor ?? option.priceMinor;
  const changes = rows.flatMap(({ set, option }) => {
    const text = edits[key(set.bindingReference, option.optionReference)];
    if (text === undefined || text.trim() === "") return [];
    const minor = parseMoney(text, exponent);
    return [{ set, option, minor }];
  });
  const invalid = changes.some((change) => change.minor === null);
  const toSave = changes.filter(
    (change) => change.minor !== null && change.minor !== shown(change.option),
  );
  const publishable = rows.filter(
    ({ option }) => option.pending !== null && !option.pending.byViewer,
  );
  // The viewer's own waiting prices: another approver publishes them, or the viewer alone when
  // sole operator is in effect for them.
  const ownWaiting = rows.filter(({ option }) => option.pending?.byViewer === true);
  const soleOperatorOn = view.soleOperator?.status === "Effective";
  const missing = rows.filter(({ option }) => option.offered && option.priceMinor === null);
  // Option names across products, for "set the same price on every product".
  const shared = [
    ...new Map(
      rows.map(({ set, option }) => [
        set.name + " · " + option.name,
        { set: set.name, option: option.name },
      ]),
    ).entries(),
  ];

  const send = async (fresh: OptionPriceCommand, done: string) => {
    if (!client.command) return;
    const mode = (value: OptionPriceCommand) =>
      value.action === "Publish" ? (value.approvalMode ?? null) : null;
    const command =
      pending !== null && pending.action === fresh.action && mode(pending) === mode(fresh)
        ? pending
        : fresh;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      await client.command(command);
      setPending(null);
      setEdits({});
      // Show the confirmed result together with the prices it produced.
      try {
        setState({ kind: "Found", view: parseOptionPriceView(await client.load()) });
      } catch {
        reload();
      }
      setMessage({ tone: "neutral", text: done });
    } catch (error) {
      const code = error instanceof OptionPricePageError ? error.code : "Unavailable";
      // Offline, unavailable or a PIN sign-in to confirm: retry sends the same request again.
      if (code !== "Offline" && code !== "Unavailable" && code !== FULL_SIGN_IN_REQUIRED)
        setPending(null);
      setMessage({ tone: "error", text: copy[code], fullSignIn: code === FULL_SIGN_IN_REQUIRED });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    void send(
      {
        action: "SetPrices",
        operationReference: newOperationReference(),
        prices: toSave.map(({ set, option, minor }) => ({
          bindingReference: set.bindingReference,
          optionReference: option.optionReference,
          amountMinor: minor ?? "0",
          expectedAggregateVersion: option.aggregateVersion,
          replacesPending: option.pending !== null,
        })),
      },
      soleOperatorOn
        ? t("Prices saved. They take effect when you publish them below.")
        : t(
            "Prices saved. They take effect when another person who may approve prices publishes them.",
          ),
    );
  const publish = () =>
    void send(
      {
        action: "Publish",
        operationReference: newOperationReference(),
        rules: publishable.map(({ option }) => ({
          ruleReference: option.ruleReference ?? "",
          expectedAggregateVersion: option.aggregateVersion ?? 1,
        })),
      },
      t("Prices published. Customers pay them from now on."),
    );
  const publishOwn = () =>
    void send(
      {
        action: "Publish",
        operationReference: newOperationReference(),
        rules: ownWaiting.map(({ option }) => ({
          ruleReference: option.ruleReference ?? "",
          expectedAggregateVersion: option.aggregateVersion ?? 1,
        })),
        approvalMode: "SoleOperator",
      },
      t("Prices published, approved by you alone. Customers pay them from now on."),
    );
  const applyEverywhere = (setName: string, optionName: string, text: string) => {
    setEverywhere((current) => ({ ...current, [setName + " · " + optionName]: text }));
    setEdits((current) => {
      const next = { ...current };
      for (const { set, option } of rows)
        if (set.name === setName && option.name === optionName)
          next[key(set.bindingReference, option.optionReference)] = text;
      return next;
    });
  };

  return (
    <AppFrame title={t("Option prices")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Option prices · Brand")}</p>
          <h2>{t("Option prices")}</h2>
          <p>
            {t(
              "What each option adds to a product's price, for every size, pickup and dine-in. Enter 0 for no charge. {value} An option without a published price cannot be ordered. Source as of",
              {
                value: soleOperatorOn
                  ? t(
                      "You run this business alone (sole operator), so you may publish your own new prices after confirming it is you.",
                    )
                  : t(
                      "A new price takes effect when another person who may approve prices publishes it.",
                    ),
              },
            )}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/option-sets">{t("Options")}</Link>
      </header>
      {message?.fullSignIn === true && csrf !== undefined ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not done") : t("Done")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {rows.length === 0 ? (
        <StatePanel heading={t("No options on products")} status>
          <p>{t("Add option sets to products on the product page first.")}</p>
        </StatePanel>
      ) : null}
      {missing.length > 0 ? (
        <StatePanel heading={t("Prices needed")} tone="error" status>
          <p>
            {t(
              "{length} option{value} on products have no published price and cannot be ordered yet.",
              { length: missing.length, value: missing.length === 1 ? "" : "s" },
            )}
          </p>
        </StatePanel>
      ) : null}
      {view.permissions.mayApprove && publishable.length > 0 ? (
        <section className="detail-section" aria-labelledby="publish-prices">
          <h3 id="publish-prices">{t("Waiting for approval")}</h3>
          <ul>
            {publishable.map(({ product, set, option }) => (
              <li key={key(set.bindingReference, option.optionReference)}>
                {product.name} · {set.name} · {option.name}:{" "}
                {option.priceMinor === null ? t("no price") : money(option.priceMinor)} →{" "}
                {money(option.pending?.priceMinor ?? "0")}
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={publish}>
            {pending?.action === "Publish" && pending.approvalMode === undefined
              ? t("Retry publish")
              : t("Publish {length} price{value}", {
                  length: publishable.length,
                  value: publishable.length === 1 ? "" : "s",
                })}
          </button>
        </section>
      ) : null}
      {view.permissions.mayApprove && ownWaiting.length > 0 ? (
        <section className="detail-section" aria-labelledby="publish-own-prices">
          <h3 id="publish-own-prices">{t("Your prices waiting for approval")}</h3>
          <SoleOperatorSelfApproval
            gate={view.soleOperator}
            csrf={csrf}
            fetcher={fetcher}
            what={t("these prices")}
            permissionName={t("price approval")}
            busy={busy}
            actionLabel={
              pending?.action === "Publish" && pending.approvalMode === "SoleOperator"
                ? t("Retry publish")
                : `Publish ${ownWaiting.length} price${ownWaiting.length === 1 ? "" : "s"} on my own`
            }
            summary={
              <ul>
                {ownWaiting.map(({ product, set, option }) => (
                  <li key={key(set.bindingReference, option.optionReference)}>
                    {product.name} · {set.name} · {option.name}:{" "}
                    {option.priceMinor === null ? t("no price") : money(option.priceMinor)} →{" "}
                    {money(option.pending?.priceMinor ?? "0")}
                  </li>
                ))}
              </ul>
            }
            onApprove={publishOwn}
          />
        </section>
      ) : null}
      {view.permissions.mayEdit && shared.length > 0 ? (
        <section className="detail-section" aria-labelledby="price-everywhere">
          <h3 id="price-everywhere">{t("Same price on every product")}</h3>
          <p>
            {t("Fills the price below for each product that offers the option; review, then save.")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("Option")}</th>
                <th>{t("Price")}</th>
              </tr>
            </thead>
            <tbody>
              {shared.map(([label, item]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td data-label={t("Price")}>
                    <input
                      aria-label={t("Price of {label} on every product", { label: label })}
                      inputMode="decimal"
                      value={everywhere[label] ?? ""}
                      onChange={(event) =>
                        applyEverywhere(item.set, item.option, event.target.value)
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {view.products.map((product) => (
        <section key={product.productReference} className="detail-section">
          <h3>{product.name}</h3>
          <table>
            <thead>
              <tr>
                <th>{t("Option")}</th>
                <th>{t("Price now")}</th>
                <th>{t("Waiting for approval")}</th>
                <th>{t("New price")}</th>
              </tr>
            </thead>
            <tbody>
              {product.optionSets.flatMap((set) =>
                set.options.map((option) => {
                  const id = key(set.bindingReference, option.optionReference);
                  const label = `${set.name} · ${option.name}`;
                  return (
                    <tr key={id}>
                      <td>
                        {label}
                        {option.offered ? "" : t(" (not offered)")}
                      </td>
                      <td data-label={t("Price now")}>
                        {option.priceMinor === null ? t("No price") : money(option.priceMinor)}
                      </td>
                      <td data-label={t("Waiting for approval")}>
                        {option.pending === null
                          ? "—"
                          : money(option.pending.priceMinor) +
                            (option.pending.byViewer ? " (yours)" : "")}
                      </td>
                      <td data-label={t("New price")}>
                        {view.permissions.mayEdit ? (
                          <input
                            aria-label={t("New price of {label} on {name}", {
                              label: label,
                              name: product.name,
                            })}
                            inputMode="decimal"
                            placeholder={
                              shown(option) === null
                                ? "0.00"
                                : moneyText(shown(option) ?? "0", exponent)
                            }
                            value={edits[id] ?? ""}
                            onChange={(event) =>
                              setEdits((current) => ({ ...current, [id]: event.target.value }))
                            }
                          />
                        ) : null}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </section>
      ))}
      {view.permissions.mayEdit && rows.length > 0 ? (
        <>
          {invalid ? <p>{copy.Invalid}</p> : null}
          <button type="button" disabled={busy || invalid || toSave.length === 0} onClick={save}>
            {pending?.action === "SetPrices"
              ? t("Retry")
              : t("Save {length} price{value}", {
                  length: toSave.length,
                  value: toSave.length === 1 ? "" : "s",
                })}
          </button>
        </>
      ) : null}
    </AppFrame>
  );
}
