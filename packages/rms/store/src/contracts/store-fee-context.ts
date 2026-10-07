/** Store fee intent is configuration, not a rate or current qualification. */
export type StoreFeeOrderType = "DineIn" | "Pickup" | "Delivery";
export type StoreFeeContext =
  | Readonly<{
      chargeType: "ServiceCharge" | "DeliveryFee" | "Tip";
      state: "Unconfigured" | "Disabled";
    }>
  | Readonly<{
      chargeType: "ServiceCharge" | "DeliveryFee" | "Tip";
      state: "Enabled";
      taxClassificationReference: string;
      orderTypes: readonly StoreFeeOrderType[];
    }>;
export type StoreCompleteFeeContext =
  | Readonly<{ chargeType: "ServiceCharge" | "DeliveryFee" | "Tip"; state: "Disabled" }>
  | Extract<StoreFeeContext, { state: "Enabled" }>;
const fail = (): never => {
  throw new Error("STORE_FEE_CONTEXT_INVALID");
};
const charges = ["ServiceCharge", "DeliveryFee", "Tip"] as const;
const modes: readonly StoreFeeOrderType[] = ["DineIn", "Pickup", "Delivery"];
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    return d?.enumerable && "value" in d ? d.value : fail();
  });
}
export function parseStoreFeeContexts(value: unknown): readonly StoreFeeContext[] {
  const values = array(value, 3);
  if (values.length !== 3) return fail();
  return Object.freeze(
    charges.map((chargeType, index): StoreFeeContext => {
      const raw = values[index];
      const state =
        raw && typeof raw === "object"
          ? Object.getOwnPropertyDescriptor(raw, "state")?.value
          : undefined;
      const r = closed(
        raw,
        state === "Enabled"
          ? ["chargeType", "state", "taxClassificationReference", "orderTypes"]
          : ["chargeType", "state"],
      );
      if (r.chargeType !== chargeType) return fail();
      if (r.state === "Unconfigured" || r.state === "Disabled")
        return Object.freeze({ chargeType, state: r.state });
      const orders = array(r.orderTypes, 3);
      if (
        r.state !== "Enabled" ||
        orders.length === 0 ||
        new Set(orders).size !== orders.length ||
        orders.some((v) => !modes.some((mode) => mode === v)) ||
        typeof r.taxClassificationReference !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          r.taxClassificationReference,
        )
      )
        return fail();
      return Object.freeze({
        chargeType,
        state: "Enabled",
        taxClassificationReference: r.taxClassificationReference,
        orderTypes: Object.freeze(modes.filter((mode) => orders.includes(mode))),
      });
    }),
  );
}
export function parseStoreCompleteFeeContexts(value: unknown): readonly StoreCompleteFeeContext[] {
  return Object.freeze(
    parseStoreFeeContexts(value).map((entry): StoreCompleteFeeContext => {
      if (entry.state === "Unconfigured") return fail();
      if (entry.state === "Disabled")
        return Object.freeze({ chargeType: entry.chargeType, state: "Disabled" });
      if (entry.state !== "Enabled") return fail();
      return entry;
    }),
  );
}
