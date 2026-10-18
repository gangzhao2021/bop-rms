import { readClosedRecord } from "@bop/identity";
import {
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationResolve,
  StorePaymentConfigurationError,
} from "@rms/payment";

type Scope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  actorReference: string;
}>;

/** Caller supplies current Session authority. Browser expected scope only pins
 * intent; browser bodies never supply result IDs or Provider authority. */
export function bindMerchantStorePaymentConfigurationCommand(raw: unknown, scope: Scope) {
  try {
    const fixed = readClosedRecord(scope, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    const action =
      raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "command") : undefined;
    if (!action?.enumerable || !("value" in action)) throw new Error("Invalid command");
    const body = readClosedRecord(raw, [
      "command",
      "operationReference",
      "expectedConfigurationReference",
      "expectedRevision",
      action.value === "SaveConfiguration" ? "content" : "intentDigest",
    ]);
    const identity = {
      ...fixed,
      operationReference: body.operationReference,
      expectedConfigurationReference: body.expectedConfigurationReference,
      expectedRevision: body.expectedRevision,
      purposeCode: "STORE_PAYMENT_CONFIGURATION",
    };
    if (body.command === "SaveConfiguration")
      return Object.freeze({
        method: "save" as const,
        command: parseStorePaymentConfigurationSave({
          profile: "StorePaymentConfigurationSaveV1",
          ...identity,
          content: body.content,
        }),
      });
    if (body.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseStorePaymentConfigurationResolve({
          profile: "StorePaymentConfigurationResolveV1",
          ...identity,
          intentDigest: body.intentDigest,
        }),
      });
    throw new Error("Invalid command");
  } catch {
    throw new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID");
  }
}
