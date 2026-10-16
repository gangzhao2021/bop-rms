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
const step = (n: number, name: string) => `step ${n}, ${name}`;
const live = "step 8: Use the live Store’s settings";
const feeNames: Readonly<Record<string, string>> = Object.freeze({
  ServiceCharge: "Service charge",
  DeliveryFee: "Delivery fee",
  Tip: "Tip",
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
  add(unset(content.source), "Brand or Store settings", step(1, "Identity"));
  add(unset(content.timeZone), "Time zone", step(2, "Address and timezone"));
  add(
    unset(content.businessDayStartLocalTime),
    "Business day start",
    step(2, "Address and timezone"),
  );
  add(unset(content.addressReference), "Address", step(2, "Address and timezone"));
  add(unset(content.enabledServiceModes), "Service modes", step(3, "Service modes"));
  add(unset(content.weeklySchedule), "Weekly hours", step(4, "Hours"));
  if (content.feeContexts?.state === "Configured")
    for (const fee of content.feeContexts.value)
      add(
        fee.state === "Unconfigured",
        feeNames[fee.chargeType] ?? "Fee",
        step(5, "Tax and payment"),
      );
  else add(true, "Fees", step(5, "Tax and payment"));
  add(unset(content.paymentConfigurationReference), "Payment settings", step(5, "Tax and payment"));
  add(unset(content.receiptReference), "Receipt template", step(5, "Tax and payment"));
  add(unset(content.capacityConfigurationReference), "Order limits", step(6, "Capacity"));
  add(unset(content.contactReference), "Contact details", step(7, "Contacts"));
  add(unset(content.taxConfigurationReference), "Tax settings", live);
  add(unset(content.brandBaseVersionReference), "Brand settings", live);
  add(unset(content.exceptions), "Holidays and special hours", live);
  add(unset(content.effectiveFrom) || unset(content.effectiveUntil), "When it takes effect", live);
  return Object.freeze(missing);
}
/** "Address (step 2, …), Receipt template (step 5, …)" for one sentence. */
export function storeSetupMissingText(items: readonly StoreSetupMissingItem[]): string {
  return items.map((item) => `${item.label} (${item.where})`).join("; ");
}
