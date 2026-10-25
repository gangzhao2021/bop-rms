import { PageIntro } from "./PageIntro.js";
import { t } from "./i18n/i18n.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { AppFrame, StatePanel } from "@bop-rms/ui";
import { Link } from "react-router";
import { CheckedTime } from "./StoreTime.js";
import {
  KitchenDisplayHeaderControls,
  KitchenDisplayNavigation,
  kitchenHandoverOffered,
  KitchenSignedOutPanel,
  useKitchenHandover,
  useKitchenScreenAwake,
} from "./KitchenBoardPages.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { KitchenBoardView } from "./kitchen-board.js";
import { newOperationReference } from "./operation-reference.js";
import {
  AvailabilityPageError,
  availabilityActions,
  floorStaffOnly,
  kitchenDisplayPermissions,
  parseStoreAvailabilityView,
  soldOutText,
  stockHeldByOrders,
  stockSoldOutText,
  unavailableAvailabilityClient,
  type AvailabilityClient,
  type AvailabilityCommand,
  type AvailabilityErrorCode,
  type AvailabilityItem,
  type StoreAvailabilityView,
} from "./store-availability-page.js";

/** WP-2423 8.5: which items this Store sells now — offer, sold out, back in stock. */
const copy: Record<AvailabilityErrorCode | "Loading", string> = {
  Loading: t("Loading item availability…"),
  PermissionDenied: t(
    "You do not have permission for this. Offering items is a Brand decision; kitchen and front-of-house staff can mark items sold out for today, and a manager can mark them sold out until further notice.",
  ),
  NotFound: t("This item is no longer sold by the Brand."),
  Conflict: t(
    "The item changed since you opened the page, or is not offered here. Refresh and check.",
  ),
  Invalid: t("That request is not valid."),
  Offline: t("Offline. Nothing was confirmed; retry sends the same request again."),
  Unavailable: t("Item availability is unavailable."),
};
const statusText = {
  Available: t("Available"),
  SoldOut: t("Sold out"),
  Unavailable: t("Not available here"),
  NotOffered: t("Not offered at this Store"),
  Varies: t("Available for some order types"),
} as const;

/** The items of each product together, in the order the products first appear. */
export function groupByProduct<T extends { readonly productName: string }>(
  items: readonly T[],
): readonly { readonly productName: string; readonly items: readonly T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.productName);
    if (group) group.push(item);
    else groups.set(item.productName, [item]);
  }
  return [...groups].map(([productName, grouped]) => ({ productName, items: grouped }));
}

