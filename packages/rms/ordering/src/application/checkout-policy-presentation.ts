import { readClosedRecord } from "@bop/identity";
import { CartError, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import {
  parseCheckoutPolicyAcknowledgements,
  type CheckoutPolicyAcknowledgement,
} from "../domain/checkout-details.js";
import type { CheckoutDetailsPorts } from "./checkout-details-service.js";

export interface CheckoutPolicyDocumentPort {
  read(
    input: Readonly<{
      brandReference: string;
      storeReference: string;
      orderType: "DineIn" | "Pickup";
      document: CheckoutPolicyAcknowledgement;
      observedAt: string;
    }>,
  ): Promise<Readonly<{
    brandReference: string;
    storeReference: string;
    orderType: "DineIn" | "Pickup";
    document: CheckoutPolicyAcknowledgement;
    title: string;
    bodyText: string;
    checkedAt: string;
    validUntil: string;
  }> | null>;
}
export interface CheckoutPolicyPresentation {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly orderType: "DineIn" | "Pickup";
  readonly checkedAt: string;
  readonly validUntil: string;
  readonly documents: readonly (CheckoutPolicyAcknowledgement &
    Readonly<{ title: string; bodyText: string }>)[];
}
const fail = (): never => {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
};
const key = (items: readonly CheckoutPolicyAcknowledgement[]) =>
  JSON.stringify([...items].sort((a, b) => a.documentReference.localeCompare(b.documentReference)));
function plain(value: unknown, maximum: number, multiline = false): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /\p{Cf}/u.test(value)
  )
    return fail();
  const controls = multiline
    ? Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10) || code === 127;
      })
    : /\p{Cc}/u.test(value);
  if (controls) return fail();
  return value;
}

/** Internal source capability. The caller authorizes current checkout before and after this read. */
export function createCheckoutPolicyPresentationSource(
  ports: Readonly<{
    now: () => string;
    policies: CheckoutDetailsPorts["policies"];
    documents: CheckoutPolicyDocumentPort | undefined;
  }>,
) {
  return Object.freeze({
    async read(value: unknown): Promise<CheckoutPolicyPresentation> {
      try {
        const raw = readClosedRecord(value, [
          "brandReference",
          "storeReference",
          "cartReference",
          "cartVersion",
          "orderType",
        ]);
        const brandReference = parseOrderingReference(raw.brandReference),
          storeReference = parseOrderingReference(raw.storeReference);
        const cartReference = parseOrderingReference(raw.cartReference);
        if (
          !Number.isSafeInteger(raw.cartVersion) ||
          Number(raw.cartVersion) < 1 ||
          Number(raw.cartVersion) > 2147483647 ||
          (raw.orderType !== "DineIn" && raw.orderType !== "Pickup")
        )
          return fail();
        const orderType = raw.orderType;
        let previous: string | undefined;
        const now = () => {
          const at = parseOrderingInstant(ports.now());
          if (previous !== undefined && at < previous) return fail();
          previous = at;
          return at;
        };
        const current = async () => {
          const at = now();
          const found = await ports.policies.current({
            brandReference,
            storeReference,
            orderType,
            observedAt: at,
          });
          const policy = readClosedRecord(found, [
            "brandReference",
            "storeReference",
            "orderType",
            "checkedAt",
            "validUntil",
            "required",
          ]);
          const checkedAt = parseOrderingInstant(policy.checkedAt),
            validUntil = parseOrderingInstant(policy.validUntil);
          if (
            policy.brandReference !== brandReference ||
            policy.storeReference !== storeReference ||
            policy.orderType !== orderType ||
            checkedAt !== at ||
            validUntil <= now()
          )
            return fail();
          return {
            checkedAt,
            validUntil,
            required: parseCheckoutPolicyAcknowledgements(policy.required),
          };
        };
        const first = await current();
        let validUntil: string = first.validUntil;
        const documents: CheckoutPolicyPresentation["documents"][number][] = [];
        for (const document of first.required) {
          if (ports.documents === undefined) return fail();
          const at = now();
          const found = await ports.documents.read({
            brandReference,
            storeReference,
            orderType,
            document,
            observedAt: at,
          });
          const raw = readClosedRecord(found, [
            "brandReference",
            "storeReference",
            "orderType",
            "document",
            "title",
            "bodyText",
            "checkedAt",
            "validUntil",
          ]);
          const matching = parseCheckoutPolicyAcknowledgements([raw.document]);
          const checkedAt = parseOrderingInstant(raw.checkedAt),
            expires = parseOrderingInstant(raw.validUntil);
          if (
            raw.brandReference !== brandReference ||
            raw.storeReference !== storeReference ||
            raw.orderType !== orderType ||
            key(matching) !== key([document]) ||
            checkedAt !== at ||
            expires <= now()
          )
            return fail();
          validUntil = expires < validUntil ? expires : validUntil;
          documents.push(
            Object.freeze({
              ...document,
              title: plain(raw.title, 200),
              bodyText: plain(raw.bodyText, 20000, true),
            }),
          );
        }
        const last = await current();
        if (key(first.required) !== key(last.required)) return fail();
        validUntil = last.validUntil < validUntil ? last.validUntil : validUntil;
        if (now() >= validUntil) return fail();
        return Object.freeze({
          cartReference,
          cartVersion: Number(raw.cartVersion),
          orderType,
          checkedAt: first.checkedAt,
          validUntil,
          documents: Object.freeze(documents),
        });
      } catch {
        return fail();
      }
    },
  });
}
