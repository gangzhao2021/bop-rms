import { PageIntro } from "./PageIntro.js";
import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useId, useRef, useState, type Ref } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import {
  ProductPageError,
  ProductPhotoError,
  parseProductDetailView,
  photoContentTypes,
  photoFileProblem,
  photoRetryable,
  presentationChanged,
  presentationDraftFrom,
  presentationInput,
  presentationLimits,
  presentationProblems,
  type PresentationDraft,
  type PresentationProblem,
  type ProductPhotoErrorCode,
  type ProductPresentation,
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
  type ProductOptionSetChoice,
  type ProductOptionSetInput,
  type ProductTaxClass,
} from "./product-pages.js";

/** WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Products and their sizes (SKUs). */
const copy: Record<ProductErrorCode | "Loading", string> = {
  Loading: t("Loading products…"),
  PermissionDenied: t("You do not have permission for this product action at Brand level."),
  NotFound: t("This product does not exist for the Brand."),
  Conflict: t("The product changed since you opened it. Refresh and check again."),
  CodeTaken: t("Another product or size of the Brand already uses this code."),
  SizeInUse: t(
    "A size that has started selling cannot be removed: orders, prices and recipes refer to it.",
  ),
  TaxClassUnavailable: t(
    "This Store's current tax configuration does not cover the chosen tax class. Choose one it covers.",
  ),
  Lifecycle: t("This step is not possible in the product's current state."),
  Invalid: t(
    "The product is not valid. A name, a code (capital letters, digits, hyphen), a tax class and at least one size with its own code and name are required; size names must differ.",
  ),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Products are unavailable."),
};
const lifecycleText: Record<string, string> = {
  Draft: t("Not selling yet"),
  Active: t("Selling"),
  Suspended: t("Paused"),
  Discontinued: t("Discontinued"),
  Archived: t("Archived"),
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
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Products")}
      tone={code === "Loading" ? "neutral" : "error"}
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
    </StatePanel>
  );
}
const taxLabel = (classes: readonly ProductTaxClass[], reference: string | null) => {
  if (reference === null) return "—";
  const choice = classes.find((item) => item.taxClassificationReference === reference);
  return choice ? taxClassText(choice) : t("Not covered by this Store's tax configuration");
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
    <AppFrame title={t("Products")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Products · Brand")}</p>
          <h2>{t("Products")}</h2>
          <PageIntro
            summary={t("Shared by every Store of the Brand.")}
            aside={
              <>
                {t("Updated")} <SourceTime instant={view.sourceAsOf} />
              </>
            }
          >
            <p>
              {t(
                "Products and their sizes are shared by every Store of the Brand. A size is what a customer orders; prices, menus and recipes refer to it.",
              )}
            </p>
          </PageIntro>
        </div>
        {view.permissions.mayCreate ? (
          <Link className="primary-action-link" to="/app/commerce/products/new">
            {t("New product")}
          </Link>
        ) : null}
      </header>
      {view.products.length === 0 ? (
        <StatePanel heading={t("No products yet")} status>
          <p>{t("Create a product for each item on your menu, with one size or several.")}</p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Product")}</th>
              <th>{t("Code")}</th>
              <th>{t("Type")}</th>
              <th>{t("Status")}</th>
              <th>{t("Sizes selling")}</th>
              <th>{t("Tax")}</th>
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
                <td className="product-code">{product.internalCode}</td>
                <td>{productTypeText[product.productType] ?? product.productType}</td>
                <td>{lifecycleText[product.lifecycle] ?? product.lifecycle}</td>
                <td>
                  {t("{activeSizes} of {sizes}", {
                    activeSizes: product.activeSizes,
                    sizes: product.sizes,
                  })}
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
  /** Owner 2026-10-23: the Simplified Chinese name customers see ("" when none). */
  nameZh: string;
}
let sizeKey = 0;
/** Option sets in order, each with its enabled options in any order. */
const optionSetsKey = (sets: readonly ProductOptionSetInput[]) =>
  JSON.stringify(
    sets.map((set) => [set.optionSetReference, [...set.enabledOptionReferences].sort()]),
  );
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
  const [nameZh, setNameZh] = useState("");
  const [code, setCode] = useState("");
  const [codeTouched, setCodeTouched] = useState(false);
  const [productType, setProductType] = useState("NonAlcoholicBeverage");
  const [taxClass, setTaxClass] = useState("");
  const [sizes, setSizes] = useState<EditableSize[]>([
    {
      key: nextKey(),
      skuReference: null,
      lifecycle: "Draft",
      skuCode: "",
      name: "Regular",
      nameZh: "",
    },
  ]);
  const [optionSets, setOptionSets] = useState<ProductOptionSetInput[]>([]);
  const [presentation, setPresentation] = useState<PresentationDraft>(emptyPresentation);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [showPresentationProblems, setShowPresentationProblems] = useState(false);
  const altTextRef = useRef<HTMLInputElement>(null);
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
      setNameZh(current.nameZh ?? "");
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
          nameZh: size.nameZh ?? "",
        })),
      );
      setOptionSets([...(current.optionSets ?? [])]);
      if (current.presentation) setPresentation(presentationDraftFrom(current.presentation));
      setShowPresentationProblems(false);
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
        text: command.action === "StartSelling" ? t("Selling started.") : t("Saved."),
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
    nameZh: size.nameZh.trim(),
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
              nameZh: nameZh.trim(),
              taxClassificationReference: taxClass,
              sizes: sizeInputs,
            }
          : {
              action: "SaveDraft",
              operationReference: newOperationReference(),
              productReference: product.productReference,
              expectedAggregateVersion: product.aggregateVersion,
              name: name.trim(),
              nameZh: nameZh.trim(),
              taxClassificationReference: taxClass,
              sizes: sizeInputs,
              ...(optionChoices === null ? {} : { optionSets }),
              ...(product.presentation ? { presentation: presentationInput(presentation) } : {}),
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
  const optionChoices =
    view.screenId === "CAT-PRODUCT-DETAIL" ? (view.optionSetChoices ?? null) : null;
  const optionSetsChanged =
    product !== null &&
    optionChoices !== null &&
    optionSetsKey(optionSets) !== optionSetsKey(product.optionSets ?? []);
  const notSelling =
    product !== null &&
    (product.lifecycle === "Draft" || product.sizes.some((size) => size.lifecycle === "Draft"));
  const changed =
    product === null ||
    name.trim() !== product.name ||
    nameZh.trim() !== (product.nameZh ?? "") ||
    taxClass !== (product.taxClassificationReference ?? "") ||
    sizes.length !== product.sizes.length ||
    sizes.some(
      (size, index) =>
        size.skuReference !== product.sizes[index]?.skuReference ||
        size.name.trim() !== product.sizes[index]?.name ||
        size.nameZh.trim() !== (product.sizes[index]?.nameZh ?? ""),
    ) ||
    optionSetsChanged ||
    (product.presentation !== undefined && presentationChanged(presentation, product.presentation));
  const problems = product?.presentation ? presentationProblems(presentation) : {};
  const presentationBlocked =
    problems.description !== undefined ||
    problems.descriptionZh !== undefined ||
    problems.altText !== undefined;

  return (
    <AppFrame
      className="product-editor-page"
      title={product ? product.name : t("New product")}
      description={product ? t("Edit product") : t("New product")}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {t("{value} · Brand", { value: product ? t("Edit product") : t("New product") })}
          </p>
          <h2>{product ? product.name : t("New product")}</h2>
          <p>
            {product ? (
              <>
                {t("{value} · version {aggregateVersion} · updated", {
                  value: lifecycleText[product.lifecycle] ?? product.lifecycle,
                  aggregateVersion: product.aggregateVersion,
                })}{" "}
                <SourceTime instant={product.updatedAt} />
              </>
            ) : (
              t("Name the product, choose its tax class and list the sizes a customer can order.")
            )}
          </p>
          <p>
            {t(
              "Pilot: changes apply to the Brand's product directly, without a separate publication review; every change is recorded with its author.",
            )}
          </p>
        </div>
        <Link to="/app/commerce/products">{t("Back to products")}</Link>
      </header>
      {message ? (
        <StatePanel
          heading={message.tone === "error" ? t("Not saved") : t("Done")}
          tone={message.tone}
          status
        >
          <p>{message.text}</p>
        </StatePanel>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || busy || !mayEdit || !changed || photoUploading) return;
          if (presentationBlocked) {
            setShowPresentationProblems(true);
            if (problems.altText) altTextRef.current?.focus();
            return;
          }
          save();
        }}
      >
        <fieldset disabled={!mayEdit || busy}>
          <legend>{t("Product")}</legend>
          <label>
            {t("Name")}
            <input
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("Chinese name (中文名称, optional)")}
            <input
              lang="zh-Hans"
              value={nameZh}
              maxLength={120}
              aria-describedby="product-chinese-help"
              onChange={(event) => setNameZh(event.target.value)}
            />
          </label>
          <p id="product-chinese-help">
            {t("Customers who choose 中文 see this name; without it they see the name above.")}
          </p>
          <label>
            {t("Code")}
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
            {t(
              "Capital letters, digits and hyphens; it cannot be changed after the product is created.",
            )}
          </p>
          <label>
            {t("Type")}
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
            {t("Tax class")}
            <select value={taxClass} required onChange={(event) => setTaxClass(event.target.value)}>
              <option value="">{t("Choose…")}</option>
              {view.taxClasses.map((choice, index) => (
                <option
                  key={choice.taxClassificationReference}
                  value={choice.taxClassificationReference}
                >
                  {t("Tax class {value} — {choice}", {
                    value: index + 1,
                    choice: taxClassText(choice),
                  })}
                </option>
              ))}
            </select>
          </label>
          {view.taxClasses.length === 0 ? (
            <p>{t("This Store has no current tax configuration for sellable items.")}</p>
          ) : (
            <p>
              {t(
                "Classes and rates come from this Store's current tax configuration (internal test rates, not verified tax advice).",
              )}
            </p>
          )}
        </fieldset>
        <fieldset disabled={!mayEdit || busy}>
          <legend>{t("Sizes")}</legend>
          <table>
            <thead>
              <tr>
                <th>{t("Size name")}</th>
                <th>{t("Chinese name")}</th>
                <th>{t("Size code")}</th>
                <th>{t("Status")}</th>
                <th aria-label={t("Remove")} />
              </tr>
            </thead>
            <tbody>
              {effectiveSizes.map((size, index) => (
                <tr key={size.key}>
                  <td>
                    <input
                      aria-label={t("Size {value} name", { value: index + 1 })}
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
                      lang="zh-Hans"
                      aria-label={t("Size {value} Chinese name", { value: index + 1 })}
                      value={size.nameZh}
                      maxLength={80}
                      onChange={(event) =>
                        setSizes((current) =>
                          current.map((item) =>
                            item.key === size.key ? { ...item, nameZh: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={t("Size {value} code", { value: index + 1 })}
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
                        {t("Remove")}
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
                    nameZh: "",
                  },
                ])
              }
            >
              {t("Add size")}
            </button>
          ) : null}
        </fieldset>
        {product !== null && optionChoices !== null ? (
          <ProductOptionSetsFieldset
            disabled={!mayEdit || busy}
            choices={optionChoices}
            value={optionSets}
            onChange={setOptionSets}
          />
        ) : null}
        {product?.presentation ? (
          mayEdit ? (
            <ProductCustomerMenuFieldset
              disabled={busy}
              client={client}
              productReference={product.productReference}
              value={presentation}
              onChange={setPresentation}
              onUploadingChange={setPhotoUploading}
              problems={showPresentationProblems ? problems : {}}
              altTextRef={altTextRef}
            />
          ) : (
            <ProductCustomerMenuReadOnly presentation={product.presentation} />
          )
        ) : null}
        {mayEdit ? (
          <button type="submit" disabled={!valid || busy || !changed || photoUploading}>
            {pending && pending.action !== "StartSelling"
              ? t("Retry")
              : product
                ? t("Save changes")
                : t("Create product")}
          </button>
        ) : null}
      </form>
      {product && notSelling && view.permissions.mayStartSelling ? (
        <section className="detail-section" aria-labelledby="start-selling">
          <h3 id="start-selling">{t("Start selling")}</h3>
          <p>
            {t(
              "Makes the product and every size not yet selling available to price and to place on menus. Customers see it once it is on a published menu with a price.",
            )}
          </p>
          <button type="button" disabled={busy || changed} onClick={startSelling}>
            {pending && pending.action === "StartSelling"
              ? t("Retry start selling")
              : t("Start selling")}
          </button>
          {changed ? <p>{t("Save your changes first.")}</p> : null}
        </section>
      ) : null}
      {product && view.screenId === "CAT-PRODUCT-DETAIL" && view.availabilityHere ? (
        <section className="detail-section" aria-labelledby="at-this-store">
          <h3 id="at-this-store">{t("At this Store")}</h3>
          <p>
            {t(
              "Customers at this Store see a size only when it is offered here, priced and on a published menu.",
            )}
          </p>
          <ul>
            {product.sizes.map((size) => (
              <li key={size.skuReference}>
                {size.name}:{" "}
                {storeAvailabilityText[view.availabilityHere?.[size.skuReference] ?? "NotOffered"]}
              </li>
            ))}
          </ul>
          <p>
            <Link to="/app/commerce/availability">{t("Item availability")}</Link>
          </p>
        </section>
      ) : null}
    </AppFrame>
  );
}

