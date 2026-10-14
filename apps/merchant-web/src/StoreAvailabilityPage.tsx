import { AppFrame, StatePanel } from "@bop-rms/ui";
import { SourceTime } from "./StoreTime.js";
import { useCallback, useEffect, useState } from "react";
import { newOperationReference } from "./RoleAdministrationPages.js";
import {
  AvailabilityPageError,
  availabilityActions,
  floorStaffOnly,
  parseStoreAvailabilityView,
  soldOutText,
  unavailableAvailabilityClient,
  type AvailabilityClient,
  type AvailabilityCommand,
  type AvailabilityErrorCode,
  type AvailabilityItem,
  type StoreAvailabilityView,
} from "./store-availability-page.js";

/** WP-2423 8.5: which items this Store sells now — offer, sold out, back in stock. */
const copy: Record<AvailabilityErrorCode | "Loading", string> = {
  Loading: "Loading item availability…",
  PermissionDenied:
    "You do not have permission for this. Offering items is a Brand decision; kitchen and front-of-house staff can mark items sold out for today, and a manager can mark them sold out until further notice.",
  NotFound: "This item is no longer sold by the Brand.",
  Conflict:
    "The item changed since you opened the page, or is not offered here. Refresh and check.",
  Invalid: "That request is not valid.",
  Offline: "Offline. Nothing was confirmed; retry sends the same request again.",
  Unavailable: "Item availability is unavailable.",
};
const statusText = {
  Available: "Available",
  SoldOut: "Sold out",
  Unavailable: "Not available here",
  NotOffered: "Not offered at this Store",
  Varies: "Available for some order types",
} as const;

export function StoreAvailabilityPage({
  client = unavailableAvailabilityClient,
}: {
  readonly client?: AvailabilityClient;
}) {
  const [state, setState] = useState<
    | { readonly kind: "Loading" | AvailabilityErrorCode }
    | { readonly kind: "Found"; readonly view: StoreAvailabilityView }
  >({ kind: "Loading" });
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<AvailabilityCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "neutral"; text: string } | null>(null);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    void client
      .load()
      .then((value) => {
        if (active) setState({ kind: "Found", view: parseStoreAvailabilityView(value) });
      })
      .catch((error: unknown) => {
        if (active)
          setState({ kind: error instanceof AvailabilityPageError ? error.code : "Unavailable" });
      });
    return () => {
      active = false;
    };
  }, [client, generation]);
  if (state.kind !== "Found")
    return (
      <StatePanel
        heading="Item availability"
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{copy[state.kind]}</p>
      </StatePanel>
    );
  const view = state.view;
  // WP-2423 Q17: floor staff (Kitchen, Front of House) see only items sold here.
  const floorOnly = floorStaffOnly(view.permissions);
  const items = floorOnly
    ? view.items.filter(
        (item) =>
          item.status === "Available" || item.status === "Varies" || item.status === "SoldOut",
      )
    : view.items;
  const send = async (fresh: AvailabilityCommand, done: string) => {
    if (!client.command) return;
    const command =
      pending !== null &&
      pending.action === fresh.action &&
      pending.skuReference === fresh.skuReference
        ? pending
        : fresh;
    setBusy(true);
    setMessage(null);
    setPending(command);
    try {
      await client.command(command);
      setPending(null);
      setMessage({ tone: "neutral", text: done });
      reload();
    } catch (error) {
      const code = error instanceof AvailabilityPageError ? error.code : "Unavailable";
      if (code !== "Offline" && code !== "Unavailable") setPending(null);
      setMessage({ tone: "error", text: copy[code] });
    } finally {
      setBusy(false);
    }
  };
  const label = (item: AvailabilityItem) =>
    item.sizeName === item.productName
      ? item.productName
      : `${item.productName} — ${item.sizeName}`;
  const actions = (item: AvailabilityItem) => {
    const command = (action: "Offer" | "StopOffering" | "BackInStock") => ({
      action,
      operationReference: newOperationReference(),
      skuReference: item.skuReference,
    });
    const soldOut = (until: "EndOfDay" | "UntilBack") => ({
      action: "SoldOut" as const,
      operationReference: newOperationReference(),
      skuReference: item.skuReference,
      until,
    });
    const button = (key: string, text: string, fresh: AvailabilityCommand, done: string) => (
      <button key={key} type="button" disabled={busy} onClick={() => void send(fresh, done)}>
        {text}
      </button>
    );
    const buttons = availabilityActions(item, view.permissions).map((action) => {
      switch (action) {
        case "SoldOutToday":
          return button(
            "eod",
            "Sold out today",
            soldOut("EndOfDay"),
            `${label(item)} is sold out for today.`,
          );
        case "SoldOutUntilBack":
          return button(
            "back",
            "Sold out until further notice",
            soldOut("UntilBack"),
            `${label(item)} is sold out until you bring it back.`,
          );
        case "BackInStock":
          return button(
            "instock",
            "Back in stock",
            command("BackInStock"),
            `${label(item)} is back in stock.`,
          );
        case "ManagerBringsBack":
          return (
            <span key="manager" className="availability-note">
              A manager marked this sold out until further notice. Ask a manager to bring it back.
            </span>
          );
        case "Offer":
          return button(
            "offer",
            "Offer at this Store",
            command("Offer"),
            `${label(item)} is now offered at this Store.`,
          );
        case "StopOffering":
          return button(
            "stop",
            "Stop offering",
            command("StopOffering"),
            `${label(item)} is no longer offered at this Store.`,
          );
      }
    });
    return buttons;
  };
  return (
    <AppFrame title="Item availability" description="">
      <header className="screen-heading">
        <div>
          <p className="bop-eyebrow">Item availability · Store</p>
          <h2>Item availability</h2>
          {floorOnly ? (
            <p>
              Ran out of something? Mark it sold out and customers can no longer order it. It comes
              back by itself when today's business day ends, or when you mark it back in stock.
              Source as of <SourceTime instant={view.sourceAsOf} />
            </p>
          ) : (
            <p>
              Customers can order an item on a published menu only where it is offered and not sold
              out; ingredient stock is checked again when they order. Source as of{" "}
              <SourceTime instant={view.sourceAsOf} />
            </p>
          )}
        </div>
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
      {items.length === 0 ? (
        <StatePanel heading="No items" status>
          <p>
            {floorOnly
              ? "No items are sold at this Store right now."
              : "The Brand has no active items yet. Create products under Products."}
          </p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              {floorOnly ? null : <th>Code</th>}
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.skuReference}>
                <td>{label(item)}</td>
                {floorOnly ? null : <td data-label="Code">{item.skuCode}</td>}
                <td data-label="Status">
                  {item.status === "SoldOut"
                    ? soldOutText(item.soldOutUntil, view.timeZone)
                    : statusText[item.status]}
                </td>
                <td>{actions(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppFrame>
  );
}
