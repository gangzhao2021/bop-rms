import {
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSessionEntryTransactionRunner,
  type GuestSessionServiceOptions,
} from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  CartError,
  createPickupCartQuoteService,
  createPostgresCartQueryStore,
  createPostgresCartQuoteStore,
  createPostgresPickupCartBindingReader,
  parseCartQuoteAttachment,
  parseOrderingReference,
  type CartQueryTransactionRunner,
  type PickupCartQuoteOptions,
  type CartQuoteAttachment,
  type PricingCartInput,
} from "@rms/ordering";
import {
  createPostgresPriceQuoteRequestStore,
  decodePriceQuoteSnapshot,
  encodePriceQuoteSnapshot,
  parsePriceQuoteRequestRecord,
  PriceQuoteRequestError,
  type PriceQuoteRequestStore,
  type PriceQuoteSnapshot,
  type PriceQuoteQueryTransactionRunner,
} from "@rms/pricing";
import type { CustomerQuotePort, QuoteCartCommand, QuoteCartResult } from "./customer-quote.js";

type AttachmentEntry = ReturnType<typeof createPickupCartQuoteService>;
const unavailable = Object.freeze({ status: "Unavailable" } as const);
function closed(value: unknown, fields: string[]) {
  return readClosedRecord(value, fields, "ACTOR_SHAPE_INVALID");
}
function copyCommand(value: QuoteCartCommand) {
  const raw = closed(value, [
    "cartReference",
    "expectedCartVersion",
    "guestCredential",
    "csrfCredential",
    "idempotencyKey",
    "requestedAt",
  ]);
  parseCanonicalInstant(raw.requestedAt);
  if (
    !Number.isSafeInteger(raw.expectedCartVersion) ||
    Number(raw.expectedCartVersion) < 1 ||
    Number(raw.expectedCartVersion) > 2147483647
  )
    throw new Error();
  return Object.freeze({
    cartReference: parseOrderingReference(raw.cartReference),
    expectedCartVersion: Number(raw.expectedCartVersion),
    sessionCredential: parseGuestRawCredential(raw.guestCredential),
    csrfCredential: parseGuestRawCredential(raw.csrfCredential),
    operationReference: parseOrderingReference(raw.idempotencyKey),
  });
}
function receipt(
  value: unknown,
  command: ReturnType<typeof copyCommand>,
  scope: { brandReference: string; storeReference: string },
) {
  const raw = closed(value, ["status", "attachment"]);
  if (raw.status !== "Attached" && raw.status !== "AlreadyAttached") throw new Error();
  const result = parseCartQuoteAttachment(raw.attachment);
  if (
    result.cartReference !== command.cartReference ||
    result.cartVersion !== command.expectedCartVersion ||
    result.operationReference !== command.operationReference ||
    result.brandReference !== scope.brandReference ||
    result.storeReference !== scope.storeReference
  )
    throw new Error();
  return result;
}
function matchesQuote(quote: PriceQuoteSnapshot, attachment: CartQuoteAttachment) {
  if (
    quote.quoteReference !== String(attachment.quoteReference) ||
    quote.quoteVersion !== attachment.quoteVersion ||
    quote.brandReference !== String(attachment.brandReference) ||
    quote.storeReference !== String(attachment.storeReference) ||
    quote.cartReference !== String(attachment.cartReference) ||
    quote.cartVersion !== attachment.cartVersion ||
    quote.inputDigest !== String(attachment.quoteInputDigest) ||
    quote.createdAt !== attachment.quoteCreatedAt ||
    quote.expiresAt !== attachment.quoteExpiresAt ||
    quote.currencyMetadata.currencyCode !== attachment.currencyCode ||
    quote.currencyMetadata.metadataVersion !== attachment.currencyMetadataVersion ||
    String(quote.currencyMetadata.metadataVersionReference) !==
      attachment.currencyMetadataVersionReference ||
    JSON.stringify(quote.warnings) !== JSON.stringify(attachment.warnings) ||
    quote.lines.length !== attachment.lines.length
  )
    return false;
  for (const key of ["subtotal", "discount", "tax", "fee", "total"] as const) {
    if (
      quote[key].amountMinor !== attachment[key].amountMinor ||
      quote[key].currencyCode !== attachment[key].currencyCode
    )
      return false;
  }
  return attachment.lines.every((line) =>
    quote.lines.some(
      (candidate) =>
        String(candidate.lineReference) === line.lineReference &&
        String(candidate.sellableReference) === line.sellableReference &&
        candidate.quantity === line.quantity &&
        String(candidate.productVersionReference) === line.productVersionReference &&
        String(candidate.menuVersionReference) === line.menuVersionReference,
    ),
  );
}
function initialFailure(error: unknown): QuoteCartResult {
  if (!(error instanceof CartError)) return unavailable;
  switch (error.code) {
    case "CART_PERMISSION_DENIED":
    case "CART_UNAVAILABLE":
      return { status: "NotFound" };
    case "CART_VERSION_CONFLICT":
      return { status: "VersionConflict" };
    case "CART_IDEMPOTENCY_CONFLICT":
      return { status: "IdempotencyConflict" };
    case "CART_QUOTE_INVALID":
    case "CART_QUOTE_EXPIRED":
      return { status: "InvalidConfiguration" };
    default:
      return unavailable;
  }
}

