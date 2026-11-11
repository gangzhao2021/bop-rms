import { cartParticipation } from "./customer-dining-cart-composition.js";
import type { QuoteLineSinceAdded } from "./customer-quote.js";
import { createCustomerQuotePort } from "./customer-quote-composition.js";
import {
  CartError,
  createPickupCartQuoteExpiryService,
  createDiningCartQuoteExpiryService,
  createPostgresCartQuoteExpiryStore,
  createConfiguredCustomerQuoteService,
  createPostgresCartQueryStore,
  createPostgresCartLineEvidenceStore,
  createPostgresAnyCartQuoteReader,
  createPostgresConfiguredCartQuoteStore,
  createPostgresPickupCartBindingReader,
  createPostgresCartLineFirstQuoteReader,
  type ConfiguredCustomerQuoteOptions,
  type DiningCartCheckoutHoldPort,
} from "@rms/ordering";
import {
  createPostgresCatalogOrderSnapshotSource,
  createPostgresCatalogSelectionService,
  createPostgresCurrentMenuReleaseStore,
} from "@rms/catalog";
import {
  createPostgresConfiguredPriceQuoteHistoryReader,
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
      /** WP-2423 M35 (DEC-STAFF-ROUND-SPEED): one guest check in one transaction. */
      readonly together?: Extract<ConfiguredCustomerQuoteOptions, { orderType: "DineIn" }>["together"];
      /** DEC-DINING-ANY-PARTICIPANT-SUBMIT: Dining's current hold of the table Cart version by
       * another participant's checkout; required for a table's Cart. */
      readonly checkoutHold: DiningCartCheckoutHoldPort;
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
  const releases = createPostgresCurrentMenuReleaseStore(options.catalogTransactions, scope);
  const selection = createPostgresCatalogSelectionService(
    options.catalogTransactions,
    { ...options.catalogScope, ...scope, orderType: options.orderType },
    { ...options.catalogSafety, clock: { now: options.now } },
  );
  const lineEvidence = createPostgresCartLineEvidenceStore(options.attachmentTransactions, scope);
  const latestQuotes = createPostgresAnyCartQuoteReader(options.attachmentTransactions, scope);
  return createConfiguredCustomerQuoteService({
    scope,
    sessions: options.sessions,
    audit: options.audit,
    references: options.references,
    now: options.now,
    pricingChannelCode: options.pricingChannelCode,
    evidence: {
      currentMenuVersion: async (observedAt) =>
        (
          await releases.load({
            menuReference: options.catalogScope.menuReference,
            channelCode: options.catalogScope.channelCode,
            orderTypeCode: options.catalogScope.orderTypeCode,
            observedAt,
          })
        )?.menuVersionReference ?? null,
      validateSelection: (input) => selection.validateSelection(input),
      replace: (input) => lineEvidence.replace(input),
    },
    ...(options.orderType === "Pickup"
      ? {
          orderType: "Pickup" as const,
          binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
        }
      : {
          orderType: "DineIn" as const,
          // WP-2423 item 6: a table checking out is said as such, never as a Store fault.
          participation: cartParticipation(options.participation),
          ...(options.together === undefined ? {} : { together: options.together }),
          checkoutHold: options.checkoutHold,
        }),
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
      // Owner #26 (DEC-PRICE-HOLD): the confirmed price is answered again until its hold ends.
      loadLatest: latestQuotes.loadLatest,
    },
    pricing: {
      // WP-2423 (DEC-PRICE-HOLD §2): today's price, worked out and not recorded (no request,
      // no audit written), so a cut inside a hold is passed on.
      async estimate(input, identity) {
        const candidate = await options.candidate(
          structuredClone(input),
          Object.freeze({ ...identity }),
        );
        return decodeConfiguredPriceQuoteSnapshot(
          encodeConfiguredPriceQuoteSnapshot(candidate.quote),
        );
      },
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
          participation: cartParticipation(options.participation),
          ...(options.together === undefined ? {} : { together: options.together }),
          carts: {
            loadCart: createPostgresCartQueryStore(options.cartTransactions, options.scope).load,
          },
        });
  const firstQuotes = createPostgresCartLineFirstQuoteReader(
    options.attachmentTransactions,
    options.scope,
  );
  const history = createPostgresConfiguredPriceQuoteHistoryReader(
    options.pricingTransactions,
    options.scope,
  );
  const catalog = createPostgresCatalogOrderSnapshotSource(
    options.catalogTransactions,
    { ...options.catalogScope, ...options.scope, orderType: options.orderType },
    { ...options.catalogSafety, clock: { now: options.now } },
    options.catalogReferences,
  );
  return createCustomerQuotePort({
    quoteVersion: 2,
    scope: options.scope,
    attachment,
    requests,
    expiry,
    now: options.now,
    // WP-2423 price-hold-dish-changes (DEC-PRICE-HOLD §3, M74): what this cart was first priced at
    // for each line, and whether the dish is shown with another name or other allergens since.
    sinceAdded: async (quote) => {
      const first = await firstQuotes.load({
        cartReference: String(quote.cartReference),
        lineReferences: quote.lines.map((line) => String(line.lineReference)),
      });
      const earlier = new Map<string, Promise<ConfiguredPriceQuoteSnapshot | null>>();
      const lines: Omit<QuoteLineSinceAdded, "changes">[] = [];
      const keys: Parameters<typeof catalog.dishChanges>[0][number][] = [];
      const sameProduct: boolean[] = [];
      for (const line of quote.lines) {
        const found = first.get(String(line.lineReference));
        if (found === undefined || found.quoteReference === String(quote.quoteReference)) continue;
        if (found.quoteVersion !== 2) continue;
        let read = earlier.get(found.quoteReference);
        if (read === undefined) {
          read = history.load(found.quoteReference);
          earlier.set(found.quoteReference, read);
        }
        const before = (await read)?.lines.find(
          (value) => String(value.lineReference) === String(line.lineReference),
        );
        if (before === undefined) continue;
        lines.push({
          cartItemReference: String(line.lineReference),
          quantity: before.quantity,
          subtotal: before.subtotal,
        });
        sameProduct.push(
          String(before.productVersionReference) === String(line.productVersionReference),
        );
        keys.push({
          sellableReference: String(line.sellableReference),
          productVersionReference: String(line.productVersionReference),
          fromMenuVersionReference: String(before.menuVersionReference),
          toMenuVersionReference: String(line.menuVersionReference),
        });
      }
      if (lines.length === 0) return [];
      const changes = await catalog.dishChanges(keys);
      return lines.map((line, index) => ({
        ...line,
        // Another product version is another dish: shown again in full.
        changes:
          sameProduct[index] === true
            ? (changes[index] ?? ["Name", "Allergens"])
            : (["Name", "Allergens"] as const),
      }));
    },
  });
}
