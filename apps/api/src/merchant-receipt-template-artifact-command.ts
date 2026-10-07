import { readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactResolve,
  type DigitalReceiptTemplateArtifactKind,
} from "@rms/printing-device";

/** Browser supplies intent and pins only; scope and purpose come from the
 * currently acquired Session. Artifact registration is not legal approval. */
export function bindMerchantReceiptTemplateArtifactCommand(
  raw: unknown,
  scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
  }>,
  artifactKind: DigitalReceiptTemplateArtifactKind,
) {
  try {
    const fixed = readClosedRecord(scope, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    const action =
      raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "command") : undefined;
    if (!action?.enumerable || !("value" in action)) throw new Error("invalid");
    const body = readClosedRecord(raw, [
      "command",
      "operationReference",
      "expectedArtifactReference",
      "expectedRevision",
      action.value === "SaveArtifact" ? "content" : "intentDigest",
    ]);
    const original = {
      ...fixed,
      artifactKind,
      operationReference: body.operationReference,
      expectedArtifactReference: body.expectedArtifactReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
    };
    if (body.command === "SaveArtifact")
      return Object.freeze({
        method: "save" as const,
        command: parseDigitalReceiptTemplateArtifactSave({
          profile: "DigitalReceiptTemplateArtifactSaveV1",
          ...original,
          content: body.content,
        }),
      });
    if (body.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseDigitalReceiptTemplateArtifactResolve({
          profile: "DigitalReceiptTemplateArtifactResolveV1",
          ...original,
          intentDigest: body.intentDigest,
        }),
      });
    throw new Error("invalid");
  } catch {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
  }
}
