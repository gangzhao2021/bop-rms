import { readClosedRecord } from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseBrandAdministrationReference,
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
} from "@bop/tenant";

export interface MerchantBrandLifecycleRequest {
  readonly brandReference: string;
  readonly action: "ActivateBrand" | "ArchiveBrand";
  readonly expectedBrandVersion: number;
  readonly operationReference: string;
}
const invalid = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
};
const unavailable = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
export function parseMerchantBrandLifecycleRequest(value: unknown): MerchantBrandLifecycleRequest {
  try {
    const r = readClosedRecord(value, [
      "brandReference",
      "action",
      "expectedBrandVersion",
      "operationReference",
    ]);
    const version = parseOrganizationVersion(r.expectedBrandVersion);
    if ((r.action !== "ActivateBrand" && r.action !== "ArchiveBrand") || version >= 2147483647)
      return invalid();
    return Object.freeze({
      brandReference: String(parseBrandReference(r.brandReference)),
      action: r.action,
      expectedBrandVersion: version,
      operationReference: String(parseBrandAdministrationReference(r.operationReference)),
    });
  } catch {
    return invalid();
  }
}

/** The receipt is the historical operation result, not today's Brand status. */
export function parseMerchantBrandLifecycleReceipt(
  value: unknown,
  expected: MerchantBrandLifecycleRequest,
  actorReference: string,
  observedAt: string,
) {
  try {
    const command = parseMerchantBrandLifecycleRequest(expected),
      actor = String(parseBrandAdministrationReference(actorReference)),
      at = String(parseCanonicalInstant(observedAt)),
      r = readClosedRecord(value, [
        "profile",
        "actorReference",
        "brandReference",
        "action",
        "operationReference",
        "expectedBrandVersion",
        "status",
        "lifecycle",
        "version",
        "occurredAt",
      ]),
      occurredAt = String(parseCanonicalInstant(r.occurredAt)),
      version = parseOrganizationVersion(r.version);
    if (
      r.profile !== "MerchantBrandLifecycleReceiptV1" ||
      r.actorReference !== actor ||
      r.brandReference !== command.brandReference ||
      r.action !== command.action ||
      r.operationReference !== command.operationReference ||
      r.expectedBrandVersion !== command.expectedBrandVersion ||
      (r.status !== "Applied" && r.status !== "AlreadyApplied") ||
      r.lifecycle !== (command.action === "ActivateBrand" ? "Active" : "Archived") ||
      version !== command.expectedBrandVersion + 1 ||
      occurredAt > at
    )
      return unavailable();
    return Object.freeze({
      profile: "MerchantBrandLifecycleReceiptV1" as const,
      actorReference: actor,
      ...command,
      status: r.status,
      lifecycle: command.action === "ActivateBrand" ? ("Active" as const) : ("Archived" as const),
      version,
      occurredAt,
    });
  } catch {
    return unavailable();
  }
}
