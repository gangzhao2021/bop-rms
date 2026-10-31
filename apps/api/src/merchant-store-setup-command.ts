import {
  parseStoreSetupSaveCommand,
  parseStoreSetupResolveCommand,
  StoreSetupOperationError,
  type StoreSetupOperationScope,
} from "@rms/store";

const invalid = (): never => {
  throw new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  const entries = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    return [key, descriptor.value] as const;
  });
  return Object.fromEntries(entries);
}

/** Bind only to the already acquired actual scope. This is not authorization.
 * The parsed Save command is the complete original intent used by the owning
 * canonicalize/hashIntent ports; this transport adds no clocks or identifiers.
 */
export function bindMerchantStoreSetupCommand(raw: unknown, actualScope: StoreSetupOperationScope) {
  try {
    const scope = closed(actualScope, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    const input = closed(raw, [
      "command",
      "operationReference",
      "expectedSetupReference",
      "expectedRevision",
      // Read the discriminator through its descriptor before selecting the last field.
      Object.getOwnPropertyDescriptor(raw ?? {}, "command")?.value === "SaveDraft"
        ? "content"
        : "intentDigest",
    ]);
    const identity = {
      ...scope,
      operationReference: input.operationReference,
      expectedSetupReference: input.expectedSetupReference,
      expectedRevision: input.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
    };
    if (input.command === "SaveDraft")
      return Object.freeze({
        method: "save" as const,
        command: parseStoreSetupSaveCommand({
          profile:
            Object.getOwnPropertyDescriptor(input.content ?? {}, "feeContexts") !== undefined
              ? "StoreSetupSaveV2"
              : "StoreSetupSaveV1",
          ...identity,
          content: input.content,
        }),
      });
    if (input.command === "ResolveOriginal")
      return Object.freeze({
        method: "resolve" as const,
        command: parseStoreSetupResolveCommand({
          profile: "StoreSetupResolveV1",
          ...identity,
          intentDigest: input.intentDigest,
        }),
      });
    return invalid();
  } catch {
    return invalid();
  }
}
