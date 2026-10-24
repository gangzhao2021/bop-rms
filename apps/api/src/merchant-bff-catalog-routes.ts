/** Merchant BFF routes: catalog products, categories, menus and product authoring. Registered by createMerchantBffRouter (merchant-bff.ts). */
import {
  MerchantProductDraftBaselineError,
  parseMerchantProductDraftBaselineResult,
  parseProductDraftBaselineRequest,
} from "./merchant-product-draft-baseline-query.js";
import { Buffer } from "node:buffer";
import {
  cookie,
  denied,
  exactHeader,
  rawHeaderValues,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import {
  MerchantProductCategoryLookupError,
  parseMerchantProductCategoryLookupResult,
  parseProductCategoryLookupRequest,
} from "./merchant-product-category-lookup-query.js";
import {
  CatalogError,
  CatalogProductListError,
  parseCatalogCategoryTreeFilters,
  parseCatalogProductEditorSnapshot,
  parseCatalogProductListView,
  parseProductPublicationSourceRequest,
} from "@rms/catalog";
import {
  MerchantCategoryTreeError,
  parseMerchantCategoryTreeResult,
} from "./merchant-category-tree-query.js";
import { decodeMerchantProductCommandScopeHeader } from "./merchant-product-command-scope.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantCatalogRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.get("/catalog/products/draft-baseline", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-draft-baseline");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,342}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let query: ReturnType<typeof parseProductDraftBaselineRequest>;
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 256 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      query = parseProductDraftBaselineRequest(JSON.parse(decoded));
    } catch {
      response.status(400).json({ error: "product_draft_baseline_invalid" });
      return;
    }
    if (!options.productDraftBaseline) {
      response.status(503).json({ error: "product_draft_baseline_unavailable" });
      return;
    }
    void options
      .productDraftBaseline({ sessionCookie, query })
      .then((view) => {
        const safe = parseMerchantProductDraftBaselineResult(view);
        if (safe.baseline !== null && safe.baseline.productReference !== query.productReference)
          throw new MerchantProductDraftBaselineError("Unavailable");
        response.json(safe);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof MerchantProductDraftBaselineError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "product_draft_baseline_" + suffix });
      });
  });
  router.get("/catalog/products/category-lookup", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-category-lookup");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,342}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let query: { readonly parentScreenId: ReturnType<typeof parseProductCategoryLookupRequest> };
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 256 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      query = { parentScreenId: parseProductCategoryLookupRequest(JSON.parse(decoded)) };
    } catch {
      response.status(400).json({ error: "product_category_lookup_invalid" });
      return;
    }
    if (!options.productCategoryLookup) {
      response.status(503).json({ error: "product_category_lookup_unavailable" });
      return;
    }
    void options
      .productCategoryLookup({ sessionCookie, query })
      .then((view) => {
        const safe = parseMerchantProductCategoryLookupResult(view);
        if (safe.lookup.parentScreenId !== query.parentScreenId)
          throw new MerchantProductCategoryLookupError("Unavailable");
        response.json(safe);
      })
      .catch((error: unknown) => {
        const code =
          error instanceof MerchantProductCategoryLookupError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "product_category_lookup_" + suffix });
      });
  });

  router.get("/catalog/categories", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-category-tree");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,5462}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let filters: unknown;
    try {
      const bytes = Buffer.from(headers[0], "base64url"),
        decoded = bytes.toString("utf8");
      if (
        bytes.length > 4096 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      filters = parseCatalogCategoryTreeFilters(JSON.parse(decoded));
    } catch {
      response.status(400).json({ error: "category_tree_invalid" });
      return;
    }
    if (!options.categoryTree) {
      response.status(503).json({ error: "category_tree_unavailable" });
      return;
    }
    void options
      .categoryTree({ sessionCookie, filters })
      .then((view) => {
        response.json(parseMerchantCategoryTreeResult(view));
      })
      .catch((error: unknown) => {
        const code = error instanceof MerchantCategoryTreeError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled" || code === "Stale"
                ? 409
                : 503;
        const suffix =
          code === "Invalid"
            ? "invalid"
            : code === "Denied"
              ? "denied"
              : code === "FeatureDisabled"
                ? "feature_disabled"
                : code === "Stale"
                  ? "stale"
                  : "unavailable";
        response.status(status).json({ error: "category_tree_" + suffix });
      });
  });

  router.get("/catalog/products", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const headers = rawHeaderValues(request, "x-bop-product-list");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      headers.length !== 1 ||
      !headers[0] ||
      !/^[A-Za-z0-9_-]{1,5462}$/u.test(headers[0])
    ) {
      denied(response);
      return;
    }
    let filters: unknown;
    try {
      const bytes = Buffer.from(headers[0], "base64url");
      const decoded = bytes.toString("utf8");
      if (
        bytes.length > 4096 ||
        bytes.toString("base64url") !== headers[0] ||
        !Buffer.from(decoded, "utf8").equals(bytes)
      )
        throw new Error("invalid");
      filters = JSON.parse(decoded);
    } catch {
      response.status(400).json({ error: "product_list_invalid" });
      return;
    }
    if (!options.productList) {
      response.status(503).json({ error: "product_list_unavailable" });
      return;
    }
    void options
      .productList({ sessionCookie, filters })
      .then((view) => {
        try {
          response.json(parseCatalogProductListView(view));
        } catch {
          throw new CatalogProductListError("Unavailable");
        }
      })
      .catch((error: unknown) => {
        const code = error instanceof CatalogProductListError ? error.code : "Unavailable";
        const status =
          code === "Invalid"
            ? 400
            : code === "Denied"
              ? 403
              : code === "FeatureDisabled"
                ? 409
                : code === "Stale"
                  ? 409
                  : 503;
        response.status(status).json({
          error:
            code === "Invalid"
              ? "product_list_invalid"
              : code === "Denied"
                ? "product_list_denied"
                : code === "FeatureDisabled"
                  ? "product_list_feature_disabled"
                  : code === "Stale"
                    ? "product_list_stale"
                    : "product_list_unavailable",
        });
      });
  });

  router.post("/catalog/menus/publication", sameOriginMutation(options), (request, response) => {
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
    if (!options.menuPublication) {
      response.status(503).json({ error: "menu_publication_unavailable" });
      return;
    }
    void options
      .menuPublication({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_publication_invalid"
              : status === 409
                ? "menu_publication_conflict"
                : status === 503
                  ? "menu_publication_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/menus/draft", sameOriginMutation(options), (request, response) => {
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
    if (!options.menuDraft) {
      response.status(503).json({ error: "menu_draft_unavailable" });
      return;
    }
    void options
      .menuDraft({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "menu_draft_invalid"
              : status === 409
                ? "menu_draft_conflict"
                : status === 503
                  ? "menu_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products", sameOriginMutation(options), (request, response) => {
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
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productCreation) {
      response.status(503).json({ error: "product_creation_unavailable" });
      return;
    }
    void options
      .productCreation({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_creation_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_creation_invalid"
              : status === 409
                ? "product_creation_conflict"
                : status === 503
                  ? "product_creation_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/draft", sameOriginMutation(options), (request, response) => {
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
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productDraft) {
      response.status(503).json({ error: "product_draft_unavailable" });
      return;
    }
    void options
      .productDraft({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_draft_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_CODE_CONFLICT",
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_draft_invalid"
              : status === 409
                ? "product_draft_conflict"
                : status === 503
                  ? "product_draft_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/lifecycle", sameOriginMutation(options), (request, response) => {
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
    const scopeHeaders = rawHeaderValues(request, "x-bop-catalog-scope");
    let expectedScope;
    try {
      if (scopeHeaders.length !== 1) throw new Error("invalid");
      expectedScope = decodeMerchantProductCommandScopeHeader(scopeHeaders[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productLifecycle) {
      response.status(503).json({ error: "product_lifecycle_unavailable" });
      return;
    }
    void options
      .productLifecycle({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_lifecycle_feature_disabled" });
          return;
        }
        if (!(error instanceof CatalogError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : [
                  "CATALOG_VERSION_CONFLICT",
                  "CATALOG_IDEMPOTENCY_CONFLICT",
                  "CATALOG_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "CATALOG_DEPENDENCY_UNAVAILABLE"
                ? 503
                : 403;
        response.status(status).json({
          error:
            status === 400
              ? "product_lifecycle_invalid"
              : status === 409
                ? "product_lifecycle_conflict"
                : status === 503
                  ? "product_lifecycle_unavailable"
                  : "request_denied",
        });
      });
  });

  router.post("/catalog/products/editor", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0
    ) {
      denied(response);
      return;
    }
    let expectedScope;
    try {
      const headers = rawHeaderValues(request, "x-bop-catalog-scope");
      if (headers.length !== 1) throw Error();
      expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
    } catch {
      denied(response);
      return;
    }
    if (!options.productEditor) {
      response.status(503).json({ error: "product_editor_unavailable" });
      return;
    }
    let query;
    try {
      query = parseProductPublicationSourceRequest(request.body);
    } catch {
      response.status(400).json({ error: "product_editor_invalid" });
      return;
    }
    void options
      .productEditor({ sessionCookie, csrf, query, expectedScope })
      .then((value) => {
        let view;
        try {
          view = parseCatalogProductEditorSnapshot(value);
        } catch {
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        }
        if (
          view.productReference !== query.productReference ||
          view.aggregateVersion !== query.expectedAggregateVersion ||
          view.brandReference !== expectedScope.brandReference
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        response.json(view);
      })
      .catch((error: unknown) => {
        const status =
          error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
            ? 400
            : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
              ? 403
              : 503;
        response.status(status).json({
          error:
            status === 400
              ? "product_editor_invalid"
              : status === 403
                ? "request_denied"
                : "product_editor_unavailable",
        });
      });
  });

  router.post(
    "/catalog/products/option-binding-picker",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const headers = rawHeaderValues(request, "x-bop-catalog-scope");
        if (headers.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(headers[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productOptionPicker) {
        response.status(503).json({ error: "product_option_picker_unavailable" });
        return;
      }
      void options
        .productOptionPicker({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch((error: unknown) => {
          const feature = error instanceof MerchantProductWriteFeatureDisabled;
          const code =
            error instanceof CatalogError ? error.code : "CATALOG_DEPENDENCY_UNAVAILABLE";
          const status =
            feature || code === "CATALOG_VERSION_CONFLICT"
              ? 409
              : code === "CATALOG_INPUT_INVALID"
                ? 400
                : code === "CATALOG_PERMISSION_DENIED"
                  ? 403
                  : 503;
          response.status(status).json({
            error: feature
              ? "product_option_picker_feature_disabled"
              : status === 409
                ? "product_option_picker_conflict"
                : status === 400
                  ? "product_option_picker_invalid"
                  : status === 403
                    ? "request_denied"
                    : "product_option_picker_unavailable",
          });
        });
    },
  );

  for (const mode of ["context", "resolve", "inspect", "register"] as const)
    router.post(
      "/catalog/products/selling-units/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          Object.keys(request.query).length !== 0
        ) {
          denied(response);
          return;
        }
        let expectedScope;
        try {
          const values = rawHeaderValues(request, "x-bop-catalog-scope");
          if (values.length !== 1) throw Error();
          expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
        } catch {
          denied(response);
          return;
        }
        if (!options.productSellingUnitRegistry) {
          response.status(503).json({ error: "product_selling_unit_registry_unavailable" });
          return;
        }
        void options.productSellingUnitRegistry[mode]({
          sessionCookie,
          csrf,
          command: request.body,
          expectedScope,
        })
          .then((result) => response.json(result))
          .catch((error: unknown) => {
            const status =
              error instanceof MerchantProductWriteFeatureDisabled
                ? 409
                : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                  ? 400
                  : error instanceof CatalogError &&
                      [
                        "CATALOG_VERSION_CONFLICT",
                        "CATALOG_IDEMPOTENCY_CONFLICT",
                        "CATALOG_LIFECYCLE_CONFLICT",
                      ].includes(error.code)
                    ? 409
                    : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                      ? 403
                      : 503;
            response.status(status).json({
              error:
                status === 400
                  ? "product_selling_unit_registry_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "product_selling_unit_registry_conflict"
                      : "product_selling_unit_registry_unavailable",
            });
          });
      },
    );

  router.post(
    "/catalog/products/authoring-context",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      let expectedScope;
      try {
        const values = rawHeaderValues(request, "x-bop-catalog-scope");
        if (values.length !== 1) throw Error();
        expectedScope = decodeMerchantProductCommandScopeHeader(values[0]);
      } catch {
        denied(response);
        return;
      }
      if (!options.productAuthoringContext) {
        response.status(503).json({ error: "product_authoring_context_unavailable" });
        return;
      }
      void options
        .productAuthoringContext({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          const status =
            error instanceof MerchantProductWriteFeatureDisabled
              ? 409
              : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                ? 400
                : error instanceof CatalogError &&
                    [
                      "CATALOG_VERSION_CONFLICT",
                      "CATALOG_IDEMPOTENCY_CONFLICT",
                      "CATALOG_LIFECYCLE_CONFLICT",
                    ].includes(error.code)
                  ? 409
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : 503;
          response.status(status).json({
            error:
              status === 400
                ? "product_authoring_context_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_authoring_context_conflict"
                    : "product_authoring_context_unavailable",
          });
        });
    },
  );
}
