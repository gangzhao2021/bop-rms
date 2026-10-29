/** Merchant BFF routes: store setup, references, payment configuration, receipt artifacts and store profiles. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import {
  parseStoreAdministrationReference,
  StoreSetupOperationError,
  StoreSetupReferenceError,
} from "@rms/store";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  safeRead,
  sameOriginMutation,
  transactionConflictRetryLater,
} from "./merchant-bff-http.js";
import { Buffer } from "node:buffer";
import { parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import { parseTaxConfigClassificationChoices } from "./merchant-tax-config-workbench-values.js";
import { bindMerchantStoreSetupCommand } from "./merchant-store-setup-command.js";
import { bindMerchantStoreSetupReferenceCommand } from "./merchant-store-setup-reference-command.js";
import { StorePaymentConfigurationError } from "@rms/payment";
import { bindMerchantStorePaymentConfigurationCommand } from "./merchant-store-payment-configuration-command.js";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
import { bindMerchantReceiptTemplateArtifactCommand } from "./merchant-receipt-template-artifact-command.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { MerchantStoreReceiptProfileError } from "./merchant-store-receipt-profile.js";
import { MerchantStorePublicProfileError } from "./merchant-store-public-profile.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
import { MerchantStoreFeaturesError } from "./merchant-store-features.js";

export function installMerchantStoreSetupRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  // WP-2423 item 8 ⑦ DEC-STORE-FEATURES: read or change the modules the Store uses.
  router.post("/store/features", sameOriginMutation(options), (request, response) => {
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
    if (!options.storeFeatures) {
      response.status(503).json({ error: "store_features_unavailable" });
      return;
    }
    void options
      .storeFeatures({ sessionCookie, csrf, command: request.body })
      .then((result) => response.set("Cache-Control", NO_STORE).json(result))
      .catch((error: unknown) => {
        if (!(error instanceof MerchantStoreFeaturesError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "STORE_FEATURES_INPUT_INVALID"
            ? 400
            : error.code === "STORE_FEATURES_PERMISSION_DENIED"
              ? 403
              : error.code === "STORE_FEATURES_CHANGED"
                ? 409
                : 503;
        response
          .status(status)
          .set("Cache-Control", NO_STORE)
          .json({ error: error.code.toLowerCase() });
      });
  });
  const storeSetupFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof StoreSetupOperationError ? error.code : undefined;
    const invalid = code === "STORE_SETUP_OPERATION_INPUT_INVALID";
    const forbidden = code === "STORE_SETUP_OPERATION_PERMISSION_DENIED";
    const conflict =
      code === "STORE_SETUP_OPERATION_VERSION_CONFLICT" ||
      code === "STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT";
    // WP-2423 Q15/Q16: an empty Brand classification registry is an answer, not an outage.
    const none = code === "STORE_SETUP_OPERATION_CLASSIFICATIONS_NOT_REGISTERED";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : none ? 404 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_setup_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_setup_conflict"
              : none
                ? "store_setup_classifications_not_registered"
                : "store_setup_unavailable",
      });
  };
  router.get("/store-setup", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetup;
    if (!port) {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storeSetupFailure(response, error));
  });
  router.get("/store-setup/fee-context-classifications", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        text = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(text, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(text), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
      if (expectedScope.storeReference !== expectedStoreReference) throw new Error("invalid");
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetup,
      clock = options.storeSetupClock,
      clockNow = clock?.now;
    if (!port || typeof port.classifications !== "function" || typeof clockNow !== "function") {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .classifications({ sessionCookie, expectedStoreReference })
      .then((value) => {
        try {
          if (options.storeSetupClock !== clock || clock?.now !== clockNow)
            throw new Error("unavailable");
          const at = String(parseCanonicalInstant(clockNow.call(clock))),
            result = parseTaxConfigClassificationChoices(value);
          if (
            result.observedAt > at ||
            result.validUntil <= at ||
            Object.entries(expectedScope).some(
              ([key, reference]) =>
                Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
            )
          )
            throw new Error("unavailable");
          response.json(result);
        } catch {
          storeSetupFailure(response, undefined);
        }
      })
      .catch((error) => storeSetupFailure(response, error));
  });
  router.post("/store-setup", sameOriginMutation(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
      Object.keys(request.query).length !== 0 ||
      request.body === undefined
    ) {
      denied(response);
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      storeSetupFailure(
        response,
        new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID"),
      );
      return;
    }
    try {
      bindMerchantStoreSetupCommand(request.body, expectedScope);
    } catch (error) {
      storeSetupFailure(response, error);
      return;
    }
    const port = options.storeSetup;
    if (!port) {
      storeSetupFailure(response, undefined);
      return;
    }
    void port
      .write({ sessionCookie, csrf, command: request.body, expectedScope })
      .then((value) => response.json(value))
      .catch((error) => storeSetupFailure(response, error));
  });

  const storeSetupReferenceFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof StoreSetupReferenceError ? error.code : undefined;
    const invalid = code === "STORE_SETUP_REFERENCE_INPUT_INVALID";
    const forbidden = code === "STORE_SETUP_REFERENCE_PERMISSION_DENIED";
    const conflict =
      code === "STORE_SETUP_REFERENCE_VERSION_CONFLICT" ||
      code === "STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_setup_reference_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_setup_reference_conflict"
              : "store_setup_reference_unavailable",
      });
  };
  router.get("/store-setup/references", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storeSetupReferences;
    if (!port) {
      storeSetupReferenceFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storeSetupReferenceFailure(response, error));
  });
  router.post("/store-setup/references/:kind", sameOriginMutation(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant"),
      csrf = exactHeader(request, "x-bop-csrf");
    if (
      sessionCookie === null ||
      csrf === null ||
      !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
      Object.keys(request.query).length !== 0 ||
      request.body === undefined
    ) {
      denied(response);
      return;
    }
    const kind =
      request.params.kind === "address"
        ? "Address"
        : request.params.kind === "contact"
          ? "Contact"
          : null;
    if (kind === null) {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    let expectedScope: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      actorReference: string;
    };
    try {
      const encoded = exactHeader(request, "x-bop-store-setup-scope");
      if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
        throw new Error("invalid");
      const bytes = Buffer.from(encoded, "base64url"),
        decoded = bytes.toString("utf8");
      if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
        throw new Error("invalid");
      const raw = readClosedRecord(JSON.parse(decoded), [
        "tenantReference",
        "brandReference",
        "storeReference",
        "actorReference",
      ]);
      expectedScope = Object.freeze({
        tenantReference: parseStoreAdministrationReference(raw.tenantReference),
        brandReference: parseStoreAdministrationReference(raw.brandReference),
        storeReference: parseStoreAdministrationReference(raw.storeReference),
        actorReference: parseStoreAdministrationReference(raw.actorReference),
      });
    } catch {
      storeSetupReferenceFailure(
        response,
        new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID"),
      );
      return;
    }
    try {
      bindMerchantStoreSetupReferenceCommand(request.body, expectedScope, kind);
    } catch (error) {
      storeSetupReferenceFailure(response, error);
      return;
    }
    const port = options.storeSetupReferences;
    if (!port) {
      storeSetupReferenceFailure(response, undefined);
      return;
    }
    void port
      .write({ sessionCookie, csrf, command: request.body, expectedScope, kind })
      .then((value) => response.json(value))
      .catch((error) => storeSetupReferenceFailure(response, error));
  });

  const storePaymentConfigurationFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof StorePaymentConfigurationError ? error.code : undefined;
    const invalid = code === "STORE_PAYMENT_CONFIGURATION_INPUT_INVALID";
    const forbidden = code === "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED";
    const conflict =
      code === "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT" ||
      code === "STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_payment_configuration_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_payment_configuration_conflict"
              : "store_payment_configuration_unavailable",
      });
  };
  router.get("/store-setup/payment-configuration", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      storePaymentConfigurationFailure(
        response,
        new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID"),
      );
      return;
    }
    const port = options.storePaymentConfiguration;
    if (!port) {
      storePaymentConfigurationFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => storePaymentConfigurationFailure(response, error));
  });
  router.post(
    "/store-setup/payment-configuration",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        storePaymentConfigurationFailure(
          response,
          new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantStorePaymentConfigurationCommand(request.body, expectedScope);
      } catch (error) {
        storePaymentConfigurationFailure(response, error);
        return;
      }
      const port = options.storePaymentConfiguration;
      if (!port) {
        storePaymentConfigurationFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => storePaymentConfigurationFailure(response, error));
    },
  );

  const receiptTemplateArtifactsFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_artifact_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_artifact_conflict"
              : "receipt_template_artifact_unavailable",
      });
  };
  router.get("/store-setup/receipt-artifacts", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).length !== 1 ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
    } catch {
      receiptTemplateArtifactsFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateArtifacts;
    if (!port) {
      receiptTemplateArtifactsFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateArtifactsFailure(response, error));
  });
  router.post(
    "/store-setup/receipt-artifacts/:kind",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length > 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      const artifactKind =
        request.params.kind === "layout"
          ? "Layout"
          : request.params.kind === "compliance"
            ? "Compliance"
            : null;
      if (!artifactKind) {
        receiptTemplateArtifactsFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      let expectedScope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        actorReference: string;
      };
      try {
        const encoded = exactHeader(request, "x-bop-store-setup-scope");
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
          throw new Error("invalid");
        const bytes = Buffer.from(encoded, "base64url"),
          decoded = bytes.toString("utf8");
        if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
          throw new Error("invalid");
        const raw = readClosedRecord(JSON.parse(decoded), [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parseStoreAdministrationReference(raw.tenantReference),
          brandReference: parseStoreAdministrationReference(raw.brandReference),
          storeReference: parseStoreAdministrationReference(raw.storeReference),
          actorReference: parseStoreAdministrationReference(raw.actorReference),
        });
      } catch {
        receiptTemplateArtifactsFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateArtifactCommand(request.body, expectedScope, artifactKind);
      } catch (error) {
        receiptTemplateArtifactsFailure(response, error);
        return;
      }
      const port = options.receiptTemplateArtifacts;
      if (!port) {
        receiptTemplateArtifactsFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope, artifactKind })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateArtifactsFailure(response, error));
    },
  );

  // WP-2423 Q15/Q16 (DEC-RECEIPT-TAX-AND-PRIVACY): receipt registrations and privacy link.
  router.get("/store/receipt-profile", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.storeReceiptProfile) {
      response.status(503).json({ error: "receipt_profile_unavailable" });
      return;
    }
    const port = options.storeReceiptProfile;
    void retryTransactionConflict(() => port.read({ sessionCookie }))
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch((error: unknown) => {
        if (error instanceof MerchantStoreReceiptProfileError && error.code === "Denied") {
          denied(response);
          return;
        }
        response
          .status(503)
          .set("Cache-Control", NO_STORE)
          .set("Retry-After", "5")
          .json({ error: "receipt_profile_unavailable" });
      });
  });
  router.post("/store/receipt-profile", sameOriginMutation(options), (request, response) => {
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
    const command = options.storeReceiptProfile;
    if (!command) {
      response.status(503).json({ error: "receipt_profile_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.set("Cache-Control", NO_STORE).json({
          status: result.status,
          version: result.version,
          recordedAt: result.recordedAt,
          gaps: result.gaps,
        }),
      )
      .catch((error: unknown) => {
        response.set("Cache-Control", NO_STORE);
        if (!(error instanceof MerchantStoreReceiptProfileError)) {
          response.status(503).json({ error: "receipt_profile_unavailable" });
          return;
        }
        if (error.code === "Denied") response.status(403).json({ error: "owner_required" });
        else if (error.code === "VersionConflict")
          response.status(409).json({ error: "profile_changed" });
        else if (error.code === "NoChange") response.status(409).json({ error: "no_change" });
        else if (error.code === "Invalid") response.status(422).json({ error: "invalid_details" });
        else response.status(503).json({ error: "receipt_profile_unavailable" });
      });
  });

  // WP-2423 DEC-STORE-CUSTOMER-NAME: the Store's published name, address and phone.
  router.get("/store/public-profile", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.storePublicProfile) {
      response.status(503).json({ error: "public_profile_unavailable" });
      return;
    }
    const port = options.storePublicProfile;
    void retryTransactionConflict(() => port.read({ sessionCookie }))
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch((error: unknown) => {
        if (error instanceof MerchantStorePublicProfileError && error.code === "Denied") {
          denied(response);
          return;
        }
        response
          .status(503)
          .set("Cache-Control", NO_STORE)
          .set("Retry-After", "5")
          .json({ error: "public_profile_unavailable" });
      });
  });
  router.post("/store/public-profile", sameOriginMutation(options), (request, response) => {
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
    const command = options.storePublicProfile;
    if (!command) {
      response.status(503).json({ error: "public_profile_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.set("Cache-Control", NO_STORE).json({
          status: result.status,
          current: result.current,
        }),
      )
      .catch((error: unknown) => {
        response.set("Cache-Control", NO_STORE);
        if (!(error instanceof MerchantStorePublicProfileError)) {
          response.status(503).json({ error: "public_profile_unavailable" });
          return;
        }
        if (error.code === "Denied") response.status(403).json({ error: "owner_required" });
        else if (error.code === "VersionConflict")
          response.status(409).json({ error: "profile_changed" });
        else if (error.code === "NoChange") response.status(409).json({ error: "no_change" });
        else if (error.code === "Invalid") response.status(422).json({ error: "invalid_details" });
        else response.status(503).json({ error: "public_profile_unavailable" });
      });
  });
}
