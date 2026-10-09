import { createMerchantBrandStoreTopologyDraft } from "./merchant-brand-store-topology-draft.js";
import { createMerchantTaxConfigAuthoring } from "./merchant-tax-config-authoring.js";
import { createMerchantReceiptTemplatePublished } from "./merchant-receipt-template-published.js";
import { createMerchantReceiptTemplateLifecycle } from "./merchant-receipt-template-lifecycle.js";
import { createMerchantReceiptTemplateReview } from "./merchant-receipt-template-review.js";
import { createMerchantReceiptTemplateSubmit } from "./merchant-receipt-template-submit.js";
import { createMerchantReceiptTemplateDraft } from "./merchant-receipt-template-draft.js";
import { createMerchantReceiptTemplateArtifacts } from "./merchant-receipt-template-artifacts.js";
import { createMerchantStorePaymentConfiguration } from "./merchant-store-payment-configuration.js";
import { createMerchantStoreSetupReferences } from "./merchant-store-setup-references.js";
import { createMerchantStoreSetup } from "./merchant-store-setup.js";
import { createMerchantProductOptionPickerQuery } from "./merchant-product-option-picker-query.js";
import { createMerchantOptionSetPublicationCommand } from "./merchant-option-set-publication-command.js";
import { createMerchantOptionSetPublicationResolutionCommand } from "./merchant-option-set-publication-resolution-command.js";
import { createMerchantOptionSetPublicationContextQuery } from "./merchant-option-set-publication-context-query.js";
import { createMerchantProductSellingUnitRegistry } from "./merchant-product-selling-unit-registry.js";
import { createMerchantProductAuthoringContextQuery } from "./merchant-product-authoring-context-query.js";
import { createMerchantProductAuthoringResolutionCommand } from "./merchant-product-authoring-resolution-command.js";
import { createMerchantOptionSetAuthoringCommand } from "./merchant-option-set-authoring-command.js";
import { createMerchantOptionPriceAuthoringCommand } from "./merchant-option-price-authoring-command.js";
import { createMerchantOptionPriceReviewCommand } from "./merchant-option-price-review-command.js";
import { createMerchantOptionSetHistoryQuery } from "./merchant-option-set-history-query.js";
import { createMerchantOptionSetCurrentPublicationQuery } from "./merchant-option-set-current-publication-query.js";
import { createMerchantOptionSetEditorQuery } from "./merchant-option-set-editor-query.js";
import { createMerchantOptionSetAuthoringResolutionCommand } from "./merchant-option-set-authoring-resolution-command.js";
import { createMerchantOptionSetAuthoringContextQuery } from "./merchant-option-set-authoring-context-query.js";
import { createMerchantOptionSetListQuery } from "./merchant-option-set-list-query.js";
import { CatalogError } from "@rms/catalog";
import {
  createMerchantProductPublicationRuntime,
  type MerchantProductPublicationRuntimeConfiguration,
} from "./merchant-product-runtime.js";
import {
  createMerchantProductPublicationSources,
  type MerchantProductPublicationSourcesConfiguration,
} from "./merchant-product-publication-sources.js";
import { createMerchantProductPublicationResolutionCommand } from "./merchant-product-publication-resolution-command.js";
import { createMerchantProductPublicationWarningAcknowledgementCommand } from "./merchant-product-publication-warning-acknowledgement-command.js";
import { createMerchantProductPublicationManagementQuery } from "./merchant-product-publication-management-query.js";
import { createMerchantProductPublicationManagementQueryV2 } from "./merchant-product-publication-management-query-v2.js";
import { createMerchantProductPublicationValidationReportQueryV2 } from "./merchant-product-publication-validation-report-query-v2.js";
import { createMerchantProductPublicationCommandV2 } from "./merchant-product-publication-command-v2.js";
import { createMerchantProductEditorQuery } from "./merchant-product-editor-query.js";
import { createMerchantProductScopeJournalQuery } from "./merchant-product-scope-journal-query.js";
import { createMerchantProductPublicationQuery } from "./merchant-product-publication-query.js";
import { createMerchantStoreCapability } from "./merchant-store-capability.js";
import { createMerchantProductPublicationCommand } from "./merchant-product-publication-command.js";
import { createMerchantProductDraftBaselineQuery } from "./merchant-product-draft-baseline-query.js";
import { createMerchantProductCategoryLookupQuery } from "./merchant-product-category-lookup-query.js";
import { createMerchantCategoryTreeQuery } from "./merchant-category-tree-query.js";
import { createMerchantProductListQuery } from "./merchant-product-list-query.js";
import { createMerchantPickupQuery } from "./merchant-pickup-query.js";
import { createMerchantPickupProof } from "./merchant-pickup-proof.js";
import { createMerchantPickupHandoff } from "./merchant-pickup-handoff.js";
import { createMerchantKitchenQuery } from "./merchant-kitchen-query.js";
import { createMerchantKitchenCommand } from "./merchant-kitchen-command.js";
import { createMerchantProductDraftCommand } from "./merchant-product-draft-command.js";
import { createMerchantOrdinaryRefundCommand } from "./merchant-ordinary-refund-command.js";
import { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import { createMerchantMenuDraftQuery } from "./merchant-menu-draft-query.js";
import { createMerchantProductCreationCommand } from "./merchant-product-creation-command.js";
import { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
import { createMerchantPriceBookCommands } from "./merchant-price-book-commands.js";
import { createMerchantPriceBookHttpCommand } from "./merchant-price-book-http-command.js";
import { createSingleStorePriceBookFacts } from "./single-store-price-book-facts.js";
import { createPersistentMerchantOrderQueue } from "./persistent-merchant-order-queue.js";
import { createMerchantOrderAcceptanceCommand } from "./merchant-order-acceptance-command.js";
import { createMerchantDiningItemService } from "./merchant-dining-item-service.js";
import { createMerchantDiningTables } from "./merchant-dining-tables.js";
import { createMerchantDiningTableCommand } from "./merchant-dining-table-command.js";
import { createMerchantDiningSessionStart } from "./merchant-dining-session-start.js";
import {
  createPersistentMerchantBffService,
  type PersistentMerchantBffOptions,
} from "./persistent-merchant-bff.js";
import { createMerchantServiceControl } from "./merchant-service-control.js";
import { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
import { createMerchantStoreConfigurationOrdinary } from "./merchant-store-configuration-ordinary.js";
import { createMerchantDiningTaskSource } from "./merchant-dining-task-source.js";
import { createPersistentMerchantTaskInbox } from "./persistent-merchant-task-inbox.js";
import type { PersistentMerchantTaskInboxQueueConfiguration } from "./persistent-merchant-task-inbox.js";
import type { MerchantBffRouterOptions } from "./merchant-bff.js";

type ProductCommandRuntimeOptions<T> = T extends unknown
  ? Omit<T, "merchant" | "authentication">
  : never;
type ConfigurationOptions = Parameters<typeof createMerchantStoreConfiguration>[0];
export interface MerchantRuntimeOptions {
  readonly storeConfigurationOrdinary?: Omit<
    Parameters<typeof createMerchantStoreConfigurationOrdinary>[0],
    "persistence" | "authentication"
  >;
  readonly brandStoreTopologyDraft?: Pick<
    Parameters<typeof createMerchantBrandStoreTopologyDraft>[0],
    "nextReference"
  >;
  readonly taxConfigAuthoring?: Omit<
    Parameters<typeof createMerchantTaxConfigAuthoring>[0],
    "persistence" | "authentication"
  >;
  readonly pickupQuery?: Omit<
    Parameters<typeof createMerchantPickupQuery>[0],
    "persistence" | "authentication"
  >;
  readonly pickupProof?: Omit<
    Parameters<typeof createMerchantPickupProof>[0],
    "persistence" | "authentication"
  >;
  readonly pickupHandoff?: Omit<
    Parameters<typeof createMerchantPickupHandoff>[0],
    "persistence" | "authentication"
  >;
  readonly kitchenQuery?: Pick<Parameters<typeof createMerchantKitchenQuery>[0], "sha256">;
  readonly taskInbox?: {
    readonly queue: PersistentMerchantTaskInboxQueueConfiguration;
    readonly additionalQueues?: readonly PersistentMerchantTaskInboxQueueConfiguration[];
  };
  readonly kitchenCommand?: Omit<
    Parameters<typeof createMerchantKitchenCommand>[0],
    "persistence" | "authentication"
  >;
  /** Explicit administration authority; never derived from Active Store navigation. */
  readonly brandLifecycle?: MerchantBffRouterOptions["brandLifecycle"];
  readonly ordinaryRefund?: Omit<
    Parameters<typeof createMerchantOrdinaryRefundCommand>[0],
    "persistence" | "authentication"
  >;
  readonly menuPublication?: Pick<
    Parameters<typeof createMerchantMenuPublicationCommand>[0],
    "binding" | "reference" | "reviewCreation" | "reviewApproval"
  >;
  readonly menuDraft?: boolean;
  readonly productDraftBaseline?: Omit<
    Parameters<typeof createMerchantProductDraftBaselineQuery>[0],
    "merchant"
  >;
  readonly productCategoryLookup?: Omit<
    Parameters<typeof createMerchantProductCategoryLookupQuery>[0],
    "merchant"
  >;
  readonly categoryTree?: Omit<Parameters<typeof createMerchantCategoryTreeQuery>[0], "merchant">;
  readonly productList?: Pick<
    Parameters<typeof createMerchantProductListQuery>[0],
    "authority" | "cursorKey" | "categorySource"
  >;
  readonly productCreation?: ProductCommandRuntimeOptions<
    Parameters<typeof createMerchantProductCreationCommand>[0]
  >;
  readonly productDraft?: ProductCommandRuntimeOptions<
    Parameters<typeof createMerchantProductDraftCommand>[0]
  >;
  readonly storeCapability?: Omit<
    Parameters<typeof createMerchantStoreCapability>[0],
    "persistence" | "authentication"
  >;
  readonly productEditor?: Omit<
    Parameters<typeof createMerchantProductEditorQuery>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationManagement?: Omit<
    Parameters<typeof createMerchantProductPublicationManagementQuery>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationManagementV2?: Omit<
    Parameters<typeof createMerchantProductPublicationManagementQueryV2>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationValidationReportV2?: Omit<
    Parameters<typeof createMerchantProductPublicationValidationReportQueryV2>[0],
    "merchant" | "authentication"
  >;
  readonly productSellingUnitRegistry?: Omit<
    Parameters<typeof createMerchantProductSellingUnitRegistry>[0],
    "merchant" | "authentication"
  >;
  readonly productAuthoringContext?: boolean;
  readonly storeSetup?: Pick<Parameters<typeof createMerchantStoreSetup>[0], "nextReference"> & {
    readonly receiptTemplateReviewValidityMs?: number;
    readonly receiptTemplateApprovalValidityMs?: number;
  };
  readonly optionPriceAuthoring?: Omit<
    Parameters<typeof createMerchantOptionPriceAuthoringCommand>[0],
    "merchant" | "authentication"
  >;
  readonly optionPriceReview?: Omit<
    Parameters<typeof createMerchantOptionPriceReviewCommand>[0],
    "merchant" | "authentication"
  >;
  readonly optionSetAuthoring?: Omit<
    Parameters<typeof createMerchantOptionSetAuthoringCommand>[0],
    "merchant" | "authentication"
  >;
  readonly optionSetEditor?: boolean;
  readonly optionSetHistory?: boolean;
  readonly optionSetCurrentPublication?: boolean;
  readonly productOptionPicker?: boolean;
  readonly optionSetList?: Omit<
    Parameters<typeof createMerchantOptionSetListQuery>[0],
    "merchant" | "authentication"
  >;
  readonly optionSetAuthoringContext?: boolean;
  readonly optionSetPublicationContext?: boolean;
  readonly optionSetPublicationCommand?: Omit<
    Parameters<typeof createMerchantOptionSetPublicationCommand>[0],
    "merchant" | "authentication"
  >;
  readonly optionSetPublicationResolution?: Omit<
    Parameters<typeof createMerchantOptionSetPublicationResolutionCommand>[0],
    "merchant" | "authentication"
  >;
  readonly optionSetAuthoringResolution?: Omit<
    Parameters<typeof createMerchantOptionSetAuthoringResolutionCommand>[0],
    "merchant" | "authentication"
  >;
  readonly productAuthoringResolution?: Omit<
    Parameters<typeof createMerchantProductAuthoringResolutionCommand>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationResolution?: Omit<
    Parameters<typeof createMerchantProductPublicationResolutionCommand>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationWarningAcknowledgement?: Omit<
    Parameters<typeof createMerchantProductPublicationWarningAcknowledgementCommand>[0],
    "merchant" | "authentication"
  >;
  /** Complete current-source assembly; business-policy configuration is explicit. */
  readonly productPublicationSources?: MerchantProductPublicationSourcesConfiguration;
  /** Concrete ordinary publication and consent entry with current IAM/FeatureControl. */
  readonly productPublicationRuntime?: MerchantProductPublicationRuntimeConfiguration;
  readonly productPublicationV2?: Omit<
    Parameters<typeof createMerchantProductPublicationCommandV2>[0],
    "merchant" | "authentication"
  >;
  readonly productScopeJournals?: Omit<
    Parameters<typeof createMerchantProductScopeJournalQuery>[0],
    "merchant" | "authentication"
  >;
  readonly productPublicationQuery?: Omit<
    Parameters<typeof createMerchantProductPublicationQuery>[0],
    "merchant" | "authentication"
  >;
  readonly productPublication?: Omit<
    Parameters<typeof createMerchantProductPublicationCommand>[0],
    "merchant" | "authentication"
  >;
  readonly productLifecycle?: Pick<
    Parameters<typeof createMerchantProductLifecycleCommand>[0],
    "auditReference" | "categoryPolicy" | "writeAuthority" | "lifecycleReview" | "currentRuntime"
  >;
  readonly priceBooks?: Pick<
    Parameters<typeof createMerchantPriceBookCommands>[0],
    "currencyMetadata" | "auditReference"
  > &
    Omit<Parameters<typeof createSingleStorePriceBookFacts>[0], "now">;
  readonly orderQueue?: Readonly<{ quoteVersion: 1 | 2 }>;
  readonly orderAcceptance?: Omit<
    Parameters<typeof createMerchantOrderAcceptanceCommand>[0],
    "persistence" | "authentication"
  >;
  readonly persistence: PersistentMerchantBffOptions;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly serviceAudit: Parameters<typeof createMerchantServiceControl>[0]["audit"];
  readonly configuration: Omit<
    ConfigurationOptions,
    "persistence" | "authentication" | "review"
  > & {
    readonly review: NonNullable<ConfigurationOptions["review"]>;
  };
  readonly orderExceptions?: MerchantBffRouterOptions["orderExceptions"];
  readonly settlement?: MerchantBffRouterOptions["settlement"];
  readonly diningItemService?: Omit<
    Parameters<typeof createMerchantDiningItemService>[0],
    "persistence" | "authentication"
  >;
  readonly diningTableCommand?: Pick<
    Parameters<typeof createMerchantDiningTableCommand>[0],
    "newReference" | "retentionPolicyCode" | "retentionPolicyVersion"
  >;
  readonly diningSessionStart?: Pick<
    Parameters<typeof createMerchantDiningSessionStart>[0],
    | "credentials"
    | "pepperVersion"
    | "newReference"
    | "retentionPolicyCode"
    | "retentionPolicyVersion"
  >;
}

/** Application composition only. Store facts, validation policy and Provider
 * credentials must come from explicitly configured owner/runtime dependencies.
 */
export function createMerchantRuntime(options: MerchantRuntimeOptions): MerchantBffRouterOptions {
  if (
    options.productPublicationRuntime !== undefined &&
    (options.productPublicationSources !== undefined ||
      options.productPublicationV2 !== undefined ||
      options.productPublicationWarningAcknowledgement !== undefined ||
      options.productPublicationManagementV2 !== undefined ||
      options.productPublicationValidationReportV2 !== undefined ||
      options.productPublicationResolution !== undefined)
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const ordinary = options.productPublicationRuntime;
  const publicationSources =
    options.productPublicationSources === undefined
      ? undefined
      : createMerchantProductPublicationSources(options.productPublicationSources);
  if (
    publicationSources !== undefined &&
    ((options.productPublicationV2 === undefined &&
      options.productPublicationWarningAcknowledgement === undefined) ||
      options.productPublicationV2?.sources !== undefined ||
      options.productPublicationV2?.sourceFactory !== undefined ||
      options.productPublicationV2?.editorContentAuthority !== undefined ||
      options.productPublicationV2?.currentUniqueScope !== undefined ||
      options.productPublicationWarningAcknowledgement?.sources !== undefined ||
      options.productPublicationWarningAcknowledgement?.sourceFactory !== undefined)
  )
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  const service = createPersistentMerchantBffService(
    options.brandStoreTopologyDraft === undefined && options.storeSetup === undefined
      ? options.persistence
      : { ...options.persistence, currentBrandNavigation: true },
  );
  const control = createMerchantServiceControl({
    persistence: options.persistence,
    authentication: service,
    audit: options.serviceAudit,
  });
  const configuration = createMerchantStoreConfiguration({
    ...options.configuration,
    persistence: options.persistence,
    authentication: service,
  });
  const ordinaryConfiguration =
    options.storeConfigurationOrdinary === undefined
      ? undefined
      : createMerchantStoreConfigurationOrdinary({
          ...options.storeConfigurationOrdinary,
          persistence: options.persistence,
          authentication: service,
        });
  const priceBooks =
    options.priceBooks === undefined
      ? undefined
      : createMerchantPriceBookHttpCommand(
          createMerchantPriceBookCommands({
            ...options.priceBooks,
            ...createSingleStorePriceBookFacts({
              ...options.priceBooks,
              now: options.persistence.now,
            }),
            merchant: options.persistence,
            authentication: service,
          }),
        );
  return {
    ...(options.pickupQuery === undefined
      ? {}
      : {
          pickupQuery: createMerchantPickupQuery({
            ...options.pickupQuery,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.pickupProof === undefined
      ? {}
      : {
          pickupProof: createMerchantPickupProof({
            ...options.pickupProof,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.pickupHandoff === undefined
      ? {}
      : {
          pickupHandoff: createMerchantPickupHandoff({
            ...options.pickupHandoff,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.kitchenQuery === undefined
      ? {}
      : {
          kitchenQuery: createMerchantKitchenQuery({
            ...options.kitchenQuery,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.taskInbox === undefined
      ? {}
      : {
          taskInbox: createPersistentMerchantTaskInbox({
            persistence: options.persistence,
            queues: [options.taskInbox.queue, ...(options.taskInbox.additionalQueues ?? [])],
            authorizeSource: createMerchantDiningTaskSource(options.persistence),
          }),
        }),
    ...(options.kitchenCommand === undefined
      ? {}
      : {
          kitchenCommand: createMerchantKitchenCommand({
            ...options.kitchenCommand,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.ordinaryRefund === undefined
      ? {}
      : {
          ordinaryRefund: createMerchantOrdinaryRefundCommand({
            ...options.ordinaryRefund,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.menuPublication === undefined
      ? {}
      : {
          menuPublication: createMerchantMenuPublicationCommand({
            ...options.menuPublication,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productDraftBaseline === undefined
      ? {}
      : {
          productDraftBaseline: createMerchantProductDraftBaselineQuery({
            ...options.productDraftBaseline,
            merchant: options.persistence,
          }),
        }),
    ...(options.productCategoryLookup === undefined
      ? {}
      : {
          productCategoryLookup: createMerchantProductCategoryLookupQuery({
            ...options.productCategoryLookup,
            merchant: options.persistence,
          }),
        }),
    ...(options.categoryTree === undefined
      ? {}
      : {
          categoryTree: createMerchantCategoryTreeQuery({
            ...options.categoryTree,
            merchant: options.persistence,
          }),
        }),
    ...(options.productList === undefined
      ? {}
      : {
          productList: createMerchantProductListQuery({
            ...options.productList,
            merchant: options.persistence,
          }),
        }),
    ...(options.menuDraft === true
      ? {
          menuDraft: createMerchantMenuDraftQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.brandLifecycle === undefined ? {} : { brandLifecycle: options.brandLifecycle }),
    ...(options.productCreation === undefined
      ? {}
      : {
          productCreation: createMerchantProductCreationCommand({
            ...options.productCreation,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productDraft === undefined
      ? {}
      : {
          productDraft: createMerchantProductDraftCommand({
            ...options.productDraft,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.storeCapability === undefined
      ? {}
      : {
          storeCapability: createMerchantStoreCapability({
            ...options.storeCapability,
            persistence: options.persistence,
            authentication: service,
          }).observe,
        }),
    ...(options.productEditor === undefined
      ? {}
      : {
          productEditor: createMerchantProductEditorQuery({
            ...options.productEditor,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublicationManagement === undefined
      ? {}
      : {
          productPublicationManagement: createMerchantProductPublicationManagementQuery({
            ...options.productPublicationManagement,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublicationManagementV2 === undefined
      ? {}
      : {
          productPublicationManagementV2: createMerchantProductPublicationManagementQueryV2({
            ...options.productPublicationManagementV2,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublicationValidationReportV2 === undefined
      ? {}
      : {
          productPublicationValidationReportV2:
            createMerchantProductPublicationValidationReportQueryV2({
              ...options.productPublicationValidationReportV2,
              merchant: options.persistence,
              authentication: service,
            }),
        }),
    ...(options.productSellingUnitRegistry === undefined
      ? {}
      : {
          productSellingUnitRegistry: createMerchantProductSellingUnitRegistry({
            ...options.productSellingUnitRegistry,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productAuthoringContext === true
      ? {
          productAuthoringContext: createMerchantProductAuthoringContextQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.brandStoreTopologyDraft === undefined && options.storeSetup === undefined
      ? {}
      : {
          brandStoreTopologyClock: Object.freeze({
            now: options.persistence.now.bind(options.persistence),
          }),
          brandStoreTopologyDraft: createMerchantBrandStoreTopologyDraft({
            persistence: options.persistence,
            authentication: service,
            nextReference: () => {
              const configured = options.brandStoreTopologyDraft ?? options.storeSetup;
              if (!configured) throw new Error("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
              return configured.nextReference();
            },
          }),
        }),
    ...(options.taxConfigAuthoring === undefined
      ? {}
      : {
          taxConfigAuthoring: createMerchantTaxConfigAuthoring({
            ...options.taxConfigAuthoring,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.storeSetup === undefined
      ? {}
      : {
          ...(options.taxConfigAuthoring === undefined
            ? {
                taxConfigAuthoring: createMerchantTaxConfigAuthoring({
                  persistence: options.persistence,
                  authentication: service,
                  nextReference: options.storeSetup.nextReference,
                  ...(options.optionPriceAuthoring?.currencyMetadata === undefined
                    ? {}
                    : { currencyMetadata: options.optionPriceAuthoring.currencyMetadata }),
                }),
              }
            : {}),
          receiptTemplatePublished: createMerchantReceiptTemplatePublished({
            persistence: options.persistence,
            authentication: service,
          }),
          receiptTemplateReview: createMerchantReceiptTemplateReview({
            persistence: options.persistence,
            authentication: service,
          }),
          receiptTemplateLifecycle: createMerchantReceiptTemplateLifecycle({
            nextReference: options.storeSetup.nextReference,
            ...(options.storeSetup.receiptTemplateApprovalValidityMs === undefined
              ? {}
              : { approvalValidityMs: options.storeSetup.receiptTemplateApprovalValidityMs }),
            persistence: options.persistence,
            authentication: service,
          }),
          receiptTemplateSubmit: createMerchantReceiptTemplateSubmit({
            ...options.storeSetup,
            ...(options.storeSetup.receiptTemplateReviewValidityMs === undefined
              ? {}
              : { reviewValidityMs: options.storeSetup.receiptTemplateReviewValidityMs }),
            persistence: options.persistence,
            authentication: service,
          }),
          receiptTemplateDraft: createMerchantReceiptTemplateDraft({
            ...options.storeSetup,
            persistence: options.persistence,
            authentication: service,
          }),
          receiptTemplateArtifacts: createMerchantReceiptTemplateArtifacts({
            ...options.storeSetup,
            persistence: options.persistence,
            authentication: service,
          }),
          storePaymentConfiguration: createMerchantStorePaymentConfiguration({
            ...options.storeSetup,
            persistence: options.persistence,
            authentication: service,
          }),
          storeSetupReferences: createMerchantStoreSetupReferences({
            ...options.storeSetup,
            persistence: options.persistence,
            authentication: service,
          }),
          storeSetupClock: Object.freeze({
            now: options.persistence.now.bind(options.persistence),
          }),
          storeSetup: createMerchantStoreSetup({
            ...options.storeSetup,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionPriceAuthoring === undefined
      ? {}
      : {
          optionPriceAuthoring: createMerchantOptionPriceAuthoringCommand({
            ...options.optionPriceAuthoring,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionPriceReview === undefined
      ? {}
      : {
          optionPriceReview: createMerchantOptionPriceReviewCommand({
            ...options.optionPriceReview,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionSetAuthoring === undefined
      ? {}
      : {
          optionSetAuthoring: createMerchantOptionSetAuthoringCommand({
            ...options.optionSetAuthoring,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productOptionPicker === true
      ? {
          productOptionPicker: createMerchantProductOptionPickerQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.optionSetCurrentPublication === true
      ? {
          optionSetCurrentPublication: createMerchantOptionSetCurrentPublicationQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.optionSetHistory === true
      ? {
          optionSetHistory: createMerchantOptionSetHistoryQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.optionSetEditor === true
      ? {
          optionSetEditor: createMerchantOptionSetEditorQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.optionSetAuthoringResolution === undefined
      ? {}
      : {
          optionSetAuthoringResolution: createMerchantOptionSetAuthoringResolutionCommand({
            ...options.optionSetAuthoringResolution,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionSetList === undefined
      ? {}
      : {
          optionSetList: createMerchantOptionSetListQuery({
            ...options.optionSetList,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionSetPublicationCommand === undefined
      ? {}
      : {
          optionSetPublicationCommand: createMerchantOptionSetPublicationCommand({
            ...options.optionSetPublicationCommand,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionSetPublicationResolution === undefined
      ? {}
      : {
          optionSetPublicationResolution: createMerchantOptionSetPublicationResolutionCommand({
            ...options.optionSetPublicationResolution,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.optionSetPublicationContext === true
      ? {
          optionSetPublicationContext: createMerchantOptionSetPublicationContextQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.optionSetAuthoringContext === true
      ? {
          optionSetAuthoringContext: createMerchantOptionSetAuthoringContextQuery({
            merchant: options.persistence,
            authentication: service,
          }),
        }
      : {}),
    ...(options.productAuthoringResolution === undefined
      ? {}
      : {
          productAuthoringResolution: createMerchantProductAuthoringResolutionCommand({
            ...options.productAuthoringResolution,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublicationResolution === undefined
      ? {}
      : {
          productPublicationResolution: createMerchantProductPublicationResolutionCommand({
            ...options.productPublicationResolution,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(ordinary === undefined
      ? {}
      : createMerchantProductPublicationRuntime({
          merchant: options.persistence,
          authentication: service,
          configuration: ordinary,
        })),
    ...(options.productPublicationWarningAcknowledgement === undefined
      ? {}
      : {
          productPublicationWarningAcknowledgement:
            createMerchantProductPublicationWarningAcknowledgementCommand({
              ...options.productPublicationWarningAcknowledgement,
              ...(publicationSources === undefined
                ? {}
                : { sourceFactory: publicationSources.acknowledgement }),
              merchant: options.persistence,
              authentication: service,
            }),
        }),
    ...(options.productPublicationV2 === undefined
      ? {}
      : {
          productPublicationV2: createMerchantProductPublicationCommandV2({
            ...options.productPublicationV2,
            ...(publicationSources === undefined
              ? {}
              : { sourceFactory: publicationSources.publication }),
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productScopeJournals === undefined
      ? {}
      : {
          productScopeJournals: createMerchantProductScopeJournalQuery({
            ...options.productScopeJournals,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublicationQuery === undefined
      ? {}
      : {
          productPublicationQuery: createMerchantProductPublicationQuery({
            ...options.productPublicationQuery,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productPublication === undefined
      ? {}
      : {
          productPublication: createMerchantProductPublicationCommand({
            ...options.productPublication,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.productLifecycle === undefined
      ? {}
      : {
          productLifecycle: createMerchantProductLifecycleCommand({
            ...options.productLifecycle,
            merchant: options.persistence,
            authentication: service,
          }),
        }),
    ...(priceBooks === undefined ? {} : { priceBooks }),
    ...(options.orderQueue === undefined
      ? {}
      : {
          orderQueue: createPersistentMerchantOrderQueue({
            persistence: options.persistence,
            quoteVersion: options.orderQueue.quoteVersion,
            acceptanceConfigured: options.orderAcceptance !== undefined,
          }),
        }),
    ...(options.orderAcceptance === undefined
      ? {}
      : {
          orderAcceptance: createMerchantOrderAcceptanceCommand({
            ...options.orderAcceptance,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.diningItemService === undefined
      ? {}
      : {
          diningItemService: createMerchantDiningItemService({
            ...options.diningItemService,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    diningTables: createMerchantDiningTables({
      persistence: options.persistence,
      authentication: service,
      tableAvailabilityCommandEnabled: options.diningTableCommand !== undefined,
    }),
    ...(options.diningTableCommand === undefined
      ? {}
      : {
          diningTableCommand: createMerchantDiningTableCommand({
            ...options.diningTableCommand,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    ...(options.diningSessionStart === undefined
      ? {}
      : {
          diningSessionStart: createMerchantDiningSessionStart({
            ...options.diningSessionStart,
            persistence: options.persistence,
            authentication: service,
          }),
        }),
    exactOrigin: options.exactOrigin,
    acceptedHost: options.acceptedHost,
    service,
    serviceControl: control,
    serviceControlState: control.read,
    storeConfiguration: configuration,
    storeConfigurationState: configuration.read,
    ...(ordinaryConfiguration === undefined
      ? {}
      : {
          storeConfigurationOrdinary: ordinaryConfiguration,
          storeConfigurationOrdinaryClock: Object.freeze({
            now: options.persistence.now.bind(options.persistence),
          }),
        }),
    ...(options.orderExceptions === undefined ? {} : { orderExceptions: options.orderExceptions }),
    ...(options.settlement === undefined ? {} : { settlement: options.settlement }),
  };
}
