import { createStoreConfigurationVersion, parseStoreAdministrationReference } from "@rms/store";
import { parseBrandReference, parseStoreReference, parseCanonicalInstant } from "@bop/tenant";

const methods = {
  SaveDraft: "saveDraft",
  Validate: "validate",
  Submit: "submit",
  Approve: "approve",
  Publish: "publish",
} as const;
const invalid = (): never => {
  throw new Error("STORE_CONFIGURATION_COMMAND_INVALID");
};
/** Bind transport input to an already authenticated, currently authorized selection.
 * This parser is not authentication; the route must validate session and CSRF first.
 * Full configuration references are checked again by public owner/domain ports.
 */
export function bindMerchantStoreConfigurationCommand(
  raw: unknown,
  context: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly observedAt: string;
  },
) {
  try {
    const keys = [
      "command",
      "operationReference",
      "auditReference",
      "expectedVersion",
      "configuration",
    ];
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== keys.length
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !descriptor.enumerable || !("value" in descriptor);
      })
    )
      return invalid();
    const input = raw as Record<string, unknown>;
    if (
      typeof input.command !== "string" ||
      !Object.hasOwn(methods, input.command) ||
      typeof input.expectedVersion !== "number" ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      return invalid();
    const configuration = createStoreConfigurationVersion(input.configuration);
    const brand = parseBrandReference(context.brandReference),
      store = parseStoreReference(context.storeReference);
    const actor = parseStoreAdministrationReference(context.actorReference);
    const at = parseCanonicalInstant(context.observedAt);
    if (
      configuration.brandReference !== brand ||
      configuration.storeReference !== store ||
      configuration.createdAt > at ||
      configuration.updatedAt > at
    )
      return invalid();
    return Object.freeze({
      method: methods[input.command as keyof typeof methods],
      input: Object.freeze({
        operationReference: parseStoreAdministrationReference(input.operationReference),
        auditReference: parseStoreAdministrationReference(input.auditReference),
        expectedVersion: input.expectedVersion,
        configuration:
          input.command === "SaveDraft"
            ? createStoreConfigurationVersion({ ...configuration, authoredByReference: actor })
            : input.command === "Approve" && configuration.lifecycle === "PendingApproval"
              ? createStoreConfigurationVersion({
                  ...configuration,
                  lifecycle: "Approved",
                  approvedByReference: actor,
                  approvalEvidenceReference: parseStoreAdministrationReference(
                    input.operationReference,
                  ),
                })
              : configuration,
        actorReference: actor,
        purposeCode: "STORE_CONFIGURATION",
        occurredAt: at,
      }),
    });
  } catch {
    return invalid();
  }
}
