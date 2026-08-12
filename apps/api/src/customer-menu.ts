import type {
  CustomerMenuFound,
  CustomerMenuQueryInput,
  CustomerMenuQueryResult,
} from "@rms/catalog";
import type { Request, RequestHandler, Response } from "express";

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const allowedQueryKeys = new Set(["channel", "orderType", "locale", "q", "section"]);

export interface CustomerMenuPort {
  getPublishedMenu(input: Readonly<CustomerMenuQueryInput>): Promise<CustomerMenuQueryResult>;
}

export interface CustomerMenuHandlerOptions {
  readonly now?: () => string;
  readonly port: CustomerMenuPort;
}

type ErrorCode =
  "menu_request_invalid" | "menu_not_found" | "menu_projection_stale" | "menu_service_unavailable";

const errors = Object.freeze({
  menu_request_invalid: Object.freeze({ status: 400, messageKey: "customer.menu.request_invalid" }),
  menu_not_found: Object.freeze({ status: 404, messageKey: "customer.menu.not_found" }),
  menu_projection_stale: Object.freeze({
    status: 503,
    messageKey: "customer.menu.projection_stale",
  }),
  menu_service_unavailable: Object.freeze({
    status: 503,
    messageKey: "customer.menu.service_unavailable",
  }),
} as const);

function sendError(response: Response, code: ErrorCode): void {
  const contract = errors[code];
  if (code === "menu_projection_stale" || code === "menu_service_unavailable") {
    response.setHeader("Retry-After", "5");
  }
  response.status(contract.status).json({
    schemaVersion: 1,
    error: { code, messageKey: contract.messageKey },
  });
}

function scalar(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError("invalid scalar");
  return value;
}

function optionalSearch(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new TypeError("invalid search");
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 100) throw new TypeError("invalid search");
  return normalized;
}

function parseInput(request: Request, now: () => string): CustomerMenuQueryInput {
  if (Object.keys(request.query).some((key) => !allowedQueryKeys.has(key))) {
    throw new TypeError("unknown query key");
  }
  const requestedAt = scalar(now(), instantPattern);
  if (new Date(Date.parse(requestedAt)).toISOString() !== requestedAt) {
    throw new TypeError("invalid clock");
  }
  const store = request.params.store_public_id;
  return Object.freeze({
    publicStoreReference: scalar(
      store,
      uuidV7Pattern,
    ) as CustomerMenuQueryInput["publicStoreReference"],
    channelCode: scalar(
      request.query.channel,
      codePattern,
    ) as CustomerMenuQueryInput["channelCode"],
    orderTypeCode: scalar(
      request.query.orderType,
      codePattern,
    ) as CustomerMenuQueryInput["orderTypeCode"],
    locale: scalar(request.query.locale, localePattern),
    requestedAt: requestedAt as CustomerMenuQueryInput["requestedAt"],
    searchTerm: optionalSearch(request.query.q),
    sectionReference:
      request.query.section === undefined
        ? null
        : (scalar(
            request.query.section,
            uuidV7Pattern,
          ) as CustomerMenuQueryInput["sectionReference"]),
  });
}

function resultStatus(value: unknown): CustomerMenuQueryResult["status"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as { status?: unknown }).status;
  return ["Found", "NotFound", "ProjectionStale", "Unavailable"].includes(String(status))
    ? (status as CustomerMenuQueryResult["status"])
    : null;
}

