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
import {
  createPersistentMerchantBffService,
  type PersistentMerchantBffOptions,
} from "./persistent-merchant-bff.js";
import { createMerchantServiceControl } from "./merchant-service-control.js";
import { createMerchantStoreConfiguration } from "./merchant-store-configuration.js";
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
  readonly productCreation?: Pick<
    Parameters<typeof createMerchantProductCreationCommand>[0],
    "auditReference"
  >;
  readonly productDraft?: Pick<
    Parameters<typeof createMerchantProductDraftCommand>[0],
    "auditReference"
  >;
  readonly productLifecycle?: Pick<
    Parameters<typeof createMerchantProductLifecycleCommand>[0],
    "auditReference"
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
