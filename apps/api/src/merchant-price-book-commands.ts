import {
  parseMerchantPriceBookTransport,
  bindMerchantPriceBookTransport,
} from "./merchant-price-book-transport.js";
import { sha256Hex } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import {
  analyzePriceCoverage,
  createPostgresPriceBookRepository,
  createPriceBookService,
  createPriceBookSnapshot,
  parsePricingReference,
  PriceBookWorkflowError,
  type CurrencyMetadataSnapshot,
  type PriceBookAction,
  type PriceBookSnapshot,
  type PriceResolutionContext,
} from "@rms/pricing";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createPriceBookDraftAuthorSource } from "./price-book-draft-author-source.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Transaction = ConsumerTransaction;
const methods = {
  CreateDraft: "createDraft",
  ReplaceDraft: "replaceDraft",
  Publish: "publish",
  Archive: "archive",
} as const;
const fail = (code: ConstructorParameters<typeof PriceBookWorkflowError>[0]): never => {
  throw new PriceBookWorkflowError(code);
};
function command(value: unknown, action: PriceBookAction) {
  const keys = [
    "candidate",
    "operationReference",
    "requestedAt",
    ...(action === "CreateDraft" ? [] : ["priceBookReference", "expectedAggregateVersion"]),
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail("PRICE_BOOK_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  )
    return fail("PRICE_BOOK_INPUT_INVALID");
  return value as Record<string, unknown>;
}

/** Application mutation boundary: BFF validates the cookie and CSRF, then the
 * transaction re-resolves the same current session and Brand permissions.
 * Owner facts and coverage come from server adapters, never command fields.
 */
export interface MerchantPriceBookCommandRequest {
  sessionCookie: unknown;
  csrf: unknown;
  action: PriceBookAction;
  input: unknown;
}

export function createMerchantPriceBookCommands(options: {
  merchant: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  currencyMetadata: CurrencyMetadataSnapshot;
  auditReference(operationReference: string): string;
  validateFacts(transaction: Transaction, snapshot: PriceBookSnapshot): Promise<boolean>;
  coverageContexts(
    transaction: Transaction,
    snapshot: PriceBookSnapshot,
  ): Promise<readonly PriceResolutionContext[]>;
}) {
  const resolveScope = createMerchantBrandScope(options.merchant);
  const execute = async (request: MerchantPriceBookCommandRequest, transport: boolean) => {
    const session = await options.authentication.authorize({
      sessionCookie: request.sessionCookie,
      csrf: request.csrf,
    });
    if (!Object.hasOwn(methods, request.action)) return fail("PRICE_BOOK_INPUT_INVALID");
    const decoded = transport
      ? parseMerchantPriceBookTransport(request.action, request.input)
      : null;
    let raw: Record<string, unknown> = decoded ?? command(request.input, request.action);
    let candidate = decoded ? null : createPriceBookSnapshot(raw.candidate as PriceBookSnapshot);
    const operation = parsePricingReference(raw.operationReference);
    const book = decoded?.priceBookReference ?? candidate?.priceBookReference;
    if (!book) return fail("PRICE_BOOK_INPUT_INVALID");
    return options.merchant.transactions.run(async (identityTransaction) => {
      const transaction: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await identityTransaction.query(sql, values);
          if (!result || typeof result !== "object")
            return fail("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null &&
              (typeof count.value !== "number" ||
                !Number.isSafeInteger(count.value) ||
                count.value < 0))
          )
            return fail("PRICE_BOOK_DEPENDENCY_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };
      const scope = await resolveScope(
        transaction,
        request.sessionCookie,
        session.sessionReference,
      );
      const brand = parsePricingReference(scope.context.brand.brandReference);
      if (
        candidate &&
        (candidate.brandReference !== brand ||
          (request.action !== "CreateDraft" && raw.priceBookReference !== book))
      )
        return fail("PRICE_BOOK_PERMISSION_DENIED");
      const permission = async (action: string) => {
        const decision = await scope.authorizeAction(action);
        return decision?.effect === "Allow" &&
          decision.scopeKind === "Brand" &&
          decision.action === action
          ? decision
          : null;
      };
      const checkCoverage = async (snapshot: PriceBookSnapshot) => {
        const contexts = await options.coverageContexts(transaction, snapshot);
        if (
          contexts.length === 0 ||
          contexts.some((item) => item.brandReference !== brand) ||
          analyzePriceCoverage(snapshot, contexts).some((item) => item.status !== "Covered")
        )
          return fail("PRICE_BOOK_COVERAGE_INVALID");
        return contexts;
      };
      const repository = createPostgresPriceBookRepository({
        brandReference: brand,
        currencyMetadata: options.currencyMetadata,
        transactions: { run: (work) => work(transaction) },
        authorize: async (_tx, input) => {
          if (
            input.brandReference !== brand ||
            (input.priceBookReference !== null && input.priceBookReference !== book) ||
            !(await permission("pricing.price-book.manage")) ||
            (request.action === "Publish" && !(await permission("pricing.price-book.approve")))
          )
            return false;
          if (input.record) {
            if (
              input.record.action !== request.action ||
              !(await options.validateFacts(transaction, input.record.aggregate))
            )
              return false;
            if (input.record.action === "Publish") await checkCoverage(input.record.aggregate);
          }
          return true;
        },
        appendEvent: async (_tx, record) => {
          await appendEventInTransaction(transaction, {
            eventId: record.operationReference,
            eventType: record.event.eventType,
            schemaVersion: 1,
            occurredAt: record.event.occurredAt,
            producerModule: "@rms/pricing",
            tenantId: brand,
            aggregateType: "PriceBook",
            aggregateId: record.aggregate.priceBookReference,
            aggregateVersion: BigInt(record.aggregate.aggregateVersion),
            correlationId: record.operationReference,
            actor: { type: "Actor", actorId: scope.actorReference },
            payload: { ...record.event },
            redactionClassification: "indirect_identifier",
            replayMetadata: {},
          });
        },
      });
      const author = createPriceBookDraftAuthorSource({
        brandReference: brand,
        repository: () => repository,
      });
      // Acquire the operation fence before any draft-author book fence.
      // Replays do not depend on new publication coverage or mutable facts.
      const prior = await repository.resolveOperation(operation);
      if (decoded) {
        raw = bindMerchantPriceBookTransport(request.action, decoded, {
          brandReference: brand,
          currencyMetadata: options.currencyMetadata,
          requestedAt: prior?.aggregate.createdAt ?? options.merchant.now(),
        });
        candidate = createPriceBookSnapshot(raw.candidate as PriceBookSnapshot);
      }
      if (!candidate) return fail("PRICE_BOOK_INPUT_INVALID");
      const contexts =
        request.action === "Publish" && prior === null ? await checkCoverage(candidate) : [];
      const service = createPriceBookService({
        repository,
        references: {
          hashIntent: (value) => "sha256:" + sha256Hex(value),
          equals: (a, b) => a === b,
        },
        facts: { validate: (snapshot) => options.validateFacts(transaction, snapshot) },
        authorization: {
          authorize: async (input) => {
            const manage = await permission("pricing.price-book.manage");
            if (!manage) return null;
            const provenance =
              input.action === "Publish"
                ? await author.load(transaction, input.priceBookReference)
                : null;
            return {
              tenantContext: scope.context,
              permission: manage,
              approvalPermission:
                input.action === "Publish" ? await permission("pricing.price-book.approve") : null,
              draftAuthorActorReference: provenance?.actorReference ?? null,
              audit: {
                auditId: parsePricingReference(options.auditReference(input.operationReference)),
                brandId: brand,
                actor: { type: "User", reference: scope.actorReference },
                actionCode: "PRICING_PRICE_BOOK_" + input.action.toUpperCase(),
                targetType: "PricingPriceBook",
                targetId: input.priceBookReference,
                correlationId: input.operationReference,
                occurredAt: input.observedAt,
                reasonCode: "AUTHORIZED_OPERATION",
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "CONFIGURATION_AUDIT",
                retentionPolicyVersion: 1,
              },
            };
          },
        },
      });
      return service[methods[request.action]](
        request.action === "Publish" ? { ...raw, coverageContexts: contexts } : raw,
      );
    });
  };
  return Object.freeze({
    execute: (request: MerchantPriceBookCommandRequest) => execute(request, false),
    executeTransport: (request: MerchantPriceBookCommandRequest) => execute(request, true),
  });
}
