import {
  listBrandOptionSets,
  listBrandProducts,
  loadBrandProduct,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  createPostgresOptionPriceAuthoringStore,
  OptionPriceAuthoringError,
  type CurrencyMetadataSnapshot,
  type OptionPriceAuthoringState,
  type OptionPriceRuleSnapshot,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 slice 4.3: PRICE-OPTION-LIST — what each option costs on each product (Brand-wide, every
 * size, channel and order type; 0 is an explicit price). As with price books, a price is drafted by
 * someone who may edit prices (pricing.price-book.manage) and takes effect only when someone else
 * who may approve prices (pricing.price-book.approve) publishes it. An option without a published
 * price cannot be ordered and keeps its product's options off the next menu publication.
 * Pilot publication policy (WP-2423): approval is the publishing approver's own action, recorded
 * with its audit; no separate approval queue.
 */
export class MerchantOptionPriceError extends Error {
  constructor(
    readonly code: "PermissionDenied" | "NotFound" | "Conflict" | "ApprovalRequired" | "Invalid",
  ) {
    super(code);
    this.name = "MerchantOptionPriceError";
  }
}
const fail = (code: MerchantOptionPriceError["code"]): never => {
  throw new MerchantOptionPriceError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
/** Minor units, 0 to 9,999.99. */
const amount = (value: unknown): string =>
  typeof value === "string" && /^(?:0|[1-9]\d{0,5})$/u.test(value) ? value : fail("Invalid");
const nullableVersion = (value: unknown): number | null =>
  value === null
    ? null
    : Number.isSafeInteger(value) && (value as number) >= 1
      ? (value as number)
      : fail("Invalid");
const exactKeys = (value: unknown, keys: string) => {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (Object.keys(r).sort().join(",") !== keys) return fail("Invalid");
  return r;
};

export interface OptionPriceInput {
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly amountMinor: string;
  /** The rule version the merchant saw (null: no price yet). */
  readonly expectedAggregateVersion: number | null;
  /** Whether the merchant saw a pending (unpublished) price, which this replaces. */
  readonly replacesPending: boolean;
}
export type OptionPriceCommandBody =
  | {
      readonly action: "SetPrices";
      readonly operationReference: string;
      readonly prices: readonly OptionPriceInput[];
    }
  | {
      readonly action: "Publish";
      readonly operationReference: string;
      readonly rules: readonly {
        readonly ruleReference: string;
        readonly expectedAggregateVersion: number;
      }[];
    };
export function parseOptionPriceCommandBody(value: unknown): OptionPriceCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  if (r.action === "SetPrices") {
    exactKeys(r, "action,operationReference,prices");
    if (!Array.isArray(r.prices) || r.prices.length < 1 || r.prices.length > 100)
      return fail("Invalid");
    const prices = r.prices.map((candidate: unknown) => {
      const p = exactKeys(
        candidate,
        "amountMinor,bindingReference,expectedAggregateVersion,optionReference,replacesPending",
      );
      if (typeof p.replacesPending !== "boolean") return fail("Invalid");
      const expected = nullableVersion(p.expectedAggregateVersion);
      if (expected === null && p.replacesPending) return fail("Invalid");
      return {
        replacesPending: p.replacesPending,
        bindingReference: ref(p.bindingReference),
        optionReference: ref(p.optionReference),
        amountMinor: amount(p.amountMinor),
        expectedAggregateVersion: expected,
      };
    });
    const keys = prices.map((p) => p.bindingReference + ":" + p.optionReference);
    if (new Set(keys).size !== keys.length) return fail("Invalid");
    return { action: "SetPrices", operationReference: ref(r.operationReference), prices };
  }
  if (r.action === "Publish") {
    exactKeys(r, "action,operationReference,rules");
    if (!Array.isArray(r.rules) || r.rules.length < 1 || r.rules.length > 100)
      return fail("Invalid");
    const rules = r.rules.map((candidate: unknown) => {
      const p = exactKeys(candidate, "expectedAggregateVersion,ruleReference");
      const version = nullableVersion(p.expectedAggregateVersion);
      return {
        ruleReference: ref(p.ruleReference),
        expectedAggregateVersion: version ?? fail("Invalid"),
      };
    });
    if (new Set(rules.map((rule) => rule.ruleReference)).size !== rules.length)
      return fail("Invalid");
    return { action: "Publish", operationReference: ref(r.operationReference), rules };
  }
  return fail("Invalid");
}

/** The Brand-wide price for every size, channel and order type — the only kind this page edits. */
const brandWide = (rule: OptionPriceRuleSnapshot | null) =>
  rule !== null &&
  rule.scopeKind === "Brand" &&
  rule.skuReference === null &&
  rule.channelCode === null &&
  rule.orderType === null &&
  rule.includedQuantity === 0;
/** The rule this page owns for a product's option: one per binding and option. */
export const optionPriceRuleReference = (bindingReference: string, optionReference: string) =>
  derivedReference(bindingReference, "option-price:" + optionReference);
// TEST-ONLY pilot publication policy identity (WP-2423 bypass list): four-eyes publication.
const pilotPolicy = {
  family: "01a00000-0000-7000-8000-00000000a423",
  policy: "01a00000-0000-7000-8000-00000000a424",
  publication: "01a00000-0000-7000-8000-00000000a425",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
};

export function createMerchantOptionPrices(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  currencyMetadata: CurrencyMetadataSnapshot;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const catalogTx = (tx: Tx) => tx as unknown as ProductLifecycleTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const may = async (action: string) => (await scope.authorizeAction(action))?.effect === "Allow";
    const permissions = {
      mayRead: (await may("pricing.price_book.read")) && (await may("catalog.option_set.read")),
      mayEdit: await may("pricing.price-book.manage"),
      mayApprove: await may("pricing.price-book.approve"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      tenant: String(scope.tenantReference),
      brand: String(scope.context.brand.brandReference),
      store: String(scope.selectedStoreReference),
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions,
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const name = (names: Readonly<Record<string, string>>, fallback = "") =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;

  /** Every product option customers can be offered: product, set, option. */
  async function productOptions(tx: Tx, s: Scope) {
    const sets = await listBrandOptionSets(catalogTx(tx), { brandReference: s.brand });
    const products = [];
    for (const summary of await listBrandProducts(catalogTx(tx) as never, {
      brandReference: s.brand,
    })) {
      const product = await loadBrandProduct(
        catalogTx(tx) as never,
        { brandReference: s.brand },
        summary.productReference,
      );
      if (product === null || product.draft.optionBindings.length === 0) continue;
      products.push({
        productReference: String(product.productReference),
        name: name(product.draft.localizedNames, product.internalCode),
        optionSets: product.draft.optionBindings.map((binding) => {
          const set = sets.find((item) => item.optionSetReference === binding.optionSetReference);
          return {
            bindingReference: String(binding.bindingReference),
            name: set ? name(set.draft.localizedNames, set.internalCode) : "",
            options: (set?.draft.options ?? [])
              .filter((option) => binding.enabledOptionReferences.includes(option.optionReference))
              .map((option) => ({
                optionReference: String(option.optionReference),
                name: name(option.localizedNames, option.stableCode),
                offered: option.lifecycle === "Active",
              })),
          };
        }),
      });
    }
    return products;
  }

  /** The Pricing option price writer bound to this request's transaction and authority. */
  function priceStore(tx: Tx, s: Scope, operation: string, mode: "Read" | "Write") {
    const observedAt = options.persistence.now();
    const validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
    const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
    const generated: Record<string, number> = {};
    const store = createPostgresOptionPriceAuthoringStore({
      transaction: tx as never,
      tenantReference: s.tenant,
      brandReference: s.brand,
      selectedStoreReference: s.store,
      actorReference: s.actor,
      currencyMetadata: options.currencyMetadata,
      originalObservedAt: observedAt,
      originalValidUntil: validUntil,
      clock: { now: () => options.persistence.now() },
      authority: {
        // The API admitted the Actor's Brand grants above for this request.
        async holdUntilTransactionCompletes(_tx, input) {
          const allowed =
            input.mode === "Read"
              ? s.permissions.mayRead
              : input.command?.action === "Publish"
                ? s.permissions.mayApprove
                : s.permissions.mayEdit;
          if (!allowed || (mode === "Read" && input.mode !== "Read"))
            throw new OptionPriceAuthoringError("OPTION_PRICE_PERMISSION_DENIED");
          return validUntil;
        },
      },
      publicationPolicyFamilyReference: pilotPolicy.family,
      publicationSource: {
        async withCurrentAuthorization(_tx, input, work) {
          if (!s.permissions.mayApprove || input.state.draftAuthorActorReference === null)
            throw new OptionPriceAuthoringError("OPTION_PRICE_PERMISSION_DENIED");
          const now = options.persistence.now();
          return work({
            policy: {
              profile: "PublishingOptionPricePublicationPolicyV1",
              tenantReference: s.tenant,
              brandReference: s.brand,
              familyReference: pilotPolicy.family,
              policyReference: pilotPolicy.policy,
              policyVersion: 1,
              approvalPolicy: "Required",
              effectiveFrom: pilotPolicy.effectiveFrom,
              effectiveUntil: null,
            },
            currentPolicyPublicationReference: pilotPolicy.publication,
            draftVersionReference: String(input.state.draft?.versionReference),
            draftSnapshotDigest: String(input.state.draft?.snapshotDigest),
            draftAuthorActorReference: String(input.state.draftAuthorActorReference),
            // The publishing approver's own decision, recorded by this operation's audit.
            approvalEvidenceReference: derivedReference(
              input.command.operationReference,
              "approval",
            ),
            approvedActorReference: s.actor,
            observedAt: now,
            // Never beyond this request's own authority window.
            validUntil: input.validUntil,
          });
        },
      },
      references: {
        generate: (kind) => {
          const index = generated[kind] ?? 0;
          generated[kind] = index + 1;
          return derivedReference(operation, kind + ":" + index);
        },
      },
      audit: {
        create: ({
          auditReference,
          command,
          actorReference,
          brandReference,
          occurredAt,
          mode: m,
        }) =>
          ({
            auditId: auditReference,
            brandId: brandReference,
            actor: { type: "User", reference: actorReference },
            actionCode:
              m === "Abandon"
                ? "PRICING_OPTION_PRICE_RESOLVE"
                : "PRICING_OPTION_PRICE_" + command.action.toUpperCase(),
            targetType: "PricingOptionPriceRule",
            targetId: command.ruleReference,
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: command.operationReference,
            occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          }) as never,
      },
      registerBeforeCommit: (_tx, guard, final) => {
        hooks.push({ guard, final });
      },
    });
    return {
      store,
      /** The writer's commit guards, run inside the transaction before it commits. */
      async beforeCommit() {
        await (tx as { query(sql: string, values: unknown[]): Promise<unknown> }).query(
          "SET CONSTRAINTS ALL IMMEDIATE",
          [],
        );
        for (const hook of hooks) await hook.guard();
        for (const hook of hooks) hook.final();
      },
    };
  }
  const priceView = (state: OptionPriceAuthoringState | null, viewer: string) => {
    const published =
      state !== null && brandWide(state.currentPublished) ? state.currentPublished : null;
    const draft = state !== null && brandWide(state.draft) ? state.draft : null;
    return {
      ruleReference: state?.ruleReference ?? null,
      aggregateVersion: state?.aggregateVersion ?? null,
      priceMinor: published?.unitAmount.amountMinor.toString() ?? null,
      pending:
        draft === null
          ? null
          : {
              priceMinor: draft.unitAmount.amountMinor.toString(),
              byViewer: state?.draftAuthorActorReference === viewer,
            },
    };
  };
  const mapError = (error: unknown): never => {
    if (error instanceof MerchantOptionPriceError) throw error;
    if (error instanceof OptionPriceAuthoringError) {
      const code = error.code;
      if (code === "OPTION_PRICE_PERMISSION_DENIED") return fail("PermissionDenied");
      if (code === "OPTION_PRICE_APPROVAL_REQUIRED") return fail("ApprovalRequired");
      if (
        code === "OPTION_PRICE_VERSION_CONFLICT" ||
        code === "OPTION_PRICE_IDEMPOTENCY_CONFLICT" ||
        code === "OPTION_PRICE_LIFECYCLE_CONFLICT" ||
        code === "OPTION_PRICE_CONFLICT"
      )
        return fail("Conflict");
      if (code === "OPTION_PRICE_INPUT_INVALID") return fail("Invalid");
    }
    throw error;
  };

  const query = async (input: { sessionCookie: unknown; csrf: unknown }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        const products = await productOptions(tx, s);
        const { store, beforeCommit } = priceStore(
          tx,
          s,
          derivedReference(s.actor, "read"),
          "Read",
        );
        const rows = [];
        try {
          for (const product of products) {
            const optionSets = [];
            for (const set of product.optionSets) {
              const optionRows = [];
              for (const option of set.options) {
                const states = await store.listForBinding({
                  bindingReference: set.bindingReference,
                  optionReference: option.optionReference,
                });
                const own = optionPriceRuleReference(set.bindingReference, option.optionReference);
                optionRows.push({
                  ...option,
                  ...priceView(
                    states.find((state) => state.ruleReference === own) ?? null,
                    s.actor,
                  ),
                });
              }
              optionSets.push({ ...set, options: optionRows });
            }
            rows.push({ ...product, optionSets });
          }
          await beforeCommit();
        } catch (error) {
          return mapError(error);
        }
        return {
          screenId: "PRICE-OPTION-LIST" as const,
          sourceAsOf: options.persistence.now(),
          currency: {
            code: options.currencyMetadata.currencyCode,
            minorUnitExponent: options.currencyMetadata.minorUnitExponent,
          },
          permissions: { mayEdit: s.permissions.mayEdit, mayApprove: s.permissions.mayApprove },
          products: rows,
        };
      }),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseOptionPriceCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run(async (tx) => {
        const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
        if (body.action === "SetPrices" ? !s.permissions.mayEdit : !s.permissions.mayApprove)
          fail("PermissionDenied");
        const products = await productOptions(tx, s);
        const { store, beforeCommit } = priceStore(tx, s, body.operationReference, "Write");
        const results: { ruleReference: string; aggregateVersion: number; status: string }[] = [];
        try {
          if (body.action === "SetPrices") {
            const at = options.persistence.now();
            for (const price of body.prices) {
              const offered = products.some((product) =>
                product.optionSets.some(
                  (set) =>
                    set.bindingReference === price.bindingReference &&
                    set.options.some((option) => option.optionReference === price.optionReference),
                ),
              );
              if (!offered) fail("NotFound");
              const rule = optionPriceRuleReference(price.bindingReference, price.optionReference);
              const state =
                (
                  await store.listForBinding({
                    bindingReference: price.bindingReference,
                    optionReference: price.optionReference,
                  })
                ).find((item) => item.ruleReference === rule) ?? null;
              const view = priceView(state, s.actor);
              // Already this price (published with nothing pending, or pending): nothing to do.
              // A retried request lands here too once its first attempt committed.
              if ((view.pending?.priceMinor ?? view.priceMinor) === price.amountMinor) continue;
              // The command is built only from what the merchant saw, so a retry is identical and
              // the writer replays it; a change by someone else meanwhile is a version conflict.
              const result = await store.execute({
                action: price.replacesPending ? "ReplaceDraft" : "CreateDraft",
                operationReference: derivedReference(
                  body.operationReference,
                  "price:" + price.bindingReference + ":" + price.optionReference,
                ),
                ruleReference: rule,
                expectedAggregateVersion: price.expectedAggregateVersion,
                bindingReference: price.replacesPending ? null : price.bindingReference,
                optionReference: price.replacesPending ? null : price.optionReference,
                content: {
                  skuReference: null,
                  scopeKind: "Brand",
                  scopeReference: null,
                  channelCode: null,
                  orderType: null,
                  unitAmountMinor: price.amountMinor,
                  includedQuantity: 0,
                  effectivePeriod: {
                    timeZone: s.timeZone,
                    effectiveFrom: localBoundary(at, s.timeZone),
                    effectiveUntil: null,
                  },
                },
              });
              results.push({
                ruleReference: rule,
                aggregateVersion: result.state?.aggregateVersion ?? 0,
                status: result.outcome,
              });
            }
          } else {
            for (const rule of body.rules) {
              const result = await store.execute({
                action: "Publish",
                operationReference: derivedReference(
                  body.operationReference,
                  "publish:" + rule.ruleReference,
                ),
                ruleReference: rule.ruleReference,
                expectedAggregateVersion: rule.expectedAggregateVersion,
                bindingReference: null,
                optionReference: null,
                content: null,
              });
              results.push({
                ruleReference: rule.ruleReference,
                aggregateVersion: result.state?.aggregateVersion ?? 0,
                status: result.outcome,
              });
            }
          }
          await beforeCommit();
        } catch (error) {
          return mapError(error);
        }
        return { status: "Applied" as const, results };
      }),
    );
  };
  return { query, command };
}