function copyPricingInput(input: PricingCartInput): PricingCartInput {
  const snapshot = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

export function createCustomerQuotePort(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly attachment: AttachmentEntry;
  readonly requests: Pick<PriceQuoteRequestStore, "resolve">;
  readonly now: () => string;
}): CustomerQuotePort {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  return Object.freeze({
    async quoteCart(input: QuoteCartCommand): Promise<QuoteCartResult> {
      let command: ReturnType<typeof copyCommand>;
      try {
        command = copyCommand(input);
      } catch {
        return unavailable;
      }
      let saved: unknown;
      try {
        saved = await options.attachment.attach(command);
      } catch (error) {
        return initialFailure(error);
      }
      // Any failure after an attempted successful command preserves outcome uncertainty.
      try {
        const first = receipt(saved, command, scope);
        const observedAt = parseCanonicalInstant(options.now());
        if (
          String(observedAt) < first.attachedAt ||
          String(observedAt) >= first.idempotencyExpiresAt
        )
          return unavailable;
        const result = await options.requests.resolve({
          operationReference: first.operationReference,
          guestSessionReference: first.guestSessionReference,
          cartReference: first.cartReference,
          cartVersion: first.cartVersion,
          observedAt,
        });
        const raw = closed(result, ["record", "quote"]);
        const record = parsePriceQuoteRequestRecord(raw.record);
        const quote = decodePriceQuoteSnapshot(
          encodePriceQuoteSnapshot(raw.quote as PriceQuoteSnapshot),
        );
        if (
          String(record.operationReference) !== first.operationReference ||
          String(record.guestSessionReference) !== first.guestSessionReference ||
          String(record.brandReference) !== first.brandReference ||
          String(record.storeReference) !== first.storeReference ||
          String(record.cartReference) !== first.cartReference ||
          record.cartVersion !== first.cartVersion ||
          record.quoteReference !== quote.quoteReference ||
          record.createdAt > first.attachedAt ||
          observedAt < record.createdAt ||
          observedAt >= record.idempotencyExpiresAt ||
          !matchesQuote(quote, first)
        )
          return unavailable;
        const confirmed = receipt(await options.attachment.attach(command), command, scope);
        const finalAt = parseCanonicalInstant(options.now());
        if (
          finalAt < observedAt ||
          finalAt >= record.idempotencyExpiresAt ||
          String(finalAt) >= first.idempotencyExpiresAt
        )
          return unavailable;
        if (
          JSON.stringify(confirmed, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          ) !==
          JSON.stringify(first, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          )
        )
          return unavailable;
        return Object.freeze({
          status: record.quoteOutcome === "Created" ? "Created" : "Current",
          quote,
        });
      } catch {
        return unavailable;
      }
    },
  });
}

export interface CustomerQuoteCompositionOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly session: Pick<GuestSessionServiceOptions, "binding" | "credentials">;
  readonly sessionTransactions: GuestSessionEntryTransactionRunner;
  readonly cartTransactions: CartQueryTransactionRunner;
  readonly attachmentTransactions: CartQueryTransactionRunner;
  readonly pricingTransactions: PriceQuoteQueryTransactionRunner;
  readonly references: PickupCartQuoteOptions["references"];
  readonly pricingReferences: Parameters<typeof createPostgresPriceQuoteRequestStore>[2];
  readonly audit: PickupCartQuoteOptions["audit"];
  readonly candidate: (
    input: PricingCartInput,
    identity: Parameters<PickupCartQuoteOptions["pricing"]["quoteCart"]>[1],
  ) => Promise<Pick<Parameters<PriceQuoteRequestStore["append"]>[0], "quote" | "audit">>;
  readonly now: () => string;
}

/** Public owner composition only. Callers own all bounded transaction runners and authoritative facts. */
export function createCustomerQuoteComposition(
  options: CustomerQuoteCompositionOptions,
): CustomerQuotePort {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const sessions = new GuestSessionService({
    ...options.session,
    store: createPostgresGuestSessionEntryStore(options.sessionTransactions, scope),
    admission: { consume: async () => null },
    now: options.now,
  });
  const carts = createPostgresCartQueryStore(options.cartTransactions, scope);
  const attachments = createPostgresCartQuoteStore(
    options.attachmentTransactions,
    scope,
    options.references,
  );
  const requests = createPostgresPriceQuoteRequestStore(
    options.pricingTransactions,
    scope,
    options.pricingReferences,
  );
  const attachment = createPickupCartQuoteService({
    scope,
    sessions,
    binding: createPostgresPickupCartBindingReader(options.cartTransactions, scope),
    repository: {
      loadCart: carts.load,
      resolveOperation: attachments.resolveOperation,
      attach: attachments.attach,
    },
    references: options.references,
    audit: options.audit,
    now: options.now,
    pricing: {
      async quoteCart(source, sourceIdentity) {
        try {
          const input = copyPricingInput(source);
          const identity = Object.freeze({
            operationReference: parseOrderingReference(sourceIdentity.operationReference),
            guestSessionReference: parseOrderingReference(sourceIdentity.guestSessionReference),
          });
          const lookup = {
            ...identity,
            cartReference: input.cartReference,
            cartVersion: input.cartVersion,
            observedAt: input.requestedAt,
          };
          const existing = await requests.resolve(lookup);
          if (existing !== null) return existing.quote;
          const candidate = closed(await options.candidate(input, identity), ["quote", "audit"]);
          const quote = decodePriceQuoteSnapshot(
            encodePriceQuoteSnapshot(candidate.quote as PriceQuoteSnapshot),
          );
          if (
            String(quote.brandReference) !== input.brandReference ||
            String(quote.storeReference) !== input.storeReference ||
            String(quote.cartReference) !== input.cartReference ||
            quote.cartVersion !== input.cartVersion ||
            quote.lines.length !== input.lines.length ||
            quote.lines.some(
              (line) =>
                line.resolvedPrice.orderType !== null &&
                line.resolvedPrice.orderType !== input.orderType,
            ) ||
            input.lines.some(
              (line) =>
                line.optionSelections.length !== 0 ||
                !quote.lines.some(
                  (q) =>
                    String(q.lineReference) === line.lineReference &&
                    String(q.sellableReference) === line.sellableReference &&
                    q.quantity === line.quantity &&
                    String(q.productVersionReference) ===
                      line.catalogSelectionEvidence.productVersionReference &&
                    String(q.menuVersionReference) ===
                      line.catalogSelectionEvidence.menuVersionReference,
                ),
            )
          )
            throw new CartError("CART_QUOTE_INVALID");
          const result = await requests.append({
            ...identity,
            observedAt: input.requestedAt,
            quote,
            audit: candidate.audit as Parameters<PriceQuoteRequestStore["append"]>[0]["audit"],
          });
          return result.quote;
        } catch (error) {
          if (error instanceof CartError) throw error;
          if (error instanceof PriceQuoteRequestError && error.code === "QUOTE_REQUEST_CONFLICT")
            throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
        }
      },
    },
  });
  return createCustomerQuotePort({ scope, attachment, requests, now: options.now });
}
