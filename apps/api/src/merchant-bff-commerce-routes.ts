/** Merchant BFF routes: commerce workbench (recipes, products, prices, allergens, menus, availability, option sets, tax classifications). Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { MerchantRecipeError } from "./merchant-recipes.js";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  sameOriginMutation,
  transactionConflictRetryLater,
} from "./merchant-bff-http.js";
import { MerchantProductError } from "./merchant-products.js";
import { Buffer } from "node:buffer";
import { MerchantPriceError } from "./merchant-prices.js";
import { MerchantAllergenError } from "./merchant-allergens.js";
import { MerchantMenuError } from "./merchant-menus.js";
import { MerchantAvailabilityError } from "./merchant-availability.js";
import { MerchantOptionSetError } from "./merchant-option-sets.js";
import { MerchantOptionPriceError } from "./merchant-option-prices.js";
import { MerchantStoreTaxError } from "./merchant-store-tax.js";
import { MerchantTaxClassificationError } from "./merchant-tax-classifications.js";
import { MerchantOptionRecipeError } from "./merchant-option-recipes.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantCommerceRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  // WP-2423 / DEC-RECIPE-AUTHORING: RECIPE-LIST / RECIPE-EDITOR reads and recipe commands.
  const recipeStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    ReviewRequired: 409,
    ReviewerNotIndependent: 403,
    Lifecycle: 409,
    InUse: 409,
    AllergenUndeclared: 409,
    LineInvalid: 422,
    Invalid: 400,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
  } as const;
  const recipeFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantRecipeError)) {
      denied(response);
      return;
    }
    response.status(recipeStatus[error.code]).json({ error: error.code, line: error.line });
  };
  router.post("/commerce/recipes/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { recipeReference?: unknown } | undefined;
    const recipeReference = body?.recipeReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "recipeReference" ||
      (recipeReference !== null &&
        (typeof recipeReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            recipeReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.recipes) {
      response.status(503).json({ error: "recipes_unavailable" });
      return;
    }
    void options.recipes
      .query({ sessionCookie, csrf, recipeReference: recipeReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => recipeFailure(response, error));
  });
  router.post("/commerce/recipes/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.recipes) {
      response.status(503).json({ error: "recipes_unavailable" });
      return;
    }
    void options.recipes
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => recipeFailure(response, error));
  });

  // WP-2423 / DEC-CAT-PRODUCT-ADMIN: CAT-PRODUCT-LIST / CAT-PRODUCT-DETAIL reads and Product commands.
  const productStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    SizeInUse: 409,
    TaxClassUnavailable: 422,
    Lifecycle: 409,
    Invalid: 400,
    PhotoTypeUnsupported: 400,
    PhotoTooLarge: 413,
    PhotoTooSmall: 400,
    PhotoUnreadable: 400,
    PhotoStorageUnavailable: 503,
  } as const;
  const productFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantProductError)) {
      denied(response);
      return;
    }
    response.status(productStatus[error.code]).json({ error: error.code });
  };
  router.post("/commerce/products/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { productReference?: unknown } | undefined;
    const productReference = body?.productReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "productReference" ||
      (productReference !== null &&
        (typeof productReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            productReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.products) {
      response.status(503).json({ error: "products_unavailable" });
      return;
    }
    void options.products
      .query({ sessionCookie, csrf, productReference: productReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => productFailure(response, error));
  });
  router.post("/commerce/products/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.products) {
      response.status(503).json({ error: "products_unavailable" });
      return;
    }
    void options.products
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => productFailure(response, error));
  });

  router.post("/commerce/products/photo", sameOriginMutation(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const productReference = exactHeader(request, "x-bop-product-reference");
    const operationReference = exactHeader(request, "x-bop-operation-reference");
    const contentType = exactHeader(request, "content-type");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      productReference === null ||
      operationReference === null ||
      contentType === null ||
      Object.keys(request.query).length !== 0 ||
      !Buffer.isBuffer(request.body)
    ) {
      denied(response);
      return;
    }
    if (!options.products) {
      response.status(503).json({ error: "PhotoStorageUnavailable" });
      return;
    }
    void options.products
      .uploadPhoto({
        sessionCookie,
        csrf,
        productReference,
        operationReference,
        contentType: contentType.toLowerCase(),
        bytes: new Uint8Array(request.body),
      })
      .then((result) => response.json(result))
      .catch((error: unknown) => productFailure(response, error));
  });

  // WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: PRICE-BOOK-LIST / PRICE-BOOK-EDITOR reads and commands.
  const priceStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    CodeTaken: 409,
    ApprovalRequired: 403,
    NotCovered: 409,
    NotPublished: 409,
    AlreadyAssigned: 409,
    Lifecycle: 409,
    Invalid: 400,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
  } as const;
  const priceFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantPriceError)) {
      denied(response);
      return;
    }
    response
      .status(priceStatus[error.code])
      .json({ error: error.code, sellableReferences: error.sellableReferences });
  };
  router.post("/commerce/pricing/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { priceBookReference?: unknown } | undefined;
    const priceBookReference = body?.priceBookReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "priceBookReference" ||
      (priceBookReference !== null &&
        (typeof priceBookReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            priceBookReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.prices) {
      response.status(503).json({ error: "prices_unavailable" });
      return;
    }
    void options.prices
      .query({ sessionCookie, csrf, priceBookReference: priceBookReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => priceFailure(response, error));
  });
  router.post("/commerce/pricing/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.prices) {
      response.status(503).json({ error: "prices_unavailable" });
      return;
    }
    void options.prices
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => priceFailure(response, error));
  });

  // WP-2423 / DEC-ALLERGEN-DECLARATIONS: CMP-ALLERGEN-REVIEW reads and commands.
  const allergenStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    RegistryMissing: 409,
    Invalid: 400,
    ApprovalRequired: 403,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
  } as const;
  const allergenFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantAllergenError)) {
      denied(response);
      return;
    }
    response.status(allergenStatus[error.code]).json({ error: error.code });
  };
  router.post("/compliance/allergens/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { itemReference?: unknown } | undefined;
    const itemReference = body?.itemReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "itemReference" ||
      (itemReference !== null &&
        (typeof itemReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            itemReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.allergens) {
      response.status(503).json({ error: "allergens_unavailable" });
      return;
    }
    void options.allergens
      .query({ sessionCookie, csrf, itemReference: itemReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => allergenFailure(response, error));
  });
  router.post("/compliance/allergens/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.allergens) {
      response.status(503).json({ error: "allergens_unavailable" });
      return;
    }
    void options.allergens
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => allergenFailure(response, error));
  });

  // WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER reads and commands.
  const menuStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    Frozen: 409,
    NotRevisable: 409,
    NotDiscardable: 409,
    ReviewBlocked: 409,
    OptionPriceMissing: 409,
    TaxNotCovered: 409,
    OptionRecipeMissing: 409,
    ApprovalRequired: 403,
    Lifecycle: 409,
    Invalid: 400,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
    NotSingleStore: 409,
  } as const;
  const menuFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantMenuError)) {
      denied(response);
      return;
    }
    response
      .status(menuStatus[error.code])
      .json(
        error.problem === null
          ? { error: error.code }
          : { error: error.code, problem: error.problem },
      );
  };
  router.post("/commerce/menus/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { menuReference?: unknown } | undefined;
    const menuReference = body?.menuReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "menuReference" ||
      (menuReference !== null &&
        (typeof menuReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            menuReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.menus) {
      response.status(503).json({ error: "menus_unavailable" });
      return;
    }
    void options.menus
      .query({ sessionCookie, csrf, menuReference: menuReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => menuFailure(response, error));
  });
  router.post("/commerce/menus/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.menus) {
      response.status(503).json({ error: "menus_unavailable" });
      return;
    }
    void options.menus
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => menuFailure(response, error));
  });

  // WP-2423 8.5: CAT-AVAILABILITY reads and commands for the selected Store.
  const availabilityStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    Invalid: 400,
  } as const;
  const availabilityFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantAvailabilityError)) {
      denied(response);
      return;
    }
    response.status(availabilityStatus[error.code]).json({ error: error.code });
  };
  router.post("/commerce/availability/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.availability) {
      response.status(503).json({ error: "availability_unavailable" });
      return;
    }
    void options.availability
      .query({ sessionCookie, csrf })
      .then((result) => response.json(result))
      .catch((error: unknown) => availabilityFailure(response, error));
  });
  router.post(
    "/commerce/availability/command",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.availability) {
        response.status(503).json({ error: "availability_unavailable" });
        return;
      }
      void options.availability
        .command({ sessionCookie, csrf, body: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => availabilityFailure(response, error));
    },
  );

  // WP-2423 slice 4: CAT-OPTIONSET-LIST / CAT-OPTIONSET-EDIT for the selected Store's Brand.
  const optionSetStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    Invalid: 400,
  } as const;
  const optionSetFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantOptionSetError)) {
      denied(response);
      return;
    }
    response.status(optionSetStatus[error.code]).json({ error: error.code });
  };
  const optionSetUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  router.post("/commerce/option-sets/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    const keys = body === undefined || body === null ? null : Object.keys(body);
    const optionSetReference =
      keys !== null && keys.length === 1 && keys[0] === "optionSetReference"
        ? body?.optionSetReference
        : null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      keys === null ||
      (keys.length !== 0 &&
        (typeof optionSetReference !== "string" || !optionSetUuid.test(optionSetReference)))
    ) {
      denied(response);
      return;
    }
    if (!options.optionSets) {
      response.status(503).json({ error: "option_sets_unavailable" });
      return;
    }
    void options.optionSets
      .query({ sessionCookie, csrf, optionSetReference: optionSetReference as string | null })
      .then((result) => response.json(result))
      .catch((error: unknown) => optionSetFailure(response, error));
  });
  router.post("/commerce/option-sets/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.optionSets) {
      response.status(503).json({ error: "option_sets_unavailable" });
      return;
    }
    void options.optionSets
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => optionSetFailure(response, error));
  });

  // WP-2423 slice 4.3: PRICE-OPTION-LIST for the selected Store's Brand.
  const optionPriceStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    ApprovalRequired: 409,
    Invalid: 400,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
  } as const;
  const optionPriceFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantOptionPriceError)) {
      denied(response);
      return;
    }
    response.status(optionPriceStatus[error.code]).json({ error: error.code });
  };
  router.post("/commerce/option-prices/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      body === null ||
      Object.keys(body).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.optionPrices) {
      response.status(503).json({ error: "option_prices_unavailable" });
      return;
    }
    void options.optionPrices
      .query({ sessionCookie, csrf })
      .then((result) => response.json(result))
      .catch((error: unknown) => optionPriceFailure(response, error));
  });
  router.post(
    "/commerce/option-prices/command",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.optionPrices) {
        response.status(503).json({ error: "option_prices_unavailable" });
        return;
      }
      void options.optionPrices
        .command({ sessionCookie, csrf, body: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => optionPriceFailure(response, error));
    },
  );

  // WP-2423 8.7: TAX-STORE-REVIEW (read only) for the selected Store.
  router.post("/commerce/tax-review/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as Record<string, unknown> | undefined;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      body === null ||
      Object.keys(body).length !== 0
    ) {
      denied(response);
      return;
    }
    if (!options.storeTax) {
      response.status(503).json({ error: "tax_review_unavailable" });
      return;
    }
    void options.storeTax
      .query({ sessionCookie, csrf })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantStoreTaxError)
          response.status(403).json({ error: error.code });
        else denied(response);
      });
  });

  // WP-2423 Store setup: CAT-TAX-CLASSIFICATION-LIST for the selected Store's Brand.
  const taxClassificationStatus = {
    PermissionDenied: 403,
    Invalid: 400,
    NotFound: 404,
    NameTaken: 409,
    Retired: 409,
    Conflict: 409,
    Unavailable: 503,
  } as const;
  const taxClassificationFailure = (response: express.Response, error: unknown) => {
    if (transactionConflictRetryLater(response, error)) return;
    if (!(error instanceof MerchantTaxClassificationError)) {
      response.status(503).set("Cache-Control", NO_STORE).json({ error: "Unavailable" });
      return;
    }
    response
      .status(taxClassificationStatus[error.code])
      .set("Cache-Control", NO_STORE)
      .json({ error: error.code });
  };
  for (const [path, method] of [
    ["/commerce/tax-classifications/query", "query"],
    ["/commerce/tax-classifications/command", "command"],
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      const body = request.body as Record<string, unknown> | undefined;
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0 ||
        body === undefined ||
        body === null ||
        (method === "query" && Object.keys(body).length !== 0)
      ) {
        denied(response);
        return;
      }
      const port = options.taxClassifications;
      if (!port) {
        response.status(503).set("Cache-Control", NO_STORE).json({ error: "Unavailable" });
        return;
      }
      void (
        method === "query"
          ? port.query({ sessionCookie, csrf })
          : port.command({ sessionCookie, csrf, body })
      )
        .then((result) => response.set("Cache-Control", NO_STORE).json(result))
        .catch((error: unknown) => taxClassificationFailure(response, error));
    });

  // WP-2423 slice 4.4: RECIPE-OPTION-LIST for the selected Store's Brand.
  const optionRecipeStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    NoRecipe: 409,
    IngredientMissing: 409,
    IngredientPresent: 409,
    UnitMismatch: 409,
    ItemUnavailable: 409,
    AllergenUndeclared: 409,
    ReviewRequired: 409,
    ReviewerNotIndependent: 409,
    Invalid: 400,
    SoleOperatorNotInEffect: 409,
    NeedsReverification: 409,
  } as const;
  const optionRecipeFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantOptionRecipeError)) {
      denied(response);
      return;
    }
    response
      .status(optionRecipeStatus[error.code])
      .json({ error: error.code, skuReference: error.skuReference });
  };
  router.post(
    "/commerce/option-recipes/query",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      const body = request.body as Record<string, unknown> | undefined;
      if (
        sessionCookie === null ||
        csrf === null ||
        csrf.length === 0 ||
        Object.keys(request.query).length !== 0 ||
        body === undefined ||
        body === null ||
        Object.keys(body).length !== 0
      ) {
        denied(response);
        return;
      }
      if (!options.optionRecipes) {
        response.status(503).json({ error: "option_recipes_unavailable" });
        return;
      }
      void options.optionRecipes
        .query({ sessionCookie, csrf })
        .then((result) => response.json(result))
        .catch((error: unknown) => optionRecipeFailure(response, error));
    },
  );
  router.post(
    "/commerce/option-recipes/command",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.optionRecipes) {
        response.status(503).json({ error: "option_recipes_unavailable" });
        return;
      }
      void options.optionRecipes
        .command({ sessionCookie, csrf, body: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => optionRecipeFailure(response, error));
    },
  );
}
