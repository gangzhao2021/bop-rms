import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  ProductPageError,
  parseProductDetailView,
  parseProductListView,
  parseProductRouteReference,
  productCodeValid,
  productTypeText,
  suggestProductCode,
  taxClassText,
  unavailableProductClient,
  type ProductClient,
  type ProductCommand,
  type ProductDetail,
  type ProductDetailView,
  type ProductErrorCode,
  type ProductListView,
  type ProductTaxClass,
} from "./product-pages.js";

/** WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Products and their sizes (SKUs). */
const copy: Record<ProductErrorCode | "Loading", string> = {
  Loading: "Loading products…",
  PermissionDenied: "You do not have permission for this product action at Brand level.",
  NotFound: "This product does not exist for the Brand.",
  Conflict: "The product changed since you opened it. Refresh and check again.",
  CodeTaken: "Another product or size of the Brand already uses this code.",
  SizeInUse:
    "A size that has started selling cannot be removed: orders, prices and recipes refer to it.",
  TaxClassUnavailable:
    "This Store's current tax configuration does not cover the chosen tax class. Choose one it covers.",
  Lifecycle: "This step is not possible in the product's current state.",
  Invalid:
    "The product is not valid. A name, a code (capital letters, digits, hyphen), a tax class and at least one size with its own code and name are required; size names must differ.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Products are unavailable.",
};
const lifecycleText: Record<string, string> = {
  Draft: "Not selling yet",
  Active: "Selling",
  Suspended: "Paused",
  Discontinued: "Discontinued",
  Archived: "Archived",
};
type State<V> =
  { readonly kind: "Loading" | ProductErrorCode } | { readonly kind: "Found"; readonly view: V };
