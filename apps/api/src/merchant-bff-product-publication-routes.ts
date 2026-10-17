/** Merchant BFF routes: product publication and store capability. Registered by createMerchantBffRouter (merchant-bff.ts). */
import {
  cookie,
  denied,
  exactHeader,
  rawHeaderValues,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { decodeMerchantProductCommandScopeHeader } from "./merchant-product-command-scope.js";
import { CatalogError } from "@rms/catalog";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantProductPublicationRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.post("/store-capability", sameOriginMutation(options), (request, response) => {
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
    if (!options.storeCapability) {
      response.status(503).json({ error: "store_capability_unavailable" });
      return;
    }
    void options
      .storeCapability({ sessionCookie, csrf, query: request.body })
      .then((decision) => response.json(decision))
      .catch(() => {
        response.status(503).json({ error: "store_capability_unavailable" });
      });
  });

  router.post(
    "/catalog/products/publication/management",
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
      if (!options.productPublicationManagement) {
        response.status(503).json({ error: "product_publication_management_unavailable" });
        return;
      }
      void options
        .productPublicationManagement({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
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
                ? "product_publication_management_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_management_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/management/v2",
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
      if (!options.productPublicationManagementV2) {
        response.status(503).json({ error: "product_publication_management_unavailable" });
        return;
      }
      void options
        .productPublicationManagementV2({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
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
                ? "product_publication_management_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_management_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/validation-report/v2",
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
      if (!options.productPublicationValidationReportV2) {
        response.status(503).json({ error: "product_publication_validation_report_unavailable" });
        return;
      }
      void options
        .productPublicationValidationReportV2({
          sessionCookie,
          csrf,
          query: request.body,
          expectedScope,
        })
        .then((view) => response.json(view))
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
                ? "product_publication_validation_report_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_publication_validation_report_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/resolve/v1",
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
      if (!options.productPublicationResolution) {
        response.status(503).json({ error: "product_publication_resolution_unavailable" });
        return;
      }
      void options
        .productPublicationResolution({ sessionCookie, csrf, command: request.body, expectedScope })
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
                ? "product_publication_resolution_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_publication_resolution_conflict"
                    : "product_publication_resolution_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/authoring-resolution",
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
      if (!options.productAuthoringResolution) {
        response.status(503).json({ error: "product_authoring_resolution_unavailable" });
        return;
      }
      void options
        .productAuthoringResolution({ sessionCookie, csrf, command: request.body, expectedScope })
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
                ? "product_authoring_resolution_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_authoring_resolution_conflict"
                    : "product_authoring_resolution_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/warning-acknowledgements/v1",
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
      if (!options.productPublicationWarningAcknowledgement) {
        response
          .status(503)
          .json({ error: "product_publication_warning_acknowledgement_unavailable" });
        return;
      }
      void options
        .productPublicationWarningAcknowledgement({
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
                ? "product_publication_warning_acknowledgement_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "product_publication_warning_acknowledgement_conflict"
                    : "product_publication_warning_acknowledgement_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/v2",
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
      if (!options.productPublicationV2) {
        response.status(503).json({ error: "product_publication_unavailable" });
        return;
      }
      void options
        .productPublicationV2({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (error instanceof MerchantProductWriteFeatureDisabled) {
            response.status(409).json({ error: "product_publication_feature_disabled" });
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
                ? "product_publication_invalid"
                : status === 409
                  ? "product_publication_conflict"
                  : status === 503
                    ? "product_publication_unavailable"
                    : "request_denied",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/scope-journals",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.productScopeJournals) {
        response.status(503).json({ error: "product_scope_journals_unavailable" });
        return;
      }
      void options
        .productScopeJournals({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
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
                ? "product_scope_journals_invalid"
                : status === 403
                  ? "request_denied"
                  : "product_scope_journals_unavailable",
          });
        });
    },
  );

  router.post(
    "/catalog/products/publication/query",
    sameOriginMutation(options),
    (request, response) => {
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
      if (!options.productPublicationQuery) {
        response.status(503).json({ error: "product_publication_unavailable" });
        return;
      }
      void options
        .productPublicationQuery({ sessionCookie, csrf, query: request.body, expectedScope })
        .then((view) => response.json(view))
        .catch(() => {
          response.status(503).json({ error: "product_publication_unavailable" });
        });
    },
  );

  router.post("/catalog/products/publication", sameOriginMutation(options), (request, response) => {
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
    if (!options.productPublication) {
      response.status(503).json({ error: "product_publication_unavailable" });
      return;
    }
    void options
      .productPublication({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (error instanceof MerchantProductWriteFeatureDisabled) {
          response.status(409).json({ error: "product_publication_feature_disabled" });
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
              ? "product_publication_invalid"
              : status === 409
                ? "product_publication_conflict"
                : status === 503
                  ? "product_publication_unavailable"
                  : "request_denied",
        });
      });
  });
}
