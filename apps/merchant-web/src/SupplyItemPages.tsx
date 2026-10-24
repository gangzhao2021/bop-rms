import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { newOperationReference } from "./operation-reference.js";
import {
  SupplyItemError,
  parseSupplyItemPageView,
  parseSupplyItemRouteReference,
  unavailableSupplyItemClient,
  type LotTracking,
  type NegativeStockPolicy,
  type SupplyItemClient,
  type SupplyItemCommand,
  type SupplyItemErrorCode,
  type SupplyItemFields,
  type SupplyItemPageView,
  type SupplyItemView,
} from "./supply-item-pages.js";

const copy: Record<SupplyItemErrorCode | "Loading", string> = {
  Loading: t("Loading inventory items…"),
  PermissionDenied: t("You do not have permission for this inventory action."),
  NotFound: t("This inventory item does not exist for the selected Brand."),
  Conflict: t(
    "The item changed or the action is not allowed in its current status. Refresh and try again.",
  ),
  StockRemaining: t(
    "A Store still holds, reserves or expects stock of this item. Use or adjust that stock before archiving.",
  ),
  Locked: t(
    "Stock has been recorded for this item, so its base unit cannot change and tracking changes need a migration plan.",
  ),
  Invalid: t("Some values are not valid. Check the code, name and tracking settings."),
  Offline: t("Offline. The change was not confirmed; retry sends the same request again."),
  Unavailable: t("Inventory items are unavailable."),
};
const itemTypes = [
  ["RawMaterial", t("Raw material")],
  ["Packaging", "Packaging"],
  ["SemiFinished", t("Semi-finished (prepared in store)")],
  ["FinishedGood", t("Finished good")],
  ["NonFoodSupply", t("Non-food supply")],
] as const;
const lotModes: readonly (readonly [LotTracking, string])[] = [
  ["NoLot", t("No lot tracking")],
  ["LotOptional", t("Lot optional")],
  ["LotRequired", t("Lot required")],
  ["LotExpiryRequired", t("Lot and expiry required (FEFO)")],
];
const negativePolicies: readonly (readonly [NegativeStockPolicy, string])[] = [
  ["Block", t("Block when stock would go negative")],
  ["ManagerOverride", t("Manager override required")],
  ["AllowWithWarning", t("Allow with a warning")],
];
type State =
  | { readonly kind: "Loading" | SupplyItemErrorCode }
  | { readonly kind: "Found"; readonly view: SupplyItemPageView };

function routeReference(value: unknown): string | null {
  try {
    return parseSupplyItemRouteReference(value);
  } catch {
    return null;
  }
}
function Failure({ code, onRefresh }: { code: SupplyItemErrorCode; onRefresh?: () => void }) {
  return (
    <StatePanel
      heading={code === "PermissionDenied" ? noAccessHeading : t("Inventory items")}
      tone="error"
      status
    >
      <p>{code === "PermissionDenied" ? pageAccessDeniedText : copy[code]}</p>
      {onRefresh ? <button onClick={onRefresh}>{t("Refresh")}</button> : null}
    </StatePanel>
  );
}
function useView(
  client: SupplyItemClient,
  screenId: SupplyItemPageView["screenId"],
  itemReference: string | null,
  filters: { search: string; lifecycle: string },
) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const [pages, setPages] = useState<SupplyItemView[]>([]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setPages([]);
    void client
      .load({
        itemReference,
        search: filters.search.trim() === "" ? null : filters.search.trim(),
        lifecycle:
          filters.lifecycle === "All"
            ? null
            : (filters.lifecycle as "Active" | "Inactive" | "Archived"),
        afterInternalCode: null,
      })
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseSupplyItemPageView(value, screenId) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof SupplyItemError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, screenId, itemReference, filters.search, filters.lifecycle, generation]);
  const loadMore = async () => {
    if (state.kind !== "Found") return;
    const last = [...state.view.items, ...pages].at(-1);
    const value = await client.load({
      itemReference: null,
      search: filters.search.trim() === "" ? null : filters.search.trim(),
      lifecycle:
        filters.lifecycle === "All"
          ? null
          : (filters.lifecycle as "Active" | "Inactive" | "Archived"),
      afterInternalCode: last?.internalCode ?? null,
    });
    const next = parseSupplyItemPageView(value, "INV-ITEM-LIST");
    setPages((current) => [...current, ...next.items]);
    setState({ kind: "Found", view: { ...state.view, hasMore: next.hasMore } });
  };
  return { state, reload, pages, loadMore };
}

