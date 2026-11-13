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

/** The customer-facing menu fields only (also the counter item picker, WP-2423 Q7). */
export function publicFound(value: CustomerMenuFound): CustomerMenuFound {
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
          ...(sellable.alcohol === undefined ? {} : { alcohol: sellable.alcohol }),
          optionRules: sellable.optionRules.map((rule) => ({
            ...(rule.semanticsVersion === 2
              ? {
                  semanticsVersion: 2,
                  activationOptionReferences: [...(rule.activationOptionReferences ?? [])],
                }
              : {}),
            name: rule.name,
            bindingReference: rule.bindingReference,
            optionSetVersionReference: rule.optionSetVersionReference,
            minimumSelections: rule.minimumSelections,
            maximumSelections: rule.maximumSelections,
            enabledOptionReferences: [...rule.enabledOptionReferences],
            defaultOptionReferences: [...rule.defaultOptionReferences],
            ...(rule.comboPart === true ? { comboPart: true as const } : {}),
            options: rule.options.map((option) => ({
              optionReference: option.optionReference,
              name: option.name,
              maximumQuantity: option.maximumQuantity,
              conflictOptionReferences: [...option.conflictOptionReferences],
              selectedByDefault: option.selectedByDefault,
              ...(rule.semanticsVersion === 2
                ? { defaultQuantity: Number(option.defaultQuantity) }
                : {}),
              ...(option.offeredNow === false ? { offeredNow: false as const } : {}),
              // WP-2423 (M22, M24): sold out at the Store today (only with offeredNow false).
              ...(option.offeredNow === false && option.soldOut === true
                ? { soldOut: true as const }
                : {}),
              incrementalPrice: { ...option.incrementalPrice },
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
            ...(sellable.allergenDisclosure.byChoice === undefined
              ? {}
              : { byChoice: sellable.allergenDisclosure.byChoice }),
            ...(sellable.allergenDisclosure.byOption === undefined
              ? {}
              : { byOption: sellable.allergenDisclosure.byOption }),
            // WP-2423 (M77, M167): a recipe changed what the dish contains since the listing.
            ...(sellable.allergenDisclosure.justUpdated === true
              ? { justUpdated: true as const }
              : {}),
          },
          displayPrice:
            sellable.displayPrice.status === "Available"
              ? {
                  status: "Available" as const,
                  amount: sellable.displayPrice.amount,
                  currency: sellable.displayPrice.currency,
                  reason: null,
                }
              : {
                  status: "Unavailable" as const,
                  amount: null,
                  currency: null,
                  reason: sellable.displayPrice.reason,
                },
          taxDisplayContext: {
            status: sellable.taxDisplayContext.status,
            taxInclusive: sellable.taxDisplayContext.taxInclusive,
            reason: sellable.taxDisplayContext.reason,
          },
          // WP-2423 menu descriptions and photos: the published description and photo sizes.
          description: sellable.description,
          photo:
            sellable.photo === null
              ? null
              : {
                  altText: sellable.photo.altText,
                  width: sellable.photo.width,
                  height: sellable.photo.height,
                  renditions: sellable.photo.renditions.map((rendition) => ({
                    url: rendition.url,
                    contentType: rendition.contentType,
                    width: rendition.width,
                    height: rendition.height,
                  })),
                },
        })),
      })),
    },
  };
}

/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): a guest menu is the same public answer for every
 * phone at the Store. Each read did the whole work again: the menu, every dish's offer, price,
 * each choice's price (one database round trip per choice), sold-out marks and stock, and the
 * answer was built and serialized per phone. 20 phones opening the menu together took 1.5-2.5 s
 * (20 cart reads together took 0.4-0.6 s), and in a burst the menu reads held the process and its
 * connections while every other answer waited past the 15 s clients wait.
 *
 * Now the phones asking for the same menu at the same moment share one read, and a menu read in
 * the last `customerMenuReuseMs` is given again. Commercially: a dish staff mark sold out shows so
 * on a menu opened up to 3 s later; adding it is refused by the cart with its usual words, as for
 * any menu already open on a phone. Only a found menu is given again: "busy", "not found" and a
 * stale menu are always asked anew. The shared read works within its own answer time (the first
 * phone going away does not cut it for the others), and each phone's own answer time still holds.
 */
export const customerMenuReuseMs = 3_000;
const customerMenuShareLimit = 500;
export function createSharedCustomerMenuPort(
  port: CustomerMenuPort,
  options: {
    readonly reuseMs?: number;
    readonly nowMs?: () => number;
    /** Runs the shared read in its own answer time (apart from any one phone's request). */
    readonly detached?: <T>(work: () => Promise<T>) => Promise<T>;
  } = {},
): CustomerMenuPort {
  const reuseMs = options.reuseMs ?? customerMenuReuseMs;
  const nowMs = options.nowMs ?? Date.now;
  const detached = options.detached ?? (<T>(work: () => Promise<T>) => work());
  const flights = new Map<string, Promise<CustomerMenuQueryResult>>();
  const recent = new Map<
    string,
    { readonly at: number; readonly result: CustomerMenuQueryResult }
  >();
  return Object.freeze({
    getPublishedMenu(input: Readonly<CustomerMenuQueryInput>) {
      const key = JSON.stringify([
        input.publicStoreReference,
        input.channelCode,
        input.orderTypeCode,
        input.locale,
        input.searchTerm ?? null,
        input.sectionReference ?? null,
      ]);
      const kept = recent.get(key);
      if (kept !== undefined) {
        const age = nowMs() - kept.at;
        if (age >= 0 && age < reuseMs) return Promise.resolve(kept.result);
        recent.delete(key);
      }
      const flying = flights.get(key);
      if (flying !== undefined) return flying;
      const flight = detached(() => port.getPublishedMenu(input)).then((result) => {
        if (resultStatus(result) === "Found") {
          if (recent.size >= customerMenuShareLimit) {
            const oldest = recent.keys().next().value;
            if (oldest !== undefined) recent.delete(oldest);
          }
          recent.set(key, { at: nowMs(), result });
        }
        return result;
      });
      flights.set(key, flight);
      const settle = () => {
        if (flights.get(key) === flight) flights.delete(key);
      };
      flight.then(settle, settle);
      return flight;
    },
  });
}

/** The serialized public answer of each found menu result (one per shared read). */
const publicBodies = new WeakMap<object, string>();

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
            // A shared menu (createSharedCustomerMenuPort) is built and serialized once.
            let body = publicBodies.get(result);
            if (body === undefined) {
              body = JSON.stringify(publicFound(result as CustomerMenuFound));
              publicBodies.set(result, body);
            }
            response.status(200).type("application/json").send(body);
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
