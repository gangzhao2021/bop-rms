import { readClosedRecord } from "@bop/identity";
import {
  parseStoreSetupReferenceSave,
  parseStoreSetupReferenceResolve,
  StoreSetupReferenceError,
  type StoreSetupReferenceKind,
  type StoreSetupReferenceSave,
} from "@rms/store";

type Scope = Pick<
  StoreSetupReferenceSave,
  "tenantReference" | "brandReference" | "storeReference" | "actorReference"
>;

/** The expected header pins intent. Only the acquired ordinary Session scope
 * supplies authority; browser bodies never supply identity or result IDs. */
export function bindMerchantStoreSetupReferenceCommand(
  raw: unknown,
  scope: Scope,
  kind: StoreSetupReferenceKind,
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
      "expectedReference",
      "expectedRevision",
      action.value === "SaveReference" ? "content" : "intentDigest",
    ]);
    const identity = {
      ...fixed,
      kind,
      operationReference: body.operationReference,
      expectedReference: body.expectedReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "STORE_SETUP_REFERENCE",
    };
    if (body.command === "SaveReference")
      return Object.freeze({
        method: "save" as const,
        command: parseStoreSetupReferenceSave({
          profile: "StoreSetupReferenceSaveV1",
          ...identity,
          content: body.content,
        }),
      });
    if (body.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseStoreSetupReferenceResolve({
          profile: "StoreSetupReferenceResolveV1",
          ...identity,
          intentDigest: body.intentDigest,
        }),
      });
    throw new Error("invalid");
  } catch {
    throw new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID");
  }
}
