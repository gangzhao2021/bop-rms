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
const live = t("step 8: Use the live Store’s settings");
const feeNames: Readonly<Record<string, string>> = Object.freeze({
  ServiceCharge: t("Service charge"),
  DeliveryFee: t("Delivery fee"),
  Tip: t("Tip"),
});
export function storeSetupMissingItems(
  content: StoreSetupContent,
): readonly StoreSetupMissingItem[] {
  const missing: StoreSetupMissingItem[] = [];
  const unset = (value: { readonly state: string } | undefined) =>
    value === undefined || value.state !== "Configured";
  const add = (condition: boolean, label: string, where: string) => {
    if (condition) missing.push(Object.freeze({ label, where }));
  };
  add(unset(content.source), t("Brand or Store settings"), step(1, t("Identity")));
  add(unset(content.timeZone), t("Time zone"), step(2, t("Address and timezone")));
  add(
    unset(content.businessDayStartLocalTime),
    t("Business day start"),
    step(2, t("Address and timezone")),
  );
  add(unset(content.addressReference), "Address", step(2, t("Address and timezone")));
  add(unset(content.enabledServiceModes), t("Service modes"), step(3, t("Service modes")));
  add(unset(content.weeklySchedule), t("Weekly hours"), step(4, t("Hours")));
  if (content.feeContexts?.state === "Configured")
    for (const fee of content.feeContexts.value)
      add(
        fee.state === "Unconfigured",
        feeNames[fee.chargeType] ?? "Fee",
        step(5, t("Tax and payment")),
      );
  else add(true, "Fees", step(5, t("Tax and payment")));
  add(
    unset(content.paymentConfigurationReference),
    t("Payment settings"),
    step(5, t("Tax and payment")),
  );
  add(unset(content.receiptReference), t("Receipt template"), step(5, t("Tax and payment")));
  add(unset(content.capacityConfigurationReference), t("Order limits"), step(6, t("Capacity")));
  add(unset(content.contactReference), t("Contact details"), step(7, t("Contacts")));
  add(unset(content.taxConfigurationReference), t("Tax settings"), live);
  add(unset(content.brandBaseVersionReference), t("Brand settings"), live);
  add(unset(content.exceptions), t("Holidays and special hours"), live);
  add(
    unset(content.effectiveFrom) || unset(content.effectiveUntil),
    t("When it takes effect"),
    live,
  );
  return Object.freeze(missing);
}
/** "Address (step 2, …), Receipt template (step 5, …)" for one sentence. */
export function storeSetupMissingText(items: readonly StoreSetupMissingItem[]): string {
  return items.map((item) => `${item.label} (${item.where})`).join("; ");
}
