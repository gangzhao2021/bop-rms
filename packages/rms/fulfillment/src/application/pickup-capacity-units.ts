import { AsapCapacityError } from "../domain/asap-capacity.js";
import { parseFulfillmentDigest } from "../domain/pickup-fulfillment.js";
import type { resolvePickupCapacityCartSource } from "@rms/ordering";
/** Section 34.37 default only. A configured weighted policy must never fall through to this rule. */
export function deriveDefaultPickupCapacityUnits(
  source: ReturnType<typeof resolvePickupCapacityCartSource>,
  policy: unknown,
  hash: (input: string) => string,
) {
  if (
    policy === null ||
    typeof policy !== "object" ||
    Object.getPrototypeOf(policy) !== Object.prototype ||
    Reflect.ownKeys(policy).length !== 2 ||
    Object.getOwnPropertyDescriptor(policy, "mode")?.value !== "PerFulfillment" ||
    Object.getOwnPropertyDescriptor(policy, "ruleVersion")?.value !== 1
  )
    throw new AsapCapacityError("ASAP_CAPACITY_UNAVAILABLE");
  const payload = JSON.stringify({
    rule: "Section34.37:PerFulfillment:v1",
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    guestSessionReference: source.guestSessionReference,
    cartReference: source.cartReference,
    cartVersion: source.cartVersion,
    quoteReference: source.quoteReference,
    quoteInputDigest: source.quoteInputDigest,
    quoteAttachmentReference: source.quoteAttachmentReference,
  });
  return Object.freeze({
    units: 1,
    unitsRuleVersion: 1,
    unitsInputDigest: parseFulfillmentDigest(hash(payload)),
  });
}