export function StoreAvailabilityPage({
  client = unavailableAvailabilityClient,
  navigation: workspaceNavigation,
  kitchenDisplay,
}: {
  readonly client?: AvailabilityClient;
  /** A frame navigation of the caller's own (the workspace layout supplies one otherwise). */
  readonly navigation?: ReactNode;
  /**
   * WP-2423 Q17: reached from the kitchen display, the page keeps the kitchen display's frame: the
   * Store's name, the kitchen navigation and the handover. What the sign-in may do on each item
   * still comes from the permissions the server reports with the page.
   */
  readonly kitchenDisplay?: {
    readonly storeLabel: string;
    readonly csrf: string;
    readonly soldOutHref: string;
    /** Who the kitchen board says is using this sign-in (the board's own read). */
    readonly loadOperatorStatus: () => Promise<KitchenBoardView["operatorStatus"]>;
    readonly signOut?: () => Promise<void>;
  };
}) {
  // undefined while reading; null when the read failed.
  const [operator, setOperator] = useState<KitchenBoardView["operatorStatus"] | null | undefined>(
    undefined,
  );
  // Read once when the page opens (the caller may pass a new function on every render).
  const loadOperatorStatus = useRef(kitchenDisplay?.loadOperatorStatus);
  useEffect(() => {
    const load = loadOperatorStatus.current;
    if (!load) return;
    let active = true;
    load().then(
      (status) => {
        if (active) setOperator(status);
      },
      () => {
        if (active) setOperator(null);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const { handover, handOver } = useKitchenHandover(kitchenDisplay?.csrf, kitchenDisplay?.signOut);
  const awake = useKitchenScreenAwake(kitchenDisplay !== undefined && handover !== "SignedOut");
  const frame = kitchenDisplay
    ? {
        title: kitchenDisplay.storeLabel,
        description: t("Kitchen display"),
        className: "kitchen-shell",
        navigation: (
          <KitchenDisplayNavigation current="SoldOut" soldOutHref={kitchenDisplay.soldOutHref} />
        ),
        headerStatus: (
          <KitchenDisplayHeaderControls
            handoverOffered={kitchenHandoverOffered(true, operator ?? null)}
            handover={handover}
            awake={awake}
            onHandover={handOver}
          />
        ),
      }
    : { title: t("Item availability"), description: "", navigation: workspaceNavigation };
  const navigation = frame.navigation;
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
  if (handover === "SignedOut") return <KitchenSignedOutPanel />;
  if (state.kind !== "Found") {
    const panel = (
      <StatePanel
        heading={state.kind === "PermissionDenied" ? noAccessHeading : t("Item availability")}
        tone={state.kind === "Loading" ? "neutral" : "error"}
        status
      >
        <p>{state.kind === "PermissionDenied" ? pageAccessDeniedText : copy[state.kind]}</p>
      </StatePanel>
    );
    // From the kitchen display there is no workspace frame around the page; keep the way back.
    return navigation ? <AppFrame {...frame}>{panel}</AppFrame> : panel;
  }
  const view = state.view;
  const permissions = kitchenDisplay
    ? kitchenDisplayPermissions(view.permissions, operator ?? null)
    : view.permissions;
  // WP-2423 Q17: floor staff (Kitchen, Front of House) see only items sold here.
  const floorOnly = floorStaffOnly(permissions);
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
    const kinds = availabilityActions(item, permissions);
    const buttons = kinds.map((action) => {
      switch (action) {
        case "SoldOutToday":
          return button(
            "eod",
            t("Sold out today"),
            soldOut("EndOfDay"),
            t("{item} is sold out for today.", { item: label(item) }),
          );
        case "SoldOutUntilBack":
          return button(
            "back",
            t("Sold out until further notice"),
            soldOut("UntilBack"),
            t("{item} is sold out until you bring it back.", { item: label(item) }),
          );
        case "BackInStock":
          return button(
            "instock",
            t("Back in stock"),
            command("BackInStock"),
            t("{item} is back in stock.", { item: label(item) }),
          );
        case "ManagerBringsBack":
          return (
            <span key="manager" className="availability-note">
              {t(
                "A manager marked this sold out until further notice. Ask a manager to bring it back.",
              )}
            </span>
          );
        case "Offer":
          return button(
            "offer",
            t("Offer at this Store"),
            command("Offer"),
            t("{item} is now offered at this Store.", { item: label(item) }),
          );
        case "StopOffering":
          return button(
            "stop",
            t("Stop offering"),
            command("StopOffering"),
            t("{item} is no longer offered at this Store.", { item: label(item) }),
          );
      }
    });
    // Owner 2026-10-25: one "Mark sold out" menu per size and "Stop offering" under "More",
    // instead of three equal buttons on every row.
    const pick = (wanted: readonly string[]) =>
      buttons.filter((_, index) => wanted.includes(kinds[index] ?? ""));
    const soldOutMenu = pick(["SoldOutToday", "SoldOutUntilBack"]);
    const more = pick(["StopOffering"]);
    const direct = pick(["BackInStock", "ManagerBringsBack", "Offer"]);
    return (
      <div className="availability-actions">
        {direct}
        {soldOutMenu.length === 0 ? null : (
          <details className="availability-menu">
            <summary>{t("Mark sold out")}</summary>
            <div className="availability-menu__items">{soldOutMenu}</div>
          </details>
        )}
        {more.length === 0 ? null : (
          <details className="availability-menu availability-menu--more">
            <summary aria-label={t("More for {item}", { item: label(item) })}>{t("More")}</summary>
            <div className="availability-menu__items">{more}</div>
          </details>
        )}
      </div>
    );
  };
  return (
    <AppFrame {...frame}>
      <header className="screen-heading">
        <div>
          <h2>{t("Item availability")}</h2>
          <PageIntro
            summary={
              floorOnly
                ? t("Mark a size sold out when it runs out.")
                : t("What customers can order at this Store right now.")
            }
            aside={<CheckedTime instant={view.sourceAsOf} timeZone={view.timeZone} />}
          >
            {floorOnly ? (
              <p>
                {t(
                  "Ran out of something? Mark it sold out and customers can no longer order it. It comes back by itself when today's business day ends, or when you mark it back in stock.",
                )}
              </p>
            ) : (
              <p>
                {t(
                  "Customers can order an item on a published menu only where it is offered and not sold out; ingredient stock is checked again when they order.",
                )}
              </p>
            )}
          </PageIntro>
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
      {items.length === 0 ? (
        <StatePanel heading={t("No items")} status>
          <p>
            {floorOnly
              ? t("No items are sold at this Store right now.")
              : t("The Brand has no active items yet. Create products under Products.")}
          </p>
        </StatePanel>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("Item")}</th>
              <th>{t("Status")}</th>
              <th aria-label={t("Actions")} />
            </tr>
          </thead>
          {/* Owner 2026-10-25: one group per product, its sizes under it. */}
          {groupByProduct(items).map((group) => (
            <tbody key={group.productName}>
              {group.items.length > 1 ? (
                <tr className="availability-product">
                  <th colSpan={3} scope="colgroup">
                    {group.productName}
                  </th>
                </tr>
              ) : null}
              {group.items.map((item) => (
                <tr key={item.skuReference}>
                  <td>{group.items.length > 1 ? item.sizeName : label(item)}</td>
                  <td data-label={t("Status")}>
                    {item.status === "SoldOut"
                      ? soldOutText(item.soldOutUntil, view.timeZone)
                      : item.stockSoldOut != null &&
                          (item.status === "Available" || item.status === "Varies")
                        ? t("Sold out to guests (stock)")
                        : statusText[item.status]}
                    {item.stockSoldOut != null &&
                    (item.status === "Available" || item.status === "Varies") ? (
                      <p className="availability-note">
                        {stockSoldOutText(item.stockSoldOut)}{" "}
                        {stockHeldByOrders(item.stockSoldOut) ? (
                          <Link to="/operations/orders">{t("See Orders")}</Link>
                        ) : (
                          // v15 aa3d9fac D3: stock comes back by recording the delivery or
                          // correcting the count (there is no separate stock overview screen).
                          <>
                            <Link to="/operations/receiving">{t("Record a delivery")}</Link>{" "}
                            {t("or")}{" "}
                            <Link to="/operations/inventory/counts">{t("count the stock")}</Link>
                          </>
                        )}
                      </p>
                    ) : null}
                  </td>
                  <td>{actions(item)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </AppFrame>
  );
}
