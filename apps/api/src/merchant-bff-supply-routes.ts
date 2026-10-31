/** Merchant BFF routes: inventory items, stock places, opening counts, receipts, counts and waste. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { MerchantInventoryItemError } from "./merchant-inventory-items.js";
import { cookie, denied, exactHeader, sameOriginMutation } from "./merchant-bff-http.js";
import { MerchantStockPlaceError } from "./merchant-stock-places.js";
import { MerchantOpeningCountError } from "./merchant-opening-count.js";
import { MerchantStoreReceiptError } from "./merchant-store-receipts.js";
import { MerchantStockCountError } from "./merchant-stock-counts.js";
import { MerchantStoreWasteError } from "./merchant-store-waste.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantSupplyRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  // WP-2423: INV-ITEM-LIST / DETAIL / CREATE / EDIT reads and Inventory Item commands.
  const inventoryItemStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    StockRemaining: 409,
    Locked: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const inventoryItemFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantInventoryItemError)) {
      denied(response);
      return;
    }
    response.status(inventoryItemStatus[error.code]).json({ error: error.code });
  };
  router.post("/supply/items/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "afterInternalCode,itemReference,lifecycle,search" ||
      (body.itemReference !== null &&
        (typeof body.itemReference !== "string" || !uuid.test(body.itemReference))) ||
      (body.search !== null && (typeof body.search !== "string" || body.search.length > 80)) ||
      (body.lifecycle !== null &&
        !["Active", "Inactive", "Archived"].includes(String(body.lifecycle))) ||
      (body.afterInternalCode !== null &&
        (typeof body.afterInternalCode !== "string" ||
          !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(body.afterInternalCode)))
    ) {
      denied(response);
      return;
    }
    if (!options.inventoryItems) {
      response.status(503).json({ error: "inventory_items_unavailable" });
      return;
    }
    void options.inventoryItems
      .query({
        sessionCookie,
        csrf,
        itemReference: body.itemReference as string | null,
        search: body.search as string | null,
        lifecycle: body.lifecycle as "Active" | "Inactive" | "Archived" | null,
        afterInternalCode: body.afterInternalCode as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => inventoryItemFailure(response, error));
  });
  router.post("/supply/items/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.inventoryItems) {
      response.status(503).json({ error: "inventory_items_unavailable" });
      return;
    }
    void options.inventoryItems
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => inventoryItemFailure(response, error));
  });

  // WP-2423 / DEC-INV-LOCATIONS: INV-LOCATION-LIST reads and Stock Site / Storage Location commands.
  const stockPlaceStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    DefaultRequired: 409,
    StockRemaining: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const stockPlaceFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStockPlaceError)) {
      denied(response);
      return;
    }
    response.status(stockPlaceStatus[error.code]).json({ error: error.code });
  };
  for (const [path, handler] of [
    ["/supply/locations/query", "query"],
    ["/supply/locations/command", "command"],
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0 ||
        (handler === "query" &&
          (request.body === undefined || Object.keys(request.body as object).length !== 0))
      ) {
        denied(response);
        return;
      }
      if (!options.stockPlaces) {
        response.status(503).json({ error: "stock_places_unavailable" });
        return;
      }
      void (
        handler === "query"
          ? options.stockPlaces.query({ sessionCookie, csrf })
          : options.stockPlaces.command({ sessionCookie, csrf, body: request.body })
      )
        .then((result) => response.json(result))
        .catch((error: unknown) => stockPlaceFailure(response, error));
    });

  // WP-2423 / DEC-INV-OPENING: INV-OPENING-COUNT reads and opening count commands.
  const openingCountStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyPosted: 409,
    StockExists: 409,
    LineInvalid: 422,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const openingCountFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantOpeningCountError)) {
      denied(response);
      return;
    }
    response
      .status(openingCountStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/opening-count/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { countReference?: unknown } | undefined;
    const countReference = body?.countReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "countReference" ||
      (countReference !== null &&
        (typeof countReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            countReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.openingCount) {
      response.status(503).json({ error: "opening_count_unavailable" });
      return;
    }
    void options.openingCount
      .query({ sessionCookie, csrf, countReference })
      .then((result) => response.json(result))
      .catch((error: unknown) => openingCountFailure(response, error));
  });
  router.post("/supply/opening-count/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.openingCount) {
      response.status(503).json({ error: "opening_count_unavailable" });
      return;
    }
    void options.openingCount
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => openingCountFailure(response, error));
  });

  // WP-2423 / DEC-INV-DIRECT-RECEIPT: Store direct receipts.
  const receiptStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyVoided: 409,
    StockUsed: 409,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const receiptFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStoreReceiptError)) {
      denied(response);
      return;
    }
    response
      .status(receiptStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/receipts/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { receiptReference?: unknown; before?: unknown } | undefined;
    const receiptReference = body?.receiptReference ?? null,
      before = body?.before ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,receiptReference" ||
      (receiptReference !== null &&
        (typeof receiptReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            receiptReference,
          ))) ||
      (before !== null &&
        (typeof before !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(before)))
    ) {
      denied(response);
      return;
    }
    if (!options.storeReceipts) {
      response.status(503).json({ error: "store_receipts_unavailable" });
      return;
    }
    void options.storeReceipts
      .query({
        sessionCookie,
        csrf,
        receiptReference: receiptReference as string | null,
        before: before as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => receiptFailure(response, error));
  });
  router.post("/supply/receipts/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeReceipts) {
      response.status(503).json({ error: "store_receipts_unavailable" });
      return;
    }
    void options.storeReceipts
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => receiptFailure(response, error));
  });

  // WP-2423 / DEC-INV-STOCK-COUNT: INV-COUNT-LIST / INV-COUNT-WORKBENCH.
  const countStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    AlreadyOpen: 409,
    StockChanged: 409,
    Incomplete: 409,
    NotIndependent: 403,
    State: 409,
    LineInvalid: 422,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const countFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStockCountError)) {
      denied(response);
      return;
    }
    response
      .status(countStatus[error.code])
      .json({ error: error.code, lineReferences: error.lineReferences });
  };
  const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  const nullable = (value: unknown, pattern: RegExp) =>
    value === null || (typeof value === "string" && pattern.test(value));
  router.post("/supply/counts/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { countReference?: unknown; before?: unknown } | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,countReference" ||
      !nullable(body.countReference, uuidV7Pattern) ||
      !nullable(body.before, instantPattern)
    ) {
      denied(response);
      return;
    }
    if (!options.stockCounts) {
      response.status(503).json({ error: "stock_counts_unavailable" });
      return;
    }
    void options.stockCounts
      .query({
        sessionCookie,
        csrf,
        countReference: body.countReference as string | null,
        before: body.before as string | null,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => countFailure(response, error));
  });
  router.post("/supply/counts/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.stockCounts) {
      response.status(503).json({ error: "stock_counts_unavailable" });
      return;
    }
    void options.stockCounts
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => countFailure(response, error));
  });

  // WP-2423 / DEC-INV-WASTE: INV-WASTE-WIZARD and the waste record list with reviews.
  const wasteStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    NotEnoughStock: 409,
    AlreadyReviewed: 409,
    NotIndependent: 403,
    LineInvalid: 422,
    Invalid: 400,
  } as const;
  const wasteFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStoreWasteError)) {
      denied(response);
      return;
    }
    response
      .status(wasteStatus[error.code])
      .json({ error: error.code, lineReference: error.lineReference });
  };
  router.post("/supply/waste/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as
      { wasteReference?: unknown; before?: unknown; needsReviewOnly?: unknown } | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).sort().join(",") !== "before,needsReviewOnly,wasteReference" ||
      !nullable(body.wasteReference, uuidV7Pattern) ||
      !nullable(body.before, instantPattern) ||
      typeof body.needsReviewOnly !== "boolean"
    ) {
      denied(response);
      return;
    }
    if (!options.storeWaste) {
      response.status(503).json({ error: "store_waste_unavailable" });
      return;
    }
    void options.storeWaste
      .query({
        sessionCookie,
        csrf,
        wasteReference: body.wasteReference as string | null,
        before: body.before as string | null,
        needsReviewOnly: body.needsReviewOnly,
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => wasteFailure(response, error));
  });
  router.post("/supply/waste/command", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeWaste) {
      response.status(503).json({ error: "store_waste_unavailable" });
      return;
    }
    void options.storeWaste
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => wasteFailure(response, error));
  });
}
