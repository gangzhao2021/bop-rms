import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
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

/** WP-2423 slice 4.3: what each option costs on each product; another approver publishes. */
const copy: Record<OptionPriceErrorCode | "Loading", string> = {
  Loading: "Loading option prices…",
  PermissionDenied: "You do not have permission for this price action.",
  NotFound: "That option is no longer offered on the product. Refresh and check.",
  Conflict: "Prices changed since you opened the page. Refresh and check again.",
  ApprovalRequired:
    "A price you set yourself must be published by another person who may approve prices.",
  Invalid: "A price is not valid. Enter an amount such as 0.75, or 0 for no charge.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Option prices are unavailable.",
};
const key = (binding: string, option: string) => binding + ":" + option;

export function StoreOptionPricesPage({
  client = unavailableOptionPriceClient,
}: {
  readonly client?: OptionPriceClient;
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
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
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
        heading="Option prices"
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  const exponent = view.currency.minorUnitExponent;
  const money = (minor: string) => `${view.currency.code} ${moneyText(minor, exponent)}`;
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
    const command = pending !== null && pending.action === fresh.action ? pending : fresh;
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
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
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
      "Prices saved. They take effect when another person who may approve prices publishes them.",
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
      "Prices published. Customers pay them from now on.",
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
    <AppFrame title="Option prices" description="PRICE-OPTION-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">PRICE-OPTION-LIST · Brand</p>
          <h2>Option prices</h2>
          <p>
            What each option adds to a product's price, for every size, pickup and dine-in. Enter 0
            for no charge. A new price takes effect when another person who may approve prices
            publishes it. An option without a published price cannot be ordered. Source as of{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        <Link to="/app/commerce/option-sets">Options</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not done" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      {rows.length === 0 ? (
        <StatePanel heading="No options on products" status>
          <p>Add option sets to products on the product page first.</p>
        </StatePanel>
      ) : null}
      {missing.length > 0 ? (
        <StatePanel heading="Prices needed" tone="error" status>
          <p>
            {missing.length} option{missing.length === 1 ? "" : "s"} on products have no published
            price and cannot be ordered yet.
          </p>
        </StatePanel>
      ) : null}
      {view.permissions.mayApprove && publishable.length > 0 ? (
        <section className="detail-section" aria-labelledby="publish-prices">
          <h3 id="publish-prices">Waiting for approval</h3>
          <ul>
            {publishable.map(({ product, set, option }) => (
              <li key={key(set.bindingReference, option.optionReference)}>
                {product.name} · {set.name} · {option.name}:{" "}
                {option.priceMinor === null ? "no price" : money(option.priceMinor)} →{" "}
                {money(option.pending?.priceMinor ?? "0")}
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={publish}>
            {pending?.action === "Publish"
              ? "Retry publish"
              : `Publish ${publishable.length} price${publishable.length === 1 ? "" : "s"}`}
          </button>
        </section>
      ) : null}
      {view.permissions.mayEdit && shared.length > 0 ? (
        <section className="detail-section" aria-labelledby="price-everywhere">
          <h3 id="price-everywhere">Same price on every product</h3>
          <p>Fills the price below for each product that offers the option; review, then save.</p>
          <table>
            <thead>
              <tr>
                <th>Option</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {shared.map(([label, item]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td data-label="Price">
                    <input
                      aria-label={`Price of ${label} on every product`}
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
                <th>Option</th>
                <th>Price now</th>
                <th>Waiting for approval</th>
                <th>New price</th>
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
                        {option.offered ? "" : " (not offered)"}
                      </td>
                      <td data-label="Price now">
                        {option.priceMinor === null ? "No price" : money(option.priceMinor)}
                      </td>
                      <td data-label="Waiting for approval">
                        {option.pending === null
                          ? "—"
                          : money(option.pending.priceMinor) +
                            (option.pending.byViewer ? " (yours)" : "")}
                      </td>
                      <td data-label="New price">
                        {view.permissions.mayEdit ? (
                          <input
                            aria-label={`New price of ${label} on ${product.name}`}
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
              ? "Retry"
              : `Save ${toSave.length} price${toSave.length === 1 ? "" : "s"}`}
          </button>
        </>
      ) : null}
    </AppFrame>
  );
}