/** WP-2423: a size's availability at the selected Store, as staff say it. */
const storeAvailabilityText = {
  Available: t("Offered here"),
  SoldOut: t("Offered here, sold out right now"),
  Unavailable: t("Not offered here (stopped)"),
  NotOffered: t("Not offered at this Store yet — customers here don't see it"),
  Varies: t("Offered here for some order types"),
} as const;

/** WP-2423 slice 4: the option sets customers choose from on this product, and which options. */
function ProductOptionSetsFieldset({
  disabled,
  choices,
  value,
  onChange,
}: {
  readonly disabled: boolean;
  readonly choices: readonly ProductOptionSetChoice[];
  readonly value: readonly ProductOptionSetInput[];
  readonly onChange: (next: ProductOptionSetInput[]) => void;
}) {
  const [adding, setAdding] = useState("");
  const addable = choices.filter(
    (choice) =>
      !choice.archived &&
      choice.options.some((option) => option.offered) &&
      !value.some((item) => item.optionSetReference === choice.optionSetReference),
  );
  const replace = (index: number, item: ProductOptionSetInput | null) =>
    onChange(
      value.flatMap((current, at) => (at !== index ? [current] : item === null ? [] : [item])),
    );
  const move = (index: number, by: number) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + by, 0, item);
    onChange(next);
  };
  return (
    <fieldset disabled={disabled}>
      <legend>{t("Options")}</legend>
      <p>
        {t(
          "Choices customers make on this product, in the order they see them. Customers see changes when a menu with this product is next published.",
        )}
      </p>
      {value.length === 0 ? <p>{t("No options on this product.")}</p> : null}
      {value.map((item, index) => {
        const choice = choices.find(
          (candidate) => candidate.optionSetReference === item.optionSetReference,
        );
        if (choice === undefined) return null;
        const toggle = (reference: string, on: boolean) => {
          const enabled = on
            ? [...item.enabledOptionReferences, reference]
            : item.enabledOptionReferences.filter((existing) => existing !== reference);
          replace(index, {
            ...item,
            enabledOptionReferences: choice.options
              .map((option) => option.optionReference)
              .filter((option) => enabled.includes(option)),
          });
        };
        return (
          <section key={item.optionSetReference} className="detail-section">
            <h3>{choice.name}</h3>
            {choice.archived ? (
              <p>{t("This option set is archived; remove it from the product.")}</p>
            ) : null}
            <ul aria-label={t("Options from {name} on this product", { name: choice.name })}>
              {choice.options.map((option) => (
                <li key={option.optionReference}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.enabledOptionReferences.includes(option.optionReference)}
                      disabled={
                        item.enabledOptionReferences.length === 1 &&
                        item.enabledOptionReferences.includes(option.optionReference)
                      }
                      onChange={(event) => toggle(option.optionReference, event.target.checked)}
                    />
                    {option.name}
                    {option.offered ? "" : t(" (not offered by the Brand now)")}
                  </label>
                </li>
              ))}
            </ul>
            {index > 0 ? (
              <button type="button" onClick={() => move(index, -1)}>
                {t("Up")}
              </button>
            ) : null}
            {index < value.length - 1 ? (
              <button type="button" onClick={() => move(index, 1)}>
                {t("Down")}
              </button>
            ) : null}
            <button type="button" onClick={() => replace(index, null)}>
              {t("Remove {name}", { name: choice.name })}
            </button>
          </section>
        );
      })}
      {addable.length > 0 ? (
        <div>
          <label>
            {t("Add option set")}
            <select value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">{t("Choose…")}</option>
              {addable.map((choice) => (
                <option key={choice.optionSetReference} value={choice.optionSetReference}>
                  {choice.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={adding === ""}
            onClick={() => {
              const choice = addable.find((item) => item.optionSetReference === adding);
              if (!choice) return;
              onChange([
                ...value,
                {
                  optionSetReference: choice.optionSetReference,
                  enabledOptionReferences: choice.options
                    .filter((option) => option.offered)
                    .map((option) => option.optionReference),
                },
              ]);
              setAdding("");
            }}
          >
            {t("Add")}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

const emptyPresentation: PresentationDraft = {
  description: "",
  descriptionZh: "",
  photo: null,
  altText: "",
};
const presentationNote = t(
  "Customers see the description and photo after the menu is next published.",
);
const photoErrorText: Record<ProductPhotoErrorCode, string> = {
  PhotoTypeUnsupported: t("Use a JPEG, PNG or WebP photo."),
  PhotoTooLarge: t("This photo is larger than 10 MB. Choose a smaller one."),
  PhotoTooSmall: t(
    "This photo is too small or too narrow. Use one at least 480 pixels on its shorter side.",
  ),
  PhotoUnreadable: t("This file couldn't be read as a photo. Try another one."),
  PhotoStorageUnavailable: t("The photo didn't upload. Check the connection and try again."),
  Offline: t("The photo didn't upload. Check the connection and try again."),
  Unavailable: t("The photo didn't upload. Check the connection and try again."),
  PermissionDenied: copy.PermissionDenied,
  NotFound: copy.NotFound,
};
/** Staff wording for a photo the page or the server refused. */
export const photoUploadMessage = (code: ProductPhotoErrorCode) => photoErrorText[code];
const presentationProblemText = (problem: PresentationProblem, field: "description" | "alt") =>
  problem === "AltTextMissing"
    ? t(
        "Describe the photo before saving. Customers who use a screen reader hear this description.",
      )
    : problem === "TooLong"
      ? field === "description"
        ? t("Keep the description to {description} characters.", {
            description: presentationLimits.description,
          })
        : t("Keep the photo description to {altText} characters.", {
            altText: presentationLimits.altText,
          })
      : t("Use plain words only: no links and none of these characters: < > { }");

type PhotoUploadState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Uploading"; readonly file: File; readonly operationReference: string }
  | {
      readonly kind: "Failed";
      readonly code: ProductPhotoErrorCode;
      readonly file: File | null;
      readonly operationReference: string | null;
    };

/** WP-2423: the description and photo customers see under the product name on the menu. */
export function ProductCustomerMenuFieldset({
  disabled,
  client,
  productReference,
  value,
  onChange,
  onUploadingChange,
  problems,
  altTextRef,
  initialUpload = { kind: "Idle" },
}: {
  readonly disabled: boolean;
  readonly client: ProductClient;
  readonly productReference: string;
  readonly value: PresentationDraft;
  readonly onChange: (next: PresentationDraft) => void;
  readonly onUploadingChange: (uploading: boolean) => void;
  readonly problems: ReturnType<typeof presentationProblems>;
  readonly altTextRef?: Ref<HTMLInputElement>;
  readonly initialUpload?: PhotoUploadState;
}) {
  const id = useId();
  const [upload, setUpload] = useState<PhotoUploadState>(initialUpload);
  const latestValue = useRef(value);
  latestValue.current = value;
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = upload.kind === "Uploading";
  const start = async (file: File, operationReference: string) => {
    const problem = photoFileProblem(file);
    if (problem) {
      setUpload({ kind: "Failed", code: problem, file: null, operationReference: null });
      return;
    }
    if (!client.uploadPhoto) {
      setUpload({ kind: "Failed", code: "Unavailable", file, operationReference });
      return;
    }
    setUpload({ kind: "Uploading", file, operationReference });
    onUploadingChange(true);
    try {
      const photo = await client.uploadPhoto(productReference, file, operationReference);
      // A new photo needs its own description; the previous one described another picture.
      onChange({ ...latestValue.current, photo, altText: "" });
      setUpload({ kind: "Idle" });
    } catch (error) {
      const code = error instanceof ProductPhotoError ? error.code : "Unavailable";
      setUpload({ kind: "Failed", code, file, operationReference });
    } finally {
      onUploadingChange(false);
    }
  };
  const descriptionLeft = presentationLimits.description - value.description.length;
  const photoLabel = value.photo ? t("Replace photo") : t("Add photo");
  const altMissing = value.photo !== null && value.altText.trim() === "";
  const ids = {
    description: t("{id}-description", { id: id }),
    descriptionHelp: t("{id}-description-help", { id: id }),
    descriptionCount: t("{id}-description-count", { id: id }),
    descriptionError: t("{id}-description-error", { id: id }),
    photo: t("{id}-photo", { id: id }),
    photoHelp: t("{id}-photo-help", { id: id }),
    photoError: t("{id}-photo-error", { id: id }),
    alt: t("{id}-alt", { id: id }),
    altHelp: t("{id}-alt-help", { id: id }),
    altError: t("{id}-alt-error", { id: id }),
  };
  const photoError = upload.kind === "Failed" ? upload : null;
  return (
    <fieldset className="product-customer-menu" disabled={disabled}>
      <legend>{t("Customer menu")}</legend>
      <p className="product-customer-menu__note">{presentationNote}</p>
      <div className="product-customer-menu__field">
        <label htmlFor={ids.description}>{t("Description")}</label>
        <textarea
          id={ids.description}
          value={value.description}
          maxLength={presentationLimits.description}
          rows={3}
          aria-invalid={problems.description ? true : undefined}
          aria-describedby={[
            ids.descriptionHelp,
            ids.descriptionCount,
            problems.description ? ids.descriptionError : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
        />
        <p id={ids.descriptionHelp} className="product-customer-menu__help">
          {t(
            "Shown to customers under the product name. Plain text, up to {description} characters.",
            { description: presentationLimits.description },
          )}
        </p>
        <p id={ids.descriptionCount} className="product-customer-menu__count">
          {descriptionLeft === 1
            ? t("1 character left")
            : t("{descriptionLeft} characters left", { descriptionLeft: descriptionLeft })}
        </p>
        {problems.description ? (
          <p id={ids.descriptionError} className="product-customer-menu__error" role="alert">
            {presentationProblemText(problems.description, "description")}
          </p>
        ) : null}
      </div>
      <div className="product-customer-menu__field">
        <label htmlFor={`${id}-description-zh`}>
          {t("Chinese description (中文描述, optional)")}
        </label>
        <textarea
          id={`${id}-description-zh`}
          lang="zh-Hans"
          value={value.descriptionZh}
          maxLength={presentationLimits.description}
          rows={3}
          aria-invalid={problems.descriptionZh ? true : undefined}
          aria-describedby={`${id}-description-zh-help`}
          onChange={(event) => onChange({ ...value, descriptionZh: event.target.value })}
        />
        <p id={`${id}-description-zh-help`} className="product-customer-menu__help">
          {t("Customers who choose 中文 see this; without it they see the description above.")}
        </p>
        {problems.descriptionZh ? (
          <p className="product-customer-menu__error" role="alert">
            {presentationProblemText(problems.descriptionZh, "description")}
          </p>
        ) : null}
      </div>
      <div className="product-customer-menu__field">
        <span className="product-customer-menu__label">{t("Photo")}</span>
        {value.photo ? (
          <figure className="product-customer-menu__preview">
            <img
              src={value.photo.previewUrl}
              alt={altMissing ? "" : value.altText.trim()}
              width={value.photo.width}
              height={value.photo.height}
              aria-describedby={altMissing ? `${id}-preview-pending` : undefined}
            />
            {altMissing ? (
              <figcaption id={`${id}-preview-pending`} className="visually-hidden">
                {t("Photo preview, not described yet")}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <p id={ids.photoHelp} className="product-customer-menu__help">
            {t("No photo. A clear photo helps customers choose. JPEG, PNG or WebP, up to 10 MB.")}
          </p>
        )}
        <div className="product-customer-menu__actions">
          <input
            ref={fileInput}
            id={ids.photo}
            className="visually-hidden"
            type="file"
            accept={photoContentTypes.join(",")}
            disabled={disabled || uploading}
            aria-describedby={
              [value.photo ? "" : ids.photoHelp, photoError ? ids.photoError : ""]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void start(file, newOperationReference());
            }}
          />
          <label
            htmlFor={ids.photo}
            className="product-customer-menu__button"
            aria-disabled={disabled || uploading ? true : undefined}
          >
            {photoLabel}
          </label>
          {value.photo ? (
            <button
              type="button"
              className="product-customer-menu__button"
              disabled={uploading}
              onClick={() => {
                onChange({ ...value, photo: null, altText: "" });
                setUpload({ kind: "Idle" });
              }}
            >
              {t("Remove photo")}
            </button>
          ) : null}
        </div>
        {uploading ? (
          <p role="status" className="product-customer-menu__help">
            {t("Uploading photo…")}
          </p>
        ) : null}
        {photoError ? (
          <div id={ids.photoError} className="product-customer-menu__error" role="alert">
            <p>{photoUploadMessage(photoError.code)}</p>
            {photoRetryable(photoError.code) &&
            photoError.file !== null &&
            photoError.operationReference !== null ? (
              <button
                type="button"
                className="product-customer-menu__button"
                onClick={() => {
                  if (photoError.file && photoError.operationReference)
                    void start(photoError.file, photoError.operationReference);
                }}
              >
                {t("Retry")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {value.photo ? (
        <div className="product-customer-menu__field">
          <label htmlFor={ids.alt}>{t("Photo description (alt text)")}</label>
          <input
            ref={altTextRef}
            id={ids.alt}
            value={value.altText}
            maxLength={presentationLimits.altText}
            aria-required="true"
            aria-invalid={problems.altText ? true : undefined}
            aria-describedby={[ids.altHelp, problems.altText ? ids.altError : ""]
              .filter(Boolean)
              .join(" ")}
            onChange={(event) => onChange({ ...value, altText: event.target.value })}
          />
          <p id={ids.altHelp} className="product-customer-menu__help">
            {t(
              "Describe the photo for customers who use a screen reader, e.g. 'Flat white in a white ceramic cup'.",
            )}
          </p>
          {problems.altText ? (
            <p id={ids.altError} className="product-customer-menu__error" role="alert">
              {presentationProblemText(problems.altText, "alt")}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/** What customers see, for staff who may read the product but not change it. */
export function ProductCustomerMenuReadOnly({
  presentation,
}: {
  readonly presentation: ProductPresentation;
}) {
  return (
    <section className="product-customer-menu" aria-labelledby="customer-menu-heading">
      <h3 id="customer-menu-heading">{t("Customer menu")}</h3>
      <p className="product-customer-menu__note">{presentationNote}</p>
      <h4>{t("Description")}</h4>
      <p>{presentation.description === "" ? t("No description.") : presentation.description}</p>
      <h4>{t("Photo")}</h4>
      {presentation.photo ? (
        <figure className="product-customer-menu__preview">
          <img
            src={presentation.photo.previewUrl}
            alt={presentation.photo.altText}
            width={presentation.photo.width}
            height={presentation.photo.height}
          />
          <figcaption>
            {t("Photo description: {altText}", { altText: presentation.photo.altText })}
          </figcaption>
        </figure>
      ) : (
        <p>{t("No photo.")}</p>
      )}
    </section>
  );
}
