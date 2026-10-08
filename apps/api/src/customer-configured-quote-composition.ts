import { createCustomerQuotePort } from "./customer-quote-composition.js";
import {
  CartError,
  createPickupCartQuoteExpiryService,
  createDiningCartQuoteExpiryService,
  createPostgresCartQuoteExpiryStore,
  createConfiguredCustomerQuoteService,
  createPostgresCartQueryStore,
  createPostgresConfiguredCartQuoteStore,
  createPostgresPickupCartBindingReader,
  type ConfiguredCustomerQuoteOptions,
} from "@rms/ordering";
import { createPostgresCatalogOrderSnapshotSource } from "@rms/catalog";
import {
  createPostgresConfiguredPriceQuoteRequestStore,
  createPostgresCurrentConfiguredQuoteService,
  decodeConfiguredPriceQuoteSnapshot,
  encodeConfiguredPriceQuoteSnapshot,
  PriceQuoteRequestError,
  type ConfiguredPriceQuoteSnapshot,
  type PriceQuoteRequestStore,
} from "@rms/pricing";

type CatalogSource = typeof createPostgresCatalogOrderSnapshotSource;
type Candidate = (
  input: Parameters<ConfiguredCustomerQuoteOptions["pricing"]["quoteCart"]>[0],
  identity: Parameters<ConfiguredCustomerQuoteOptions["pricing"]["quoteCart"]>[1],
) => Promise<
  Pick<
    Parameters<PriceQuoteRequestStore<ConfiguredPriceQuoteSnapshot>["append"]>[0],
    "quote" | "audit"
  >
>;
export type CustomerConfiguredQuoteCompositionOptions = {
  readonly scope: ConfiguredCustomerQuoteOptions["scope"];
  readonly sessions: ConfiguredCustomerQuoteOptions["sessions"];
  readonly audit: ConfiguredCustomerQuoteOptions["audit"];
  readonly references: ConfiguredCustomerQuoteOptions["references"];
  readonly now: () => string;
  readonly cartTransactions: Parameters<typeof createPostgresCartQueryStore>[0];
  readonly attachmentTransactions: Parameters<typeof createPostgresConfiguredCartQuoteStore>[0];
  readonly pricingTransactions: Parameters<
    typeof createPostgresConfiguredPriceQuoteRequestStore
  >[0];
  readonly pricingReferences: Parameters<typeof createPostgresConfiguredPriceQuoteRequestStore>[2];
  readonly catalogTransactions: Parameters<CatalogSource>[0];
  readonly catalogScope: Omit<
    Parameters<CatalogSource>[1],
    "brandReference" | "storeReference" | "orderType"
  >;
  readonly catalogSafety: Omit<Parameters<CatalogSource>[2], "clock">;
  readonly catalogReferences: Parameters<CatalogSource>[3];
  readonly pricingChannelCode: string;
  readonly candidate: Candidate;
} & (
  | { readonly orderType: "Pickup" }
  | {
      readonly orderType: "DineIn";
      readonly participation: Extract<
        ConfiguredCustomerQuoteOptions,
        { orderType: "DineIn" }
      >["participation"];
    }
);

/** Public owner adapters, with explicit current sessions and commercial policy producer. Not HTTP activation. */
export function createCustomerConfiguredQuoteComposition(
  options: CustomerConfiguredQuoteCompositionOptions,
) {
  const scope = Object.freeze({ ...options.scope });
  const carts = createPostgresCartQueryStore(options.cartTransactions, scope);
  const attachments = createPostgresConfiguredCartQuoteStore(
    options.attachmentTransactions,
    scope,
    options.references,
  );
  const requests = createPostgresConfiguredPriceQuoteRequestStore(
    options.pricingTransactions,
    scope,
    options.pricingReferences,
  );
  return createConfiguredCustomerQuoteService({
    scope,
    sessions: options.sessions,
    audit: options.audit,
    references: options.references,
    now: options.now,
    pricingChannelCode: options.pricingChannelCode,
    ...(options.orderType === "Pickup"
      ? {
          orderType: "Pickup" as const,
          binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
        }
      : { orderType: "DineIn" as const, participation: options.participation }),
    catalog: createPostgresCatalogOrderSnapshotSource(
      options.catalogTransactions,
      { ...options.catalogScope, ...scope, orderType: options.orderType },
      { ...options.catalogSafety, clock: { now: options.now } },
      options.catalogReferences,
    ),
    repository: {
      loadCart: carts.load,
      resolveOperation: attachments.resolveOperation,
      attach: attachments.attach,
    },
    pricing: {
      async quoteCart(input, identity) {
        try {
          const existing = await requests.resolve({
            ...identity,
            cartReference: input.cartReference,
            cartVersion: input.cartVersion,
            observedAt: input.requestedAt,
          });
          if (existing !== null) return existing.quote;
          const candidate = await options.candidate(
            structuredClone(input),
            Object.freeze({ ...identity }),
          );
          const quote = decodeConfiguredPriceQuoteSnapshot(
            encodeConfiguredPriceQuoteSnapshot(candidate.quote),
          );
          if (
            String(quote.brandReference) !== input.brandReference ||
            String(quote.storeReference) !== input.storeReference ||
            String(quote.cartReference) !== input.cartReference ||
            quote.cartVersion !== input.cartVersion ||
            quote.lines.length !== input.lines.length ||
            input.lines.some((line) => {
              const priced = quote.lines.find(
                (value) => String(value.lineReference) === line.lineReference,
              );
              return (
                priced === undefined ||
                String(priced.sellableReference) !== line.sellableReference ||
                priced.quantity !== line.quantity ||
                String(priced.productVersionReference) !==
                  line.catalogSelectionEvidence.productVersionReference ||
                String(priced.menuVersionReference) !==
                  line.catalogSelectionEvidence.menuVersionReference ||
                priced.optionPrices.length !== line.optionSelections.length ||
                line.optionSelections.some(
                  (selection) =>
                    !priced.optionPrices.some(
                      (option) =>
                        String(option.rule.optionReference) === selection.optionReference &&
                        option.selectedQuantity === selection.quantity &&
                        option.itemQuantity === line.quantity &&
                        option.context.orderType === input.orderType &&
                        option.context.channelCode === options.pricingChannelCode &&
                        line.catalogSelectionEvidence.ruleEvidence.some(
                          (evidence) =>
                            evidence.bindingReference === String(option.rule.bindingReference),
                        ),
                    ),
                )
              );
            })
          )
            throw new CartError("CART_QUOTE_INVALID");
          return (
            await requests.append({
              ...identity,
              observedAt: input.requestedAt,
              quote,
              audit: candidate.audit,
            })
          ).quote;
        } catch (error) {
          if (error instanceof CartError) throw error;
          if (error instanceof PriceQuoteRequestError && error.code === "QUOTE_REQUEST_CONFLICT")
            throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        }
      },
    },
  });
}

