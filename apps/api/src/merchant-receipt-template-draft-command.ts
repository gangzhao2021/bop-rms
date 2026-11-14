import { readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateDraftSave,
  parseDigitalReceiptTemplateDraftResolve,
} from "@rms/printing-device";

/** Browser controls editable fields and CAS intent only. Scope, purpose and
 * all new Template, Family and Version identities come from the real server. */
export function bindMerchantReceiptTemplateDraftCommand(
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
    const body = readClosedRecord(raw, [
      "command",
      "operationReference",
      "templateReference",
      "expectedVersionReference",
      "expectedRevision",
      descriptor.value === "SaveDraft" ? "fields" : "intentDigest",
    ]);
    const original = {
      ...fixed,
      operationReference: body.operationReference,
      templateReference: body.templateReference,
      expectedVersionReference: body.expectedVersionReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
    };
    if (body.command === "SaveDraft")
      return Object.freeze({
        method: "save" as const,
        command: parseDigitalReceiptTemplateDraftSave({
          profile: "DigitalReceiptTemplateDraftSaveV1",
          ...original,
          fields: body.fields,
        }),
      });
    if (body.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseDigitalReceiptTemplateDraftResolve({
          profile: "DigitalReceiptTemplateDraftResolveV1",
          ...original,
          intentDigest: body.intentDigest,
        }),
      });
    throw new Error("invalid");
  } catch {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
  }
}
