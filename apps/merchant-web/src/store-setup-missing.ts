import { t } from "./i18n/i18n.js";
import type { StoreSetupContent } from "./store-setup-client.js";

/**
 * WP-2423 (v15): every Store setup setting that is not set yet, in staff words, with where it is
 * set (the step number and name as on screen, or "Settings from the live Store" in step 8). Review
 * counts and lists exactly these; the publication panel names them when it cannot create a
 * configuration from an unfinished setup.
 */
export interface StoreSetupMissingItem {
  readonly label: string;
  readonly where: string;
}
const step = (n: number, name: string) => t("step {n}, {name}", { n: n, name: name });
/**
 * b18 (Owner 2026-11-14): where each setting is set. A Store being opened walks all eight steps; an
 * open Store's "Settings that need approval" shows only the four that need approval there, and
 * its opening hours are changed in Hours & ordering, its name, address and phone in Store details.
 */
export type StoreSetupLayout = "Opening" | "Open";
export type StoreSetupFieldPlace =
  | "source"
  | "timeZone"
  | "address"
  | "serviceModes"
  | "hours"
  | "payment"
  | "capacity"
  | "contact"
  | "live";
export function storeSetupWhere(layout: StoreSetupLayout, field: StoreSetupFieldPlace): string {
  if (layout === "Open")
    switch (field) {
      case "timeZone":
        return step(1, t("Time zone and business day"));
      case "source":
      case "serviceModes":
      case "capacity":
        return step(2, t("Services"));
      case "payment":
        return step(3, t("Fees, tax and payment"));
      case "hours":
        return t("Hours & ordering");
      case "address":
      case "contact":
        return t("step 4, Review and publish, under “Still needed”");
      case "live":
        return t("step 4: Use the live Store’s settings");
    }
  switch (field) {
    case "source":
      return step(3, t("Service modes"));
    case "timeZone":
    case "address":
      return step(2, t("Address and timezone"));
    case "serviceModes":
      return step(3, t("Service modes"));
    case "hours":
      return step(4, t("Hours"));
    case "payment":
      return step(5, t("Tax and payment"));
    case "capacity":
      return step(6, t("Capacity"));
    case "contact":
      return step(7, t("Contacts"));
    case "live":
      return t("step 8: Use the live Store’s settings");
  }
}
/** b24: said in the language in use when asked (not when this module loaded). */
const feeName = (chargeType: string) =>
  chargeType === "ServiceCharge"
    ? t("Service charge")
    : chargeType === "DeliveryFee"
      ? t("Delivery fee")
      : chargeType === "Tip"
        ? t("Tip")
        : t("Fees");
/** "Service charge", "Delivery fee", "Tip" in staff words. */
export const storeSetupFeeName = feeName;
export function storeSetupMissingItems(
  content: StoreSetupContent,
  layout: StoreSetupLayout = "Opening",
): readonly StoreSetupMissingItem[] {
  const missing: StoreSetupMissingItem[] = [];
  const unset = (value: { readonly state: string } | undefined) =>
    value === undefined || value.state !== "Configured";
  const where = (field: StoreSetupFieldPlace) => storeSetupWhere(layout, field);
  const add = (condition: boolean, label: string, field: StoreSetupFieldPlace) => {
    if (condition) missing.push(Object.freeze({ label, where: where(field) }));
  };
  add(unset(content.source), t("Brand or Store settings"), "source");
  add(unset(content.timeZone), t("Time zone"), "timeZone");
  add(unset(content.businessDayStartLocalTime), t("Business day start"), "timeZone");
  add(unset(content.addressReference), t("Address"), "address");
  add(unset(content.enabledServiceModes), t("Service modes"), "serviceModes");
  add(unset(content.weeklySchedule), t("Weekly hours"), "hours");
  if (content.feeContexts?.state === "Configured")
    for (const fee of content.feeContexts.value)
      add(fee.state === "Unconfigured", feeName(fee.chargeType), "payment");
  else add(true, t("Fees"), "payment");
  add(unset(content.paymentConfigurationReference), t("Payment settings"), "payment");
  add(unset(content.receiptReference), t("Receipt template"), "payment");
  add(unset(content.capacityConfigurationReference), t("Order limits"), "capacity");
  add(unset(content.contactReference), t("Contact details"), "contact");
  add(unset(content.taxConfigurationReference), t("Tax settings"), "live");
  add(unset(content.brandBaseVersionReference), t("Brand settings"), "live");
  add(unset(content.exceptions), t("Holidays and special hours"), "live");
  add(
    unset(content.effectiveFrom) || unset(content.effectiveUntil),
    t("When it takes effect"),
    "live",
  );
  return Object.freeze(missing);
}
/**
 * b24 (Owner 2026-11-16 "服务费的订单类型为什么可以勾选服务方式没有勾选的选项？"): a fee that is on
 * may only apply to orders the setup offers (its services, step 2). Each fee that names an order
 * type the setup does not offer, with those order types. `offered` defaults to the setup's own
 * services; the setup page passes the services as edited, saved or not.
 */
export function storeSetupFeesNotOffered(
  content: StoreSetupContent,
  offered: readonly string[] = content.enabledServiceModes.state === "Configured"
    ? content.enabledServiceModes.value
    : [],
): readonly { readonly chargeType: string; readonly modes: readonly string[] }[] {
  if (content.feeContexts?.state !== "Configured") return [];
  return content.feeContexts.value.flatMap((fee) => {
    if (fee.state !== "Enabled") return [];
    const modes = fee.orderTypes.filter((mode) => !offered.includes(mode));
    return modes.length === 0 ? [] : [Object.freeze({ chargeType: fee.chargeType, modes })];
  });
}
/** "Address (step 2, …), Receipt template (step 5, …)" for one sentence. */
export function storeSetupMissingText(items: readonly StoreSetupMissingItem[]): string {
  return items.map((item) => `${item.label} (${item.where})`).join("; ");
}
/** "04:00" for 04:00:00; a time with seconds other than zero is shown whole. */
const startText = (value: string) => (/^\d{2}:\d{2}:00$/u.test(value) ? value.slice(0, 5) : value);
const withSeconds = (value: string) => (/^\d{2}:\d{2}$/u.test(value) ? value + ":00" : value);
/**
 * b22 (v15 live check of b21): a Store that already runs keeps its business day start, so past
 * business days and reports keep their boundaries (DEC-STORE-SETUP-PUBLICATION, the
 * BusinessDayStart publication check). A setup that starts the day at another time can never be
 * sent for approval, so it is named before a change is created from it: the setup's start and the
 * one the Store runs on now, or null when the setup keeps it (or nothing runs yet to compare with).
 */
export function storeSetupBusinessStartChange(
  start: string | null,
  current: { readonly businessDayStartLocalTime: string } | null | undefined,
): { readonly setup: string; readonly now: string } | null {
  if (start === null || start === "" || current === null || current === undefined) return null;
  return withSeconds(start) === withSeconds(current.businessDayStartLocalTime)
    ? null
    : { setup: startText(withSeconds(start)), now: startText(current.businessDayStartLocalTime) };
}