export function SupplyItemListPage({
  client = unavailableSupplyItemClient,
}: {
  readonly client?: SupplyItemClient;
}) {
  const [search, setSearch] = useState(""),
    [applied, setApplied] = useState(""),
    [lifecycle, setLifecycle] = useState("All");
  const { state, reload, pages, loadMore } = useView(client, "INV-ITEM-LIST", null, {
    search: applied,
    lifecycle,
  });
  if (state.kind === "Loading")
    return (
      <StatePanel heading={t("Inventory items")} status>
        <p>{copy.Loading}</p>
      </StatePanel>
    );
  if (state.kind !== "Found") return <Failure code={state.kind} onRefresh={reload} />;
  const view = state.view;
  const items = [...view.items, ...pages];
  return (
    <AppFrame title={t("Inventory items")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Inventory items")}</p>
          <h2>{t("Inventory items")}</h2>
          <p>
            {t("Ingredients and supplies the Brand stocks. Source as of")}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
        {view.permissions.mayCreate ? (
          <Link to="/app/supply/items/new">{t("Create item")}</Link>
        ) : null}
      </header>
      <form
        className="list-filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(search);
        }}
      >
        <label>
          {t("Name or code")}
          <input
            value={search}
            maxLength={80}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("Status")}
          <select value={lifecycle} onChange={(event) => setLifecycle(event.currentTarget.value)}>
            <option>{t("All")}</option>
            <option>{t("Active")}</option>
            <option>{t("Inactive")}</option>
            <option>{t("Archived")}</option>
          </select>
        </label>
        <button>{t("Search")}</button>
      </form>
      {items.length === 0 ? (
        <StatePanel heading={t("No inventory items")} status>
          <p>
            {view.permissions.mayCreate
              ? t("Create the first ingredient or supply the Store stocks.")
              : t("No item matches.")}
          </p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Name")}</th>
              <th>{t("Code")}</th>
              <th>{t("Unit")}</th>
              <th>{t("Tracking")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemReference}>
                <td>
                  <Link to={`/app/supply/items/${item.itemReference}`}>{item.name}</Link>
                </td>
                <td>{item.internalCode}</td>
                <td>{item.unitCode}</td>
                <td>
                  {item.stockTracked
                    ? (lotModes.find(([mode]) => mode === item.lotTracking)?.[1] ??
                      item.lotTracking)
                    : t("Not stock tracked")}
                </td>
                <td>{item.lifecycle}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view.hasMore ? <button onClick={() => void loadMore()}>{t("Load more")}</button> : null}
    </AppFrame>
  );
}

function useCommand(client: SupplyItemClient) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<SupplyItemErrorCode | null>(null),
    [pending, setPending] = useState<SupplyItemCommand | null>(null);
  const run = async (command: SupplyItemCommand) => {
    if (!client.command) return null;
    setBusy(true);
    setError(null);
    setPending(command);
    try {
      const result = await client.command(command);
      setPending(null);
      return result;
    } catch (failure) {
      setError(failure instanceof SupplyItemError ? failure.code : "Unavailable");
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, pending, run };
}