type WithoutCandidate<T> = T extends unknown ? Omit<T, "candidate"> : never;
type ConfiguredQuotePolicies = Omit<
  Parameters<typeof createPostgresCurrentConfiguredQuoteService>[1],
  "scope" | "clock"
>;
export type CustomerConfiguredQuoteWithPoliciesOptions =
  WithoutCandidate<CustomerConfiguredQuoteCompositionOptions> & {
    readonly policyTransactions: Parameters<typeof createPostgresCurrentConfiguredQuoteService>[0];
    /** Fixed policies, or (WP-2423) the policies current for each quote, e.g. the Store's price book. */
    readonly policies:
      | ConfiguredQuotePolicies
      | ((input: Parameters<Candidate>[0]) => Promise<ConfiguredQuotePolicies>);
    readonly quoteRequest: (
      input: Parameters<Candidate>[0],
      identity: Parameters<Candidate>[1],
    ) => Promise<
      Parameters<ReturnType<typeof createPostgresCurrentConfiguredQuoteService>["create"]>[0]
    >;
    readonly quoteAudit: (
      quote: ConfiguredPriceQuoteSnapshot,
      input: Parameters<Candidate>[0],
      identity: Parameters<Candidate>[1],
    ) => Promise<Awaited<ReturnType<Candidate>>["audit"]>;
  };

/** Current authorization and original-operation recovery, with persisted commercial policies. */
export function createCustomerConfiguredQuoteWithPoliciesComposition(
  options: CustomerConfiguredQuoteWithPoliciesOptions,
) {
  const pricing = (policies: ConfiguredQuotePolicies) =>
    createPostgresCurrentConfiguredQuoteService(options.policyTransactions, {
      ...policies,
      scope: options.scope,
      clock: { now: options.now },
    });
  const fixed = typeof options.policies === "function" ? null : pricing(options.policies);
  return createCustomerConfiguredQuoteComposition({
    ...options,
    candidate: async (input, identity) => {
      const service =
        fixed ??
        pricing(
          await (
            options.policies as (
              input: Parameters<Candidate>[0],
            ) => Promise<ConfiguredQuotePolicies>
          )(structuredClone(input)),
        );
      const quote = await service.create(await options.quoteRequest(input, identity));
      return { quote, audit: await options.quoteAudit(quote, input, identity) };
    },
  });
}

/** Explicit v2 HTTP port with durable expiry and current authorization for both modes. */
export function createCustomerConfiguredQuoteHttpComposition(
  options: CustomerConfiguredQuoteWithPoliciesOptions & {
    readonly expiryAudit: Parameters<typeof createPickupCartQuoteExpiryService>[0]["audit"];
  },
) {
  const attachment = createCustomerConfiguredQuoteWithPoliciesComposition(options);
  const requests = createPostgresConfiguredPriceQuoteRequestStore(
    options.pricingTransactions,
    options.scope,
    options.pricingReferences,
  );
  const common = {
    quoteVersion: 2 as const,
    scope: options.scope,
    sessions: options.sessions,
    requests,
    now: options.now,
    audit: options.expiryAudit,
    expiry: createPostgresCartQuoteExpiryStore(options.attachmentTransactions, options.scope, 2),
  };
  const expiry =
    options.orderType === "Pickup"
      ? createPickupCartQuoteExpiryService({
          ...common,
          binding: createPostgresPickupCartBindingReader(options.cartTransactions, options.scope),
        })
      : createDiningCartQuoteExpiryService({
          ...common,
          participation: options.participation,
          carts: {
            loadCart: createPostgresCartQueryStore(options.cartTransactions, options.scope).load,
          },
        });
  return createCustomerQuotePort({
    quoteVersion: 2,
    scope: options.scope,
    attachment,
    requests,
    expiry,
    now: options.now,
  });
}
