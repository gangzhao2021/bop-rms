import { assertGuestSessionUsable, createGuestSession } from "@bop/identity";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import { DigitalReceiptError, parseDigitalReceiptChain } from "../domain/digital-receipt.js";
import type { DigitalReceiptQueryPorts } from "./ports/digital-receipt-ports.js";

function fail(code: DigitalReceiptError["code"]): never {
  throw new DigitalReceiptError(code);
}

function input(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("DIGITAL_RECEIPT_INPUT_INVALID");
  const fields = ["orderReference", "observedAt", "resumeGrantReference"];
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("DIGITAL_RECEIPT_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    fields.some(
      (field) => !descriptors[field] || descriptors[field]?.get || descriptors[field]?.set,
    )
  )
    return fail("DIGITAL_RECEIPT_INPUT_INVALID");
  let orderReference, observedAt;
  try {
    orderReference = parseOrderingReference(descriptors.orderReference?.value);
    observedAt = parseOrderingInstant(descriptors.observedAt?.value);
  } catch {
    return fail("DIGITAL_RECEIPT_INPUT_INVALID");
  }
  const resume = descriptors.resumeGrantReference?.value;
  if (resume !== null && typeof resume !== "string") return fail("DIGITAL_RECEIPT_INPUT_INVALID");
  let resumeGrantReference: string | null = null;
  if (resume !== null) {
    try {
      resumeGrantReference = parseOrderingReference(resume);
    } catch {
      return fail("DIGITAL_RECEIPT_INPUT_INVALID");
    }
  }
  return Object.freeze({ orderReference, observedAt, resumeGrantReference });
}

export function createDigitalReceiptQueryService(ports: DigitalReceiptQueryPorts) {
  return Object.freeze({
    async getCustomer(value: unknown) {
      const request = input(value);
      let authorization:
        | {
            readonly guestSessionReference: string;
            readonly brandReference: string;
            readonly storeReference: string;
          }
        | undefined;
      try {
        if (request.resumeGrantReference) {
          const grant = await ports.authorization.authorizeResume({
            orderReference: request.orderReference,
            observedAt: request.observedAt,
            resumeGrantReference: request.resumeGrantReference,
          });
          if (grant && grant.orderReference === request.orderReference)
            authorization = {
              guestSessionReference: "resume-grant",
              brandReference: parseOrderingReference(grant.brandReference),
              storeReference: parseOrderingReference(grant.storeReference),
            };
        } else {
          const result = await ports.authorization.authorizeGuest({
            orderReference: request.orderReference,
            observedAt: request.observedAt,
          });
          if (result) {
            const session = assertGuestSessionUsable(
              createGuestSession(result.guestSession),
              request.observedAt,
            );
            authorization = {
              guestSessionReference: parseOrderingReference(session.sessionReference),
              brandReference: parseOrderingReference(session.brandReference),
              storeReference: parseOrderingReference(session.storeReference),
            };
          }
        }
      } catch {
        return fail("DIGITAL_RECEIPT_PERMISSION_DENIED");
      }
      if (!authorization) return fail("DIGITAL_RECEIPT_PERMISSION_DENIED");
      let chain;
      try {
        const value = await ports.receipts.load(request.orderReference);
        if (!value) return fail("DIGITAL_RECEIPT_NOT_FOUND");
        chain = parseDigitalReceiptChain(value);
      } catch (error) {
        if (error instanceof DigitalReceiptError) throw error;
        return fail("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
      }
      const first = chain.records[0]?.snapshot;
      if (
        !first ||
        first.brandReference !== authorization.brandReference ||
        first.storeReference !== authorization.storeReference ||
        (authorization.guestSessionReference !== "resume-grant" &&
          first.guestSessionReference !== authorization.guestSessionReference)
      )
        return fail("DIGITAL_RECEIPT_PERMISSION_DENIED");
      return chain;
    },
  });
}
