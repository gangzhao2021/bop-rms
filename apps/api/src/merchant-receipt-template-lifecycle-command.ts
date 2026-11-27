import { readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleResolve,
} from "@rms/printing-device";

/** Identity and purpose come from the acquired server context. The browser pins
 * the reviewed version and head; it cannot supply approval evidence or expiry. */
export function bindMerchantReceiptTemplateLifecycleCommand(
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
      "reviewLifecycleReference",
      "expectedReviewVersion",
      "expectedReviewOperationReference",
    ];
    const resolving = descriptor.value === "ResolveOriginal";
    const body = readClosedRecord(raw, resolving ? [...keys, "action", "intentDigest"] : keys);
    const action = resolving ? body.action : body.command;
    if (action !== "Approve" && action !== "Publish") throw new Error("invalid");
    const original = {
      ...fixed,
      action,
      operationReference: body.operationReference,
      templateReference: body.templateReference,
      expectedVersionReference: body.expectedVersionReference,
      expectedRevision: body.expectedRevision,
      reviewLifecycleReference: body.reviewLifecycleReference,
      expectedReviewVersion: body.expectedReviewVersion,
      expectedReviewOperationReference: body.expectedReviewOperationReference,
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    };
    if (resolving)
      return Object.freeze({
        method: "resolve" as const,
        command: parseDigitalReceiptTemplateLifecycleResolve({
          profile: "DigitalReceiptTemplateLifecycleResolveV1",
          ...original,
          intentDigest: body.intentDigest,
        }),
      });
    return Object.freeze({
      method: "execute" as const,
      command: parseDigitalReceiptTemplateLifecycleAction({
        profile: "DigitalReceiptTemplateLifecycleActionV1",
        ...original,
      }),
    });
  } catch {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
  }
}