function useProductView<V>(
  client: ProductClient,
  productReference: string | null,
  parse: (value: unknown) => V,
) {
  const [state, setState] = useState<State<V>>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load(productReference)
      .then((value) => {
        if (active) setState({ kind: "Found", view: parse(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof ProductPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, productReference, parse, generation]);
  return { state, reload };
}
function Failure({ code }: { readonly code: ProductErrorCode | "Loading" }) {
  return (
    <StatePanel heading="Products" tone={code === "Loading" ? "neutral" : "error"} status>
      <p>{copy[code]}</p>
    </StatePanel>
  );
}
const taxLabel = (classes: readonly ProductTaxClass[], reference: string | null) => {
  if (reference === null) return "—";
  const choice = classes.find((item) => item.taxClassificationReference === reference);
  return choice ? taxClassText(choice) : "Not covered by this Store's tax configuration";
};

export function ProductListPage({
  client = unavailableProductClient,
}: {
  readonly client?: ProductClient;
}) {
  const { state } = useProductView(client, null, parseProductListView);
  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view: ProductListView = state.view;
  return (
    <AppFrame title="Products" description="CAT-PRODUCT-LIST">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">CAT-PRODUCT-LIST · Brand</p>
          <h2>Products</h2>
          <p>
            Products and their sizes are shared by every Store of the Brand. A size is what a
            customer orders; prices, menus and recipes refer to it. Source as of{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayCreate ? (
          <Link to="/app/commerce/products/new">New product</Link>
        ) : null}
      </header>
      {view.products.length === 0 ? (
        <StatePanel heading="No products yet" status>
          <p>Create a product for each item on your menu, with one size or several.</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Code</th>
              <th>Type</th>
              <th>Status</th>
              <th>Sizes selling</th>
              <th>Tax</th>
            </tr>
          </thead>
          <tbody>
            {view.products.map((product) => (
              <tr key={product.productReference}>
                <td>
                  <Link to={`/app/commerce/products/${product.productReference}/edit`}>
                    {product.name}
                  </Link>
                </td>
                <td>{product.internalCode}</td>
                <td>{productTypeText[product.productType] ?? product.productType}</td>
                <td>{lifecycleText[product.lifecycle] ?? product.lifecycle}</td>
                <td>
                  {product.activeSizes} of {product.sizes}
                </td>
                <td>{taxLabel(view.taxClasses, product.taxClassificationReference)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}

interface EditableSize {
  readonly key: string;
  readonly skuReference: string | null;
  readonly lifecycle: string;
  skuCode: string;
  name: string;
}
let sizeKey = 0;
const nextKey = () => "size-" + ++sizeKey;

export function ProductEditorPage({
  client = unavailableProductClient,
}: {
  readonly client?: ProductClient;
}) {
  const params = useParams();
  const creating = params.id === undefined || params.id === "new";
  const productReference = creating ? null : parseProductRouteReference(params.id);
  if (!creating && productReference === null) return <Failure code="NotFound" />;
  return (
    <ProductEditor
      key={productReference ?? "new"}
      client={client}
      productReference={productReference}
    />
  );
}

function ProductEditor({
  client,
  productReference,
}: {
  readonly client: ProductClient;
  readonly productReference: string | null;
}) {
  const navigate = useNavigate();
  const parse = productReference === null ? parseProductListView : parseProductDetailView;
  const { state, reload } = useProductView<ProductListView | ProductDetailView>(
    client,
    productReference,
    parse,
  );
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [productType, setProductType] = useState("NonAlcoholicBeverage");
  const [taxClass, setTaxClass] = useState("");
  const [sizes, setSizes] = useState<EditableSize[]>([
    { key: nextKey(), skuReference: null, lifecycle: "Draft", skuCode: "", name: "Regular" },
  ]);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [pending, setPending] = useState<ProductCommand | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The product a command returned, shown until a reload brings the same or a newer version.
  const [latest, setLatest] = useState<ProductDetail | null>(null);
  const shown = (view: ProductListView | ProductDetailView) =>
    view.screenId !== "CAT-PRODUCT-DETAIL"
      ? null
      : latest !== null && latest.aggregateVersion > view.product.aggregateVersion
        ? latest
        : view.product;

  useEffect(() => {
    if (state.kind !== "Found") return;
    const view = state.view;
    const current = shown(view);
    if (current !== null) {
      if (loadedVersion === current.aggregateVersion) return;
      setLoadedVersion(current.aggregateVersion);
      setName(current.name);
      setCode(current.internalCode);
      setProductType(current.productType);
      setTaxClass(current.taxClassificationReference ?? "");
      setSizes(
        current.sizes.map((size) => ({
          key: nextKey(),
          skuReference: size.skuReference,
          lifecycle: size.lifecycle,
          skuCode: size.skuCode,
          name: size.name,
        })),
      );
    } else if (taxClass === "" && view.taxClasses.length === 1) {
      setTaxClass(view.taxClasses[0]?.taxClassificationReference ?? "");
    }
  }, [state, latest, loadedVersion, taxClass]);

  if (state.kind !== "Found") return <Failure code={state.kind} />;
  const view = state.view;
  const product = shown(view);
  const mayEdit = product === null ? view.permissions.mayCreate : view.permissions.mayEdit;
  const sizeCodeFor = (sizeName: string) =>
    [suggestProductCode(code || name), suggestProductCode(sizeName)].filter(Boolean).join("-");
  const effectiveSizes = sizes.map((size) => ({
    ...size,
    skuCode: size.skuCode || (size.skuReference === null ? sizeCodeFor(size.name) : size.skuCode),
  }));
  const valid =
    name.trim().length > 0 &&
    productCodeValid(code || suggestProductCode(name)) &&
    taxClass !== "" &&
    effectiveSizes.length > 0 &&
    effectiveSizes.every((size) => size.name.trim() && productCodeValid(size.skuCode)) &&
    new Set(effectiveSizes.map((size) => size.name.trim().toLowerCase())).size ===
      effectiveSizes.length &&
    new Set(effectiveSizes.map((size) => size.skuCode.trim().toUpperCase())).size ===
      effectiveSizes.length;

  const send = async (command: ProductCommand) => {
    if (!client.command) return;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      const result = (await client.command(command)) as { product?: ProductDetail };
      setPending(null);
      if (command.action === "Create" && result.product?.productReference) {
        void navigate(`/app/commerce/products/${result.product.productReference}/edit`);
        return;
      }
      setMessage({
        tone: "neutral",
        text: command.action === "StartSelling" ? "Selling started." : "Saved.",
      });
      if (result.product) setLatest(result.product);
      reload();
    } catch (error) {
      const code = error instanceof ProductPageError ? error.code : "Unavailable";
      // Only an unconfirmed attempt is retried with the same operation; a refusal is final.
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
    } finally {
      setBusy(false);
    }
  };
  const sizeInputs = effectiveSizes.map((size) => ({
    skuReference: size.skuReference,
    skuCode: size.skuCode.trim().toUpperCase(),
    name: size.name.trim(),
  }));
  const save = () =>
    void send(
      pending && pending.action !== "StartSelling"
        ? pending
        : product === null
          ? {
              action: "Create",
              operationReference: newOperationReference(),
              internalCode: (code || suggestProductCode(name)).trim().toUpperCase(),
              productType,
              name: name.trim(),
              taxClassificationReference: taxClass,
              sizes: sizeInputs,
            }
          : {
              action: "SaveDraft",
              operationReference: newOperationReference(),
              productReference: product.productReference,
              expectedAggregateVersion: product.aggregateVersion,
              name: name.trim(),
              taxClassificationReference: taxClass,
              sizes: sizeInputs,
            },
    );
  const startSelling = () =>
    product &&
    void send(
      pending && pending.action === "StartSelling"
        ? pending
        : {
            action: "StartSelling",
            operationReference: newOperationReference(),
            productReference: product.productReference,
            expectedAggregateVersion: product.aggregateVersion,
          },
    );
  const notSelling =
    product !== null &&
    (product.lifecycle === "Draft" || product.sizes.some((size) => size.lifecycle === "Draft"));
  const changed =
    product === null ||
    name.trim() !== product.name ||
    taxClass !== (product.taxClassificationReference ?? "") ||
    sizes.length !== product.sizes.length ||
    sizes.some(
      (size, index) =>
        size.skuReference !== product.sizes[index]?.skuReference ||
        size.name.trim() !== product.sizes[index]?.name,
    );

  return (
    <AppFrame
      title={product ? product.name : "New product"}
      description={product ? "CAT-PRODUCT-EDIT" : "CAT-PRODUCT-CREATE"}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {product ? "CAT-PRODUCT-EDIT" : "CAT-PRODUCT-CREATE"} · Brand
          </p>
          <h2>{product ? product.name : "New product"}</h2>
          <p>
            {product
              ? `${lifecycleText[product.lifecycle] ?? product.lifecycle} · version ${product.aggregateVersion} · updated ${product.updatedAt}`
              : "Name the product, choose its tax class and list the sizes a customer can order."}
          </p>
          <p>
            Pilot: changes apply to the Brand's product directly, without a separate publication
            review; every change is recorded with its author.
          </p>
        </div>
        <Link to="/app/commerce/products">Back to products</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? "Not saved" : "Done"}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy && mayEdit && changed) save();
        }}
      >
        <fieldset disabled={!mayEdit || busy}>
          <legend>Product</legend>
          <label>
            Name
            <input
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Code
            <input
              value={codeTouched || product ? code : code || suggestProductCode(name)}
              maxLength={64}
              disabled={product !== null}
              aria-describedby="product-code-help"
              onChange={(event) => {
                setCodeTouched(true);
                setCode(event.target.value.toUpperCase());
              }}
            />
          </label>
          <p id="product-code-help">
            Capital letters, digits and hyphens; it cannot be changed after the product is created.
          </p>
          <label>
            Type
            <select
              value={productType}
              disabled={product !== null}
              onChange={(event) => setProductType(event.target.value)}
            >
              {view.productTypes.map((type) => (
                <option key={type} value={type}>
                  {productTypeText[type] ?? type}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tax class
            <select value={taxClass} required onChange={(event) => setTaxClass(event.target.value)}>
              <option value="">Choose…</option>
              {view.taxClasses.map((choice, index) => (
                <option
                  key={choice.taxClassificationReference}
                  value={choice.taxClassificationReference}
                >
                  {`Class ${index + 1} — ${taxClassText(choice)}`}
                </option>
              ))}
            </select>
          </label>
          {view.taxClasses.length === 0 ? (
            <p>This Store has no current tax configuration for sellable items.</p>
          ) : (
            <p>
              Classes and rates come from this Store's current tax configuration (internal test
              rates, not verified tax advice).
            </p>
          )}
        </fieldset>
        <fieldset disabled={!mayEdit || busy}>
          <legend>Sizes</legend>
          <table>
            <thead>
              <tr>
                <th>Size name</th>
                <th>Size code</th>
                <th>Status</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {effectiveSizes.map((size, index) => (
                <tr key={size.key}>
                  <td>
                    <input
                      aria-label={`Size ${index + 1} name`}
                      value={size.name}
                      maxLength={80}
                      onChange={(event) =>
                        setSizes((current) =>
                          current.map((item) =>
                            item.key === size.key ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Size ${index + 1} code`}
                      value={size.skuCode}
                      maxLength={64}
                      disabled={size.skuReference !== null}
                      onChange={(event) =>
                        setSizes((current) =>
                          current.map((item) =>
                            item.key === size.key
                              ? { ...item, skuCode: event.target.value.toUpperCase() }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>{lifecycleText[size.lifecycle] ?? size.lifecycle}</td>
                  <td>
                    {size.lifecycle === "Draft" && sizes.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSizes((current) => current.filter((item) => item.key !== size.key))
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sizes.length < 12 && (product === null || view.permissions.mayAddSize) ? (
            <button
              type="button"
              onClick={() =>
                setSizes((current) => [
                  ...current,
                  {
                    key: nextKey(),
                    skuReference: null,
                    lifecycle: "Draft",
                    skuCode: "",
                    name: "",
                  },
                ])
              }
            >
              Add size
            </button>
          ) : null}
        </fieldset>
        {mayEdit ? (
          <button type="submit" disabled={!valid || busy || !changed}>
            {pending && pending.action !== "StartSelling"
              ? "Retry"
              : product
                ? "Save changes"
                : "Create product"}
          </button>
        ) : null}
      </form>
      {product && notSelling && view.permissions.mayStartSelling ? (
        <section className="detail-section" aria-labelledby="start-selling">
          <h3 id="start-selling">Start selling</h3>
          <p>
            Makes the product and every size not yet selling available to price and to place on
            menus. Customers see it once it is on a published menu with a price.
          </p>
          <button type="button" disabled={busy || changed} onClick={startSelling}>
            {pending && pending.action === "StartSelling" ? "Retry start selling" : "Start selling"}
          </button>
          {changed ? <p>Save your changes first.</p> : null}
        </section>
      ) : null}
    </AppFrame>
  );
}
