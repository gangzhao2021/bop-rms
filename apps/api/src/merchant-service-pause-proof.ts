import { canonicalizeRfc8785, sha256Hex, verifyAuditOperationBinding } from "@bop/audit";
import type { createPostgresStorePauseHistorySource } from "@rms/store";
type Options = Parameters<typeof createPostgresStorePauseHistorySource>[0];
export function createMerchantServicePauseProof(
  options: Pick<Options, "brandReference" | "storeReference" | "authorize">,
): Options["verifyOperation"] {
  return async (tx, operation, at) => {
    try {
      if (
        operation.brandReference !== options.brandReference ||
        operation.storeReference !== options.storeReference ||
        operation.purposeCode !== "STORE_SERVICE" ||
        typeof operation.occurredAt !== "string" ||
        operation.occurredAt > at ||
        !Number.isSafeInteger(operation.expectedVersion) ||
        operation.resultingVersion !== (operation.expectedVersion as number) + 1
      )
        return false;
      const content = operation.content as Readonly<Record<string, unknown>>;
      const pause = operation.command === "PauseService";
      if (
        !content ||
        typeof content !== "object" ||
        (!pause && operation.command !== "ResumeService") ||
        (pause ? content.effectiveFrom : content.effectiveAt) !== operation.occurredAt ||
        (pause && content.closureReference !== operation.operationReference)
      )
        return false;
      const intent = {
        brandReference: options.brandReference,
        storeReference: options.storeReference,
        command: operation.command,
        operationReference: operation.operationReference,
        configurationReference: operation.configurationReference,
        actorReference: operation.actorReference,
        purposeCode: operation.purposeCode,
        expectedVersion: operation.expectedVersion,
        auditReference: operation.auditReference,
        content: pause
          ? { effectiveUntil: content.effectiveUntil, serviceModes: content.serviceModes }
          : { pauseOperationReference: content.pauseOperationReference },
      };
      const intentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(intent));
      if (intentDigest !== operation.intentDigest) return false;
      return verifyAuditOperationBinding(
        tx,
        {
          auditId: operation.auditReference as string,
          brandId: options.brandReference,
          storeId: options.storeReference,
          actorReference: operation.actorReference as string,
          actionCode: pause ? "STORE_SERVICE_PAUSED" : "STORE_SERVICE_RESUMED",
          targetType: "StoreServiceControl",
          targetId: operation.operationReference as string,
          occurredAt: operation.occurredAt,
          sourceChannel: "MERCHANT_WEB",
          intentDigest,
          expectedVersion: operation.expectedVersion as number,
          resultingVersion: operation.resultingVersion as number,
        },
        () => options.authorize(tx, at),
      );
    } catch {
      return false;
    }
  };
}
