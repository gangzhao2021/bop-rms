import { readClosedRecord } from "@bop/identity";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringScope,
  TaxConfigWorkflowError,
} from "@rms/pricing";

/** Browser intent has no authority, currency, professional evidence or server result IDs. */
export function bindMerchantTaxConfigAuthoringCommand(value: unknown) {
  try {
    return parseTaxConfigAuthoringCommand(
      readClosedRecord(value, [
        "action",
        "operationReference",
        "configurationReference",
        "expectedAggregateVersion",
        "content",
      ]),
    );
  } catch {
    throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
  }
}
export function bindMerchantTaxConfigAuthoringResolve(value: unknown) {
  try {
    return parseTaxConfigAuthoringResolve(
      readClosedRecord(value, [
        "action",
        "operationReference",
        "configurationReference",
        "expectedAggregateVersion",
        "intentDigest",
      ]),
    );
  } catch {
    throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
  }
}
export function parseMerchantTaxConfigAuthoringScope(value: unknown) {
  try {
    return parseTaxConfigAuthoringScope(
      readClosedRecord(value, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]),
    );
  } catch {
    throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
  }
}