export function SupplyItemDetailPage({
  client = unavailableSupplyItemClient,
}: {
  readonly client?: SupplyItemClient;
}) {
  const { id } = useParams();
  const reference = routeReference(id);
  const { state, reload } = useView(client, "INV-ITEM-DETAIL", reference, {
    search: "",
    lifecycle: "All",
  });
  const { busy, error, pending, run } = useCommand(client);
  if (reference === null) return <Failure code="NotFound" />;
  if (state.kind === "Loading")
    return (
      <StatePanel heading={t("Inventory item")} status>
        <p>{copy.Loading}</p>
      </StatePanel>
    );
  if (state.kind !== "Found") return <Failure code={state.kind} onRefresh={reload} />;
  const view = state.view;
  const item = view.items[0] as SupplyItemView;
  const may = view.permissions;
  const transition = (action: SupplyItemCommand["action"], reasonCode: string) =>
    void run({
      action,
      operationReference: newOperationReference(),
      itemReference: item.itemReference,
      expectedVersion: item.version,
      fields: null,
      reasonCode,
    }).then((result) => {
      if (result) reload();
    });
  return (
    <AppFrame title={item.name} description={t("Inventory item")}>
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Inventory item")}</p>
          <h2>{item.name}</h2>
          <p>
            {item.internalCode} · {item.itemType} · <strong>{item.lifecycle}</strong>{" "}
            {t("· version {version}", { version: item.version })}
          </p>
        </div>
        <Link to="/app/supply/items">{t("Back to items")}</Link>
      </header>
      <section className="detail-section">
        <h3>{t("Units and tracking")}</h3>
        <p>{t("Base unit {unitCode}", { unitCode: item.unitCode })}</p>
        <p>
          {item.stockTracked
            ? (lotModes.find(([mode]) => mode === item.lotTracking)?.[1] ?? item.lotTracking)
            : t("Not stock tracked")}
          {item.shelfLifeDays !== null
            ? t(" · shelf life {shelfLifeDays} days", { shelfLifeDays: item.shelfLifeDays })
            : ""}
          {item.expiryWarningDays !== null
            ? t(" · warn {expiryWarningDays} days before expiry", {
                expiryWarningDays: item.expiryWarningDays,
              })
            : ""}
        </p>
        <p>{negativePolicies.find(([policy]) => policy === item.negativeStockPolicy)?.[1]}</p>
        {view.stockRemaining ? (
          <p>{t("A Store currently holds or reserves stock of this item.")}</p>
        ) : null}
      </section>
      <div className="card-actions" role="group" aria-label={t("Item actions")}>
        {may.mayUpdate && item.lifecycle !== "Archived" ? (
          <Link to={`/app/supply/items/${item.itemReference}/edit`}>{t("Edit")}</Link>
        ) : null}
        {may.mayActivate && item.lifecycle === "Inactive" ? (
          <button disabled={busy} onClick={() => transition("Activate", "ITEM_READY_FOR_USE")}>
            {t("Activate")}
          </button>
        ) : null}
        {may.mayDeactivate && item.lifecycle === "Active" ? (
          <button disabled={busy} onClick={() => transition("Deactivate", "ITEM_NOT_IN_USE")}>
            {t("Deactivate")}
          </button>
        ) : null}
        {may.mayArchive && item.lifecycle === "Inactive" ? (
          <button
            disabled={busy || view.stockRemaining === true}
            title={view.stockRemaining ? copy.StockRemaining : undefined}
            onClick={() => transition("Archive", "ITEM_DISCONTINUED")}
          >
            {t("Archive")}
          </button>
        ) : null}
        {may.mayRestore && item.lifecycle === "Archived" ? (
          <button disabled={busy} onClick={() => transition("Restore", "ITEM_REINSTATED")}>
            {t("Restore")}
          </button>
        ) : null}
      </div>
      {error ? (
        <StatePanel heading={t("Change not applied")} tone="error" status>
          <p>{copy[error]}</p>
          {pending && error === "Offline" ? (
            <button disabled={busy} onClick={() => void run(pending).then((r) => r && reload())}>
              {t("Retry")}
            </button>
          ) : (
            <button onClick={reload}>{t("Refresh")}</button>
          )}
        </StatePanel>
      ) : null}
    </AppFrame>
  );
}

