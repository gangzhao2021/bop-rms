import { t } from "./i18n/i18n.js";
/**
 * WP-2423 (DEC-ORDER-CHANNEL-LABEL): the one staff-facing mapping of how an order came in, shared
 * by the Orders list and the Operational dashboard. Staff never see stored channel codes.
 *
 * Stored source channels: Qr and Web are both a customer ordering on their own phone or computer
 * (the customer app records pickup carts as Qr whichever link or code opened the Store's page);
 * Pos is the counter; Api a partner integration. Staff think of a pickup ordered that way as
 * "Online" and of a table's guests ordering as "Table QR code", so Web is never shown on its own.
 */
export const orderTypeLabel = { DineIn: "Dine-in", Pickup: "Pickup" } as const;

/**
 * The channel an order is listed and filtered under, as staff think of it. A table's Order takes
 * the channel of its first round: when staff entered that round for the table it is "Staff" (taken
 * by staff), otherwise the guests' table QR code ("TableQr"); later rounds keep their own "Entered
 * by staff" marker. A pickup Order a customer placed on their own device is "Online".
 */
export function orderChannel(order: {
  readonly orderType: string;
  readonly sourceChannel: string;
  readonly batches: readonly { readonly sequence: number; readonly staffRound?: unknown }[];
}): string {
  const customer = order.sourceChannel === "Qr" || order.sourceChannel === "Web";
  if (order.orderType === "Pickup") return customer ? "Online" : order.sourceChannel;
  if (order.batches.find((batch) => batch.sequence === 1)?.staffRound != null) return "Staff";
  return customer ? "TableQr" : order.sourceChannel;
}

/** Staff-facing words for a channel from {@link orderChannel} (never codes). */
export function orderChannelLabel(channel: string): string {
  switch (channel) {
    case "Staff":
      return "Taken by staff";
    case "Online":
    case "Web":
      return "Online";
    case "TableQr":
    case "Qr":
      return "Table QR code";
    case "Pos":
      return "Counter";
    case "Api":
      return "Partner integration";
    default:
      return "Other";
  }
}

/** The Orders list's channel filter: every channel {@link orderChannel} gives, in staff words. */
export const orderChannelFilterOptions = Object.freeze(
  (["Online", "Pos", "TableQr", "Staff", "Api"] as const).map((value) =>
    Object.freeze({ value, label: orderChannelLabel(value) }),
  ),
);

/**
 * A filter on the stored source channel (reports, not split by who entered a table's round), in
 * the same words: Qr and Web are "Online" for pickup and "Table QR code" for dine-in.
 */
export function sourceChannelFilterLabel(
  sourceChannel: "All" | "Api" | "Pos" | "Qr" | "Web",
  orderType: "All" | "DineIn" | "Pickup",
): string {
  if (sourceChannel === "All") return t("All channels");
  if (sourceChannel === "Pos" || sourceChannel === "Api") return orderChannelLabel(sourceChannel);
  if (orderType === "Pickup") return orderChannelLabel("Online");
  if (orderType === "DineIn") return orderChannelLabel("TableQr");
  return t("Online or table QR code");
}
