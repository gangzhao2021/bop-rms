import { systemText, t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { newOperationReference } from "./operation-reference.js";
import {
  StockLocationError,
  parseStockLocationPageView,
  unavailableStockLocationClient,
  type StockLocationClient,
  type StockLocationCommand,
  type StockLocationErrorCode,
  type StockLocationPageView,
  type StockLocationView,
  type TemperatureZone,
} from "./stock-location-pages.js";

const copy: Record<StockLocationErrorCode | "Loading", string> = {
  Loading: t("Loading stock locations…"),
  PermissionDenied: t("You do not have permission to manage stock locations."),
  NotFound: t("This location no longer exists in the selected Store."),
  Conflict: t(
    "The location changed, the code is already used, or the Store is already set up. Refresh and try again.",
  ),
  DefaultRequired: t("The default location cannot be deactivated; the Store always needs one."),
  StockRemaining: t(
    "Stock is still held, reserved or expected at this location. Move or count it out first.",
  ),
  Invalid: t("Some values are not valid. Codes use capital letters, digits, - or _."),
  Offline: t("Offline. The change was not confirmed; retry sends the same request again."),
  Unavailable: t("Stock locations are unavailable."),
};
const zones: readonly (readonly [TemperatureZone, string])[] = [
  ["Ambient", t("Ambient (dry storage)")],
  ["Chilled", t("Chilled (fridge)")],
  ["Frozen", t("Frozen (freezer)")],
];
const zoneLabel = (zone: TemperatureZone) => zones.find(([value]) => value === zone)?.[1] ?? zone;
type State =
  | { readonly kind: "Loading" | StockLocationErrorCode }
  | { readonly kind: "Found"; readonly view: StockLocationPageView };

function useRunner(client: StockLocationClient, reload: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<StockLocationErrorCode | null>(null),
    [pending, setPending] = useState<StockLocationCommand | null>(null);
  const run = async (command: StockLocationCommand) => {
    if (!client.command) return false;
    setBusy(true);
    setError(null);
    setPending(command);
    try {
      await client.command(command);
      setPending(null);
      reload();
      return true;
    } catch (failure) {
      setError(failure instanceof StockLocationError ? failure.code : "Unavailable");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const errorPanel = error ? (
    <StatePanel heading={t("Change not applied")} tone="error" status>
      <p>{copy[error]}</p>
      {pending && error === "Offline" ? (
        <button type="button" disabled={busy} onClick={() => void run(pending)}>
          {t("Retry")}
        </button>
      ) : (
        <button type="button" onClick={reload}>
          {t("Refresh")}
        </button>
      )}
    </StatePanel>
  ) : null;
  return { busy, run, errorPanel };
}

function Setup({ client, reload }: { client: StockLocationClient; reload: () => void }) {
  const [siteName, setSiteName] = useState("Store"),
    [locationCode, setLocationCode] = useState("BACK"),
    [locationName, setLocationName] = useState(t("Back room")),
    [zone, setZone] = useState<TemperatureZone>("Ambient");
  const { busy, run, errorPanel } = useRunner(client, reload);
  return (
    <form
      className="detail-section"
      onSubmit={(event) => {
        event.preventDefault();
        void run({
          operation: "SetupDefaults",
          siteOperationReference: newOperationReference(),
          locationOperationReference: newOperationReference(),
          siteName: siteName.trim(),
          locationCode: locationCode.trim().toUpperCase(),
          locationName: locationName.trim(),
          temperatureZone: zone,
        });
      }}
    >
      <h3>{t("Set up Store stock")}</h3>
      <p>
        {t(
          "Stock is kept by location. Start with the Store and its main storage location; add fridges, freezers or a bar afterwards.",
        )}
      </p>
      <label>
        {t("Store stock site name")}
        <input
          required
          maxLength={80}
          value={siteName}
          onChange={(e) => setSiteName(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("Main location code")}
        <input
          required
          maxLength={32}
          value={locationCode}
          onChange={(e) => setLocationCode(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("Main location name")}
        <input
          required
          maxLength={80}
          value={locationName}
          onChange={(e) => setLocationName(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("Temperature")}
        <select value={zone} onChange={(e) => setZone(e.currentTarget.value as TemperatureZone)}>
          {zones.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy}>{t("Set up stock locations")}</button>
      {errorPanel}
    </form>
  );
}

function LocationRow({
  location,
  mayManage,
  client,
  reload,
}: {
  location: StockLocationView;
  mayManage: boolean;
  client: StockLocationClient;
  reload: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(location.name),
    [zone, setZone] = useState(location.temperatureZone),
    [order, setOrder] = useState(String(location.sortOrder));
  const { busy, run, errorPanel } = useRunner(client, reload);
  return (
    <li>
      <strong>{location.name}</strong> · {location.code} · {zoneLabel(location.temperatureZone)} ·{" "}
      {systemText(location.lifecycle)}
      {location.isDefault ? t(" · Default") : ""}
      {location.holdsStock ? t(" · Holds stock") : ""}{" "}
      {mayManage && !editing ? (
        <>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            {t("Edit")}
          </button>{" "}
          {location.lifecycle === "Active" && !location.isDefault ? (
            <button
              type="button"
              disabled={busy || location.holdsStock}
              title={location.holdsStock ? copy.StockRemaining : undefined}
              onClick={() =>
                void run({
                  operation: "DeactivateLocation",
                  operationReference: newOperationReference(),
                  locationReference: location.locationReference,
                  expectedVersion: location.version,
                })
              }
            >
              {t("Deactivate")}
            </button>
          ) : null}
          {location.lifecycle === "Inactive" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run({
                  operation: "ActivateLocation",
                  operationReference: newOperationReference(),
                  locationReference: location.locationReference,
                  expectedVersion: location.version,
                })
              }
            >
              {t("Activate")}
            </button>
          ) : null}
        </>
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run({
              operation: "UpdateLocation",
              operationReference: newOperationReference(),
              locationReference: location.locationReference,
              expectedVersion: location.version,
              name: name.trim(),
              temperatureZone: zone,
              sortOrder: Number(order),
            }).then((done) => done && setEditing(false));
          }}
        >
          <label>
            {t("Name")}
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </label>
          <label>
            {t("Temperature")}
            <select
              value={zone}
              onChange={(e) => setZone(e.currentTarget.value as TemperatureZone)}
            >
              {zones.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Display order")}
            <input
              type="number"
              min={0}
              max={999}
              value={order}
              onChange={(e) => setOrder(e.currentTarget.value)}
            />
          </label>
          <button disabled={busy}>{t("Save")}</button>{" "}
          <button type="button" onClick={() => setEditing(false)}>
            {t("Cancel")}
          </button>
        </form>
      ) : null}
      {errorPanel}
    </li>
  );
}

function AddLocation({
  view,
  client,
  reload,
}: {
  view: StockLocationPageView;
  client: StockLocationClient;
  reload: () => void;
}) {
  const site = view.sites.find((item) => item.isDefault) ?? view.sites[0];
  const [code, setCode] = useState(""),
    [name, setName] = useState(""),
    [zone, setZone] = useState<TemperatureZone>("Chilled");
  const { busy, run, errorPanel } = useRunner(client, reload);
  if (!site) return null;
  return (
    <form
      className="detail-section"
      onSubmit={(event) => {
        event.preventDefault();
        void run({
          operation: "CreateLocation",
          operationReference: newOperationReference(),
          stockSiteReference: site.stockSiteReference,
          code: code.trim().toUpperCase(),
          name: name.trim(),
          temperatureZone: zone,
          sortOrder: view.locations.length,
        }).then((done) => {
          if (done) {
            setCode("");
            setName("");
          }
        });
      }}
    >
      <h3>{t("Add a location")}</h3>
      <label>
        {t("Code (e.g. FRIDGE-1)")}
        <input
          required
          maxLength={32}
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("Name")}
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label>
        {t("Temperature")}
        <select value={zone} onChange={(e) => setZone(e.currentTarget.value as TemperatureZone)}>
          {zones.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy}>{t("Add location")}</button>
      {errorPanel}
    </form>
  );
}

export function StockLocationListPage({
  client = unavailableStockLocationClient,
}: {
  readonly client?: StockLocationClient;
}) {
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStockLocationPageView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof StockLocationError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, generation]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading={state.kind === "PermissionDenied" ? noAccessHeading : t("Stock locations")}
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{state.kind === "PermissionDenied" ? pageAccessDeniedText : copy[state.kind]}</p>
        {state.kind !== "Loading" ? <button onClick={reload}>{t("Refresh")}</button> : null}
      </StatePanel>
    );
  const view = state.view;
  return (
    <AppFrame title={t("Stock locations")} description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{t("Stock locations")}</p>
          <h2>{t("Stock locations")}</h2>
          <p>
            {t("Where this Store keeps its stock. Source as of")}{" "}
            <SourceTime instant={view.sourceAsOf} />
          </p>
        </div>
      </header>
      {view.needsSetup ? (
        view.mayManage ? (
          <Setup client={client} reload={reload} />
        ) : (
          <StatePanel heading={t("Not set up")} status>
            <p>{t("This Store has no stock locations yet. Ask a manager to set them up.")}</p>
          </StatePanel>
        )
      ) : (
        <>
          {view.sites.map((site) => (
            <section key={site.stockSiteReference} className="detail-section">
              <h3>
                {site.name} · {site.code}
                {site.isDefault ? t(" · Default site") : ""}
              </h3>
              <ul>
                {view.locations
                  .filter((location) => location.stockSiteReference === site.stockSiteReference)
                  .map((location) => (
                    <LocationRow
                      key={`${location.locationReference}:${location.version}`}
                      location={location}
                      mayManage={view.mayManage}
                      client={client}
                      reload={reload}
                    />
                  ))}
              </ul>
            </section>
          ))}
          {view.mayManage ? <AddLocation view={view} client={client} reload={reload} /> : null}
        </>
      )}
    </AppFrame>
  );
}