function ItemForm({
  view,
  item,
  client,
}: {
  readonly view: SupplyItemPageView;
  readonly item: SupplyItemView | null;
  readonly client: SupplyItemClient;
}) {
  const navigate = useNavigate();
  const editing = item !== null;
  const may = view.permissions;
  const unitLocked = editing && !may.mayChangeUnit;
  const trackingLocked = editing && !may.mayChangeTracking;
  const [fields, setFields] = useState<SupplyItemFields>({
    ...(editing ? {} : { internalCode: "", itemType: "RawMaterial" }),
    name: item?.name ?? "",
    unitCode: item?.unitCode ?? view.units[0]?.unitCode ?? "KG",
    stockTracked: item?.stockTracked ?? true,
    lotTracking: item?.lotTracking ?? "NoLot",
    shelfLifeDays: item?.shelfLifeDays ?? null,
    expiryWarningDays: item?.expiryWarningDays ?? null,
    negativeStockPolicy: item?.negativeStockPolicy ?? "Block",
  });
  const { busy, error, pending, run } = useCommand(client);
  const set = (patch: Partial<SupplyItemFields>) =>
    setFields((current) => ({ ...current, ...patch }));
  const number = (value: string) => (value.trim() === "" ? null : Number(value));
  const expiry = fields.lotTracking === "LotExpiryRequired";
  const submit = async (command: SupplyItemCommand) => {
    const result = await run(command);
    if (result) {
      const saved = (result.item as { itemReference?: string }).itemReference;
      navigate(`/app/supply/items/${saved ?? item?.itemReference ?? ""}`);
    }
  };
  return (
    <form
      className="detail-section"
      onSubmit={(event) => {
        event.preventDefault();
        void submit({
          action: editing ? "Update" : "Create",
          operationReference: newOperationReference(),
          itemReference: item?.itemReference ?? null,
          expectedVersion: item?.version ?? null,
          fields: {
            ...fields,
            ...(editing ? {} : { internalCode: (fields.internalCode ?? "").trim().toUpperCase() }),
            name: fields.name.trim(),
            lotTracking: fields.stockTracked ? fields.lotTracking : "NoLot",
          },
          reasonCode: null,
        });
      }}
    >
      {editing ? (
        <p>
          {item.internalCode} · {item.itemType}
        </p>
      ) : (
        <>
          <label>
            {t("Internal code (letters, digits, - or _)")}
            <input
              required
              maxLength={64}
              value={fields.internalCode ?? ""}
              onChange={(event) => set({ internalCode: event.currentTarget.value })}
            />
          </label>
          <label>
            {t("Item type")}
            <select
              value={fields.itemType}
              onChange={(event) => set({ itemType: event.currentTarget.value })}
            >
              {itemTypes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label>
        {t("Name")}
        <input
          required
          maxLength={120}
          value={fields.name}
          onChange={(event) => set({ name: event.currentTarget.value })}
        />
      </label>
      <label>
        {t("Base unit {value}", {
          value: unitLocked ? t("(requires unit management permission)") : "",
        })}
        <select
          disabled={unitLocked}
          value={fields.unitCode}
          onChange={(event) => set({ unitCode: event.currentTarget.value })}
        >
          {view.units.map((unit) => (
            <option key={unit.unitCode} value={unit.unitCode}>
              {unit.label} ({unit.unitCode})
            </option>
          ))}
        </select>
      </label>
      <fieldset disabled={trackingLocked}>
        <legend>
          {t("Tracking {value}", {
            value: trackingLocked ? t("(requires tracking management permission)") : "",
          })}
        </legend>
        <label>
          <input
            type="checkbox"
            checked={fields.stockTracked}
            onChange={(event) => set({ stockTracked: event.currentTarget.checked })}
          />{" "}
          {t("Track stock for this item")}
        </label>
        <label>
          {t("Lots and expiry")}
          <select
            disabled={!fields.stockTracked}
            value={fields.lotTracking}
            onChange={(event) => set({ lotTracking: event.currentTarget.value as LotTracking })}
          >
            {lotModes.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Shelf life (days){value}", { value: expiry ? t(" — required") : "" })}
          <input
            type="number"
            min={1}
            required={expiry}
            value={fields.shelfLifeDays ?? ""}
            onChange={(event) => set({ shelfLifeDays: number(event.currentTarget.value) })}
          />
        </label>
        <label>
          {t("Expiry warning (days before){value}", { value: expiry ? t(" — required") : "" })}
          <input
            type="number"
            min={0}
            required={expiry}
            value={fields.expiryWarningDays ?? ""}
            onChange={(event) => set({ expiryWarningDays: number(event.currentTarget.value) })}
          />
        </label>
        <label>
          {t("When stock would go negative")}
          <select
            value={fields.negativeStockPolicy}
            onChange={(event) =>
              set({ negativeStockPolicy: event.currentTarget.value as NegativeStockPolicy })
            }
          >
            {negativePolicies.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {!editing ? (
        <p>{t("New items start Inactive. Activate an item when it is ready to use.")}</p>
      ) : null}
      <button disabled={busy}>{editing ? t("Save changes") : t("Create item")}</button>{" "}
      <Link to={item ? `/app/supply/items/${item.itemReference}` : "/app/supply/items"}>
        {t("Cancel")}
      </Link>
      {error ? (
        <StatePanel heading={t("Not saved")} tone="error" status>
          <p>{copy[error]}</p>
          {pending && error === "Offline" ? (
            <button type="button" disabled={busy} onClick={() => void submit(pending)}>
              {t("Retry")}
            </button>
          ) : null}
        </StatePanel>
      ) : null}
    </form>
  );
}

export function SupplyItemFormPage({
  mode,
  client = unavailableSupplyItemClient,
}: {
  readonly mode: "Create" | "Edit";
  readonly client?: SupplyItemClient;
}) {
  const { id } = useParams();
  const reference = mode === "Edit" ? routeReference(id) : null;
  const { state, reload } = useView(
    client,
    mode === "Edit" ? "INV-ITEM-DETAIL" : "INV-ITEM-LIST",
    reference,
    { search: "", lifecycle: "All" },
  );
  if (mode === "Edit" && reference === null) return <Failure code="NotFound" />;
  if (state.kind === "Loading")
    return (
      <StatePanel heading={t("Inventory item")} status>
        <p>{copy.Loading}</p>
      </StatePanel>
    );
  if (state.kind !== "Found") return <Failure code={state.kind} onRefresh={reload} />;
  const view = state.view;
  if (mode === "Create" ? !view.permissions.mayCreate : !view.permissions.mayUpdate)
    return <Failure code="PermissionDenied" />;
  return (
    <AppFrame
      title={mode === "Create" ? t("Create inventory item") : t("Edit inventory item")}
      description={mode === "Create" ? t("New inventory item") : t("Edit inventory item")}
    >
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">
            {mode === "Create" ? t("New inventory item") : t("Edit inventory item")}
          </p>
          <h2>{mode === "Create" ? t("Create inventory item") : t("Edit inventory item")}</h2>
          <p>
            {t(
              "Quantities are never edited here; stock changes only through receipts, counts and waste.",
            )}
          </p>
        </div>
      </header>
      <ItemForm
        view={view}
        item={mode === "Edit" ? (view.items[0] ?? null) : null}
        client={client}
      />
    </AppFrame>
  );
}
