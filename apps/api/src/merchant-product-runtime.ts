import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  createMerchantProductPublicationRuntimeSources,
  type MerchantProductPublicationRuntimeSourcesOptions,
} from "./merchant-product-publication-runtime-sources.js";
import { createMerchantProductPublicationManagementQueryV2 } from "./merchant-product-publication-management-query-v2.js";
import { createMerchantProductPublicationValidationReportQueryV2 } from "./merchant-product-publication-validation-report-query-v2.js";
import { createMerchantProductPublicationCommandV2 } from "./merchant-product-publication-command-v2.js";
import { createMerchantProductPublicationWarningAcknowledgementCommand } from "./merchant-product-publication-warning-acknowledgement-command.js";
import { createMerchantProductPublicationResolutionCommand } from "./merchant-product-publication-resolution-command.js";

export interface MerchantProductPublicationRuntimeConfiguration {
  readonly sources: MerchantProductPublicationRuntimeSourcesOptions;
  readonly auditReference: (operationReference: string) => string;
  readonly maximumApprovalValiditySeconds: number;
}

/** Shared ordinary Product composition for both application startup paths.
 * Caller supplies actual persistence and authentication, never a second session
 * service or alternate source/field/feature grants for the pilot entry. */
export function createMerchantProductPublicationRuntime(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly configuration: MerchantProductPublicationRuntimeConfiguration;
}) {
  const { merchant, authentication, configuration } = options,
    sources = createMerchantProductPublicationRuntimeSources(configuration.sources),
    common = { merchant, authentication, currentRuntime: true as const };
  return Object.freeze({
    productPublicationManagementV2: createMerchantProductPublicationManagementQueryV2(common),
    productPublicationValidationReportV2:
      createMerchantProductPublicationValidationReportQueryV2(common),
    productPublicationV2: createMerchantProductPublicationCommandV2({
      ...common,
      auditReference: configuration.auditReference,
      maximumApprovalValiditySeconds: configuration.maximumApprovalValiditySeconds,
      sourceFactory: sources.publication,
    }),
    productPublicationWarningAcknowledgement:
      createMerchantProductPublicationWarningAcknowledgementCommand({
        ...common,
        auditReference: configuration.auditReference,
        sourceFactory: sources.acknowledgement,
      }),
    productPublicationResolution: createMerchantProductPublicationResolutionCommand({
      ...common,
      auditReference: configuration.auditReference,
    }),
  });
}
