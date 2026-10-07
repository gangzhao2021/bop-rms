import { readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitResolve,
} from "@rms/printing-device";

/** Binds an original draft CAS intent to the already acquired server identity.
 * Parsing supplies no permission, review identity, business expiry or approval. */
export function bindMerchantReceiptTemplateSubmitCommand(
  raw: unknown,
  scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
  }>,
) {
  try {
    const fixed = readClosedRecord(scope, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    const descriptor =
      raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "command") : undefined;
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid");
    const keys = [
      "command",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
    ];
    const body = readClosedRecord(
      raw,
      descriptor.value === "ResolveOriginal" ? [...keys, "intentDigest"] : keys,
    );
    const original = {
      ...fixed,
      operationReference: body.operationReference,
      templateReference: body.templateReference,
      expectedVersionReference: body.expectedVersionReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    };
    if (body.command === "SubmitReview")
      return Object.freeze({
        method: "submit" as const,
        command: parseDigitalReceiptTemplateSubmit({
          profile: "DigitalReceiptTemplateSubmitV1",
          ...original,
        }),
      });
    if (body.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseDigitalReceiptTemplateSubmitResolve({
          profile: "DigitalReceiptTemplateSubmitResolveV1",
          ...original,
          intentDigest: body.intentDigest,
        }),
      });
    throw new Error("invalid");
  } catch {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
  }
}
