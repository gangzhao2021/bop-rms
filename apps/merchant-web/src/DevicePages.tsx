import { StatePanel } from "@bop-rms/ui";
import { useEffect, useState } from "react";
import {
  DevicePageError,
  parseDeviceView,
  unavailableDeviceClient,
  type DeviceClient,
  type DevicePageErrorCode,
  type DeviceView,
} from "./device-pages.js";
type PageState =
  | { readonly kind: "Loading" | DevicePageErrorCode }
  | { readonly kind: "Found"; readonly view: DeviceView };
export function DevicePageState({ state }: { readonly state: "Loading" | DevicePageErrorCode }) {
  const values: Record<typeof state, readonly [string, string, "neutral" | "error" | "offline"]> = {
    Loading: ["Loading Devices", "Loading authorized Device health and assignments…", "neutral"],
    PermissionDenied: ["Permission denied", "Device access is required.", "error"],
    NotFound: ["Device not found", "No authorized Device exists.", "neutral"],
    FeatureDisabled: ["Device management disabled", "This capability is not enabled.", "neutral"],
    Stale: [
      "Device projection stale",
      "Refresh before changing assignment or lifecycle.",
      "offline",
    ],
    Conflict: ["Device changed", "Refresh before retrying the command.", "offline"],
    CommandFailed: [
      "Device action failed",
      "No lifecycle or assignment outcome was inferred.",
      "error",
    ],
    Offline: ["Offline read-only", "Cached health cannot authorize Device actions.", "offline"],
    Unavailable: [
      "Devices unavailable",
      "No Device or foreign-domain outcome was inferred.",
      "error",
    ],
  };
  const value = values[state];
  return (
    <StatePanel heading={value[0]} tone={value[2]} status>
      <p>{value[1]}</p>
    </StatePanel>
  );
}
const label = (value: string) => value.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
export function Devices({ view }: { readonly view: DeviceView }) {
  return (
    <main className="page-shell">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">{view.screenId} · Device Management</p>
          <h1>Devices</h1>
          <p>
            Source as of {view.sourceAsOf} · {view.completeness} · {view.freshness}
          </p>
        </div>
        {view.permissions.mayRegister ? <button>Register Device</button> : null}
      </header>
      <form className="list-filters" aria-label="Device filters">
        <label>
          Label / Serial suffix
          <input
            value={`${view.filters.labelCode ?? "All"} · ${view.filters.safeSerialSuffix ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Type / Lifecycle
          <input
            value={`${view.filters.deviceType ?? "All"} · ${view.filters.lifecycle ?? "All"}`}
            readOnly
          />
        </label>
        <label>
          Connectivity
          <input
            value={`${view.filters.offlineOnly ? "Offline" : "All"} · ${view.filters.outdatedOnly ? "Outdated" : "Any version"}`}
            readOnly
          />
        </label>
      </form>
      {view.devices.length === 0 ? (
        <StatePanel heading="No Devices" tone="neutral" status>
          <p>No authorized Device matches this snapshot.</p>
        </StatePanel>
      ) : (
        <section className="card-list" aria-label="Devices">
          {view.devices.map((item) => (
            <article className="summary-card" key={item.deviceReference}>
              <p className="bop-eyebrow">
                {label(item.deviceType)} · {item.lifecycle}
              </p>
              <h2>{label(item.displayLabelCode)}</h2>
              <p>
                {item.health} · {item.connectivity} · last seen{" "}
                {item.lastSeenAt ?? "No recent heartbeat"}
              </p>
              <p>
                Store {item.storeReference} · station {item.stationReference ?? "Unassigned"}
              </p>
              <p>
                Software {item.softwareVersionCode ?? "Unknown"} · profile{" "}
                {item.profileVersionCode ?? "Unknown"}
              </p>
              <p>
                Capabilities{" "}
                {item.capabilityCodes.length ? item.capabilityCodes.join(", ") : "None validated"}
              </p>
              <p>
                {item.pilotEligibility === "BrowserKds"
                  ? "Pilot browser KDS eligible"
                  : item.pilotEligibility === "PaymentTerminalBoundary"
                    ? "Payment-owned terminal reference only"
                    : "Physical integration awaits Future Trigger"}
              </p>
              <div className="card-actions">
                {view.permissions.mayAssign && item.lifecycle !== "Retired" ? (
                  <button>{item.assignmentReference ? "Unassign" : "Assign"}</button>
                ) : null}
                {view.permissions.mayDisable && item.lifecycle === "Active" ? (
                  <button>Disable</button>
                ) : null}
                {view.permissions.mayOpenIncident && item.openIncidentReference === null ? (
                  <button>Open incident</button>
                ) : null}
                {view.screenId === "DEV-DEVICE-DETAIL" && view.permissions.mayRevokeCredential ? (
                  <button>Revoke approved credential reference</button>
                ) : null}
                {view.screenId === "DEV-DEVICE-DETAIL" && view.permissions.mayQuarantine ? (
                  <button>Quarantine</button>
                ) : null}
                {view.screenId === "DEV-DEVICE-DETAIL" &&
                view.permissions.mayRetire &&
                item.lifecycle !== "Retired" ? (
                  <button>Retire</button>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
      <p role="note">
        Health is observational and cannot change Payment, Order, Kitchen or Fulfillment status.
        Secrets, tokens and raw Device logs are never displayed.
      </p>
    </main>
  );
}
export function DevicePage({
  client = unavailableDeviceClient,
}: {
  readonly client?: DeviceClient;
}) {
  const [state, setState] = useState<PageState>({ kind: "Loading" });
  useEffect(() => {
    let active = true;
    void client.load().then(
      (value) => {
        if (active) setState({ kind: "Found", view: parseDeviceView(value) });
      },
      (error: unknown) => {
        if (active)
          setState({ kind: error instanceof DevicePageError ? error.code : "Unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, [client]);
  return state.kind === "Found" ? (
    <Devices view={state.view} />
  ) : (
    <DevicePageState state={state.kind} />
  );
}
export const DeviceListPage = DevicePage;
export const DeviceDetailPage = DevicePage;