function publicFound(value: CustomerMenuFound): CustomerMenuFound {
  return {
    status: "Found",
    schemaVersion: value.schemaVersion,
    projection: {
      name: value.projection.name,
      version: value.projection.version,
      asOfUtc: value.projection.asOfUtc,
      sourceCheckpoint: value.projection.sourceCheckpoint,
      sourceAggregateVersion: value.projection.sourceAggregateVersion,
      freshnessStatus: value.projection.freshnessStatus,
      freshnessTargetMilliseconds: value.projection.freshnessTargetMilliseconds,
      stale: value.projection.stale,
      partial: value.projection.partial,
    },
    scope: {
      publicStoreReference: value.scope.publicStoreReference,
      channelCode: value.scope.channelCode,
      orderTypeCode: value.scope.orderTypeCode,
      effectiveAt: value.scope.effectiveAt,
    },
    menu: {
      menuReference: value.menu.menuReference,
      menuVersionReference: value.menu.menuVersionReference,
      releaseReference: value.menu.releaseReference,
      locale: value.menu.locale,
      name: value.menu.name,
      effectiveFrom: value.menu.effectiveFrom,
      effectiveUntil: value.menu.effectiveUntil,
      sections: value.menu.sections.map((section) => ({
        sectionReference: section.sectionReference,
        name: section.name,
        sellables: section.sellables.map((sellable) => ({
          sellableReference: sellable.sellableReference,
          productVersionReference: sellable.productVersionReference,
          name: sellable.name,
          presentationRole: sellable.presentationRole,
          pinned: sellable.pinned,
          availability: sellable.availability,
          optionRules: sellable.optionRules.map((rule) => ({
            bindingReference: rule.bindingReference,
            optionSetVersionReference: rule.optionSetVersionReference,
            minimumSelections: rule.minimumSelections,
            maximumSelections: rule.maximumSelections,
            enabledOptionReferences: [...rule.enabledOptionReferences],
            defaultOptionReferences: [...rule.defaultOptionReferences],
            options: rule.options.map((option) => ({
              optionReference: option.optionReference,
              name: option.name,
              maximumQuantity: option.maximumQuantity,
              conflictOptionReferences: [...option.conflictOptionReferences],
              selectedByDefault: option.selectedByDefault,
              incrementalPrice: {
                status: option.incrementalPrice.status,
                amount: option.incrementalPrice.amount,
                currency: option.incrementalPrice.currency,
                reason: option.incrementalPrice.reason,
              },
            })),
          })),
          allergenDisclosure: {
            registryVersionReference: sellable.allergenDisclosure.registryVersionReference,
            items: sellable.allergenDisclosure.items.map((allergen) => ({
              allergenReference: allergen.allergenReference,
              code: allergen.code,
              name: allergen.name,
              classification: allergen.classification,
            })),
            allergenFreeClaim: false,
            assistanceCode: sellable.allergenDisclosure.assistanceCode,
          },
          displayPrice: {
            status: sellable.displayPrice.status,
            amount: sellable.displayPrice.amount,
            currency: sellable.displayPrice.currency,
            reason: sellable.displayPrice.reason,
          },
          taxDisplayContext: {
            status: sellable.taxDisplayContext.status,
            taxInclusive: sellable.taxDisplayContext.taxInclusive,
            reason: sellable.taxDisplayContext.reason,
          },
        })),
      })),
    },
  };
}

export class CustomerMenuHandler {
  readonly #now: () => string;
  readonly #port: CustomerMenuPort;

  constructor({ now = () => new Date().toISOString(), port }: CustomerMenuHandlerOptions) {
    this.#now = now;
    this.#port = port;
  }

  handler(): RequestHandler {
    return async (request, response) => {
      let input: CustomerMenuQueryInput;
      try {
        input = parseInput(request, this.#now);
      } catch {
        sendError(response, "menu_request_invalid");
        return;
      }
      let result: CustomerMenuQueryResult;
      try {
        result = await this.#port.getPublishedMenu(input);
      } catch {
        sendError(response, "menu_service_unavailable");
        return;
      }
      switch (resultStatus(result)) {
        case "Found":
          try {
            response.status(200).json(publicFound(result as CustomerMenuFound));
          } catch {
            sendError(response, "menu_service_unavailable");
          }
          return;
        case "NotFound":
          sendError(response, "menu_not_found");
          return;
        case "ProjectionStale":
          sendError(response, "menu_projection_stale");
          return;
        case "Unavailable":
        default:
          sendError(response, "menu_service_unavailable");
      }
    };
  }
}

export const unavailableCustomerMenuHandler: RequestHandler = (_request, response) => {
  sendError(response, "menu_service_unavailable");
};
