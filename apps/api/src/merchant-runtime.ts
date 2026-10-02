import { createMerchantProductPublicationManagementQuery } from "./merchant-product-publication-management-query.js";
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
import { createMerchantDiningTaskSource } from "./merchant-dining-task-source.js";
import { createPersistentMerchantTaskInbox } from "./persistent-merchant-task-inbox.js";
import type { PersistentMerchantTaskInboxQueueConfiguration } from "./persistent-merchant-task-inbox.js";
import type { MerchantBffRouterOptions } from "./merchant-bff.js";

type ConfigurationOptions = Parameters<typeof createMerchantStoreConfiguration>[0];
export interface MerchantRuntimeOptions {
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
  readonly productCreation?: Pick<
    Parameters<typeof createMerchantProductCreationCommand>[0],
    "auditReference" | "categoryPolicy" | "writeAuthority" | "editorContentAuthority"
  >;
  readonly productDraft?: Pick<
    Parameters<typeof createMerchantProductDraftCommand>[0],
    | "auditReference"
    | "categoryPolicy"
    | "writeAuthority"
    | "editorContentAuthority"
    | "registeredEditorContent"
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
    "auditReference" | "categoryPolicy" | "writeAuthority" | "lifecycleReview"
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
  const service = createPersistentMerchantBffService(options.persistence);
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
    ...(options.orderExceptions === undefined ? {} : { orderExceptions: options.orderExceptions }),
  };
}
