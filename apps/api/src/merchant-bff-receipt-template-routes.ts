/** Merchant BFF routes: receipt template draft, review, publication and lifecycle. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { DigitalReceiptTemplateError } from "@rms/printing-device";
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
import { parseStoreAdministrationReference } from "@rms/store";
import { Buffer } from "node:buffer";
import { readClosedRecord } from "@bop/identity";
import { bindMerchantReceiptTemplateDraftCommand } from "./merchant-receipt-template-draft-command.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { bindMerchantReceiptTemplateSubmitCommand } from "./merchant-receipt-template-submit-command.js";
import { MerchantSoleOperatorGateError } from "./merchant-sole-operator.js";
import { bindMerchantReceiptTemplateLifecycleCommand } from "./merchant-receipt-template-lifecycle-command.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantReceiptTemplateRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const receiptTemplateDraftFailure = (response: express.Response, error: unknown): void => {
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
          ? "receipt_template_draft_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_draft_conflict"
              : "receipt_template_draft_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-draft", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "templateReference",
      ) ||
      (Object.hasOwn(request.query, "templateReference") &&
        typeof request.query.templateReference !== "string") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let templateReference: string | null = null;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      if (Object.hasOwn(request.query, "templateReference"))
        templateReference = parseStoreAdministrationReference(request.query.templateReference);
    } catch {
      receiptTemplateDraftFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateDraft;
    if (!port) {
      receiptTemplateDraftFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference, templateReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateDraftFailure(response, error));
  });
  router.get("/store-setup/receipt-template-drafts", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "afterTemplate",
      ) ||
      (Object.hasOwn(request.query, "afterTemplate") &&
        typeof request.query.afterTemplate !== "string") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: string;
    let afterTemplate: string | null = null;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      if (Object.hasOwn(request.query, "afterTemplate"))
        afterTemplate = parseStoreAdministrationReference(request.query.afterTemplate);
    } catch {
      receiptTemplateDraftFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateDraft;
    if (!port) {
      receiptTemplateDraftFailure(response, undefined);
      return;
    }
    void port
      .list({ sessionCookie, expectedStoreReference, afterTemplate })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateDraftFailure(response, error));
  });
  router.post(
    "/store-setup/receipt-template-draft",
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
        receiptTemplateDraftFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateDraftCommand(request.body, expectedScope);
      } catch (error) {
        receiptTemplateDraftFailure(response, error);
        return;
      }
      const port = options.receiptTemplateDraft;
      if (!port) {
        receiptTemplateDraftFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateDraftFailure(response, error));
    },
  );

  const receiptTemplateReviewFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    response
      .status(
        code === "RECEIPT_TEMPLATE_INPUT_INVALID"
          ? 400
          : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
            ? 403
            : code === "RECEIPT_TEMPLATE_CONFLICT"
              ? 409
              : 503,
      )
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          code === "RECEIPT_TEMPLATE_INPUT_INVALID"
            ? "receipt_template_review_invalid"
            : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
              ? "request_denied"
              : code === "RECEIPT_TEMPLATE_CONFLICT"
                ? "receipt_template_review_conflict"
                : "receipt_template_review_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-review", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) => key !== "storeReference" && key !== "templateReference",
      ) ||
      typeof request.query.storeReference !== "string" ||
      typeof request.query.templateReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
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
      receiptTemplateReviewFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }

    let expectedStoreReference: string, templateReference: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      templateReference = parseStoreAdministrationReference(request.query.templateReference);
      if (expectedStoreReference !== expectedScope.storeReference) throw new Error("invalid");
    } catch {
      receiptTemplateReviewFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplateReview;
    if (!port) {
      receiptTemplateReviewFailure(response, undefined);
      return;
    }
    void port
      .read({ sessionCookie, expectedStoreReference, expectedScope, templateReference })
      .then((value) => response.json(value))
      .catch((error) => receiptTemplateReviewFailure(response, error));
  });

  // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: whether the signed-in person may approve, alone, a receipt
  // template they wrote or sent (null when this deployment offers no sole-operator approval).
  router.get(
    "/store-setup/receipt-template-sole-operator",
    safeRead(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      if (
        request.method !== "GET" ||
        sessionCookie === null ||
        request.body !== undefined ||
        Object.keys(request.query).length !== 0 ||
        rawHeaderValues(request, "origin").length > 1 ||
        rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
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
        receiptTemplateReviewFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      const port = options.receiptTemplateLifecycle,
        gate = port?.soleOperatorGate;
      if (!port || typeof gate !== "function") {
        response.json({ soleOperator: null });
        return;
      }
      void retryTransactionConflict(() => gate.call(port, { sessionCookie, expectedScope }))
        .then((value) => response.json({ soleOperator: value }))
        .catch((error) => receiptTemplateReviewFailure(response, error));
    },
  );

  const receiptTemplatePublishedFailure = (response: express.Response, error: unknown): void => {
    if (transactionConflictRetryLater(response, error)) return;
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    response
      .status(
        code === "RECEIPT_TEMPLATE_INPUT_INVALID"
          ? 400
          : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
            ? 403
            : code === "RECEIPT_TEMPLATE_CONFLICT"
              ? 409
              : 503,
      )
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          code === "RECEIPT_TEMPLATE_INPUT_INVALID"
            ? "receipt_template_published_invalid"
            : code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
              ? "request_denied"
              : code === "RECEIPT_TEMPLATE_CONFLICT"
                ? "receipt_template_published_conflict"
                : "receipt_template_published_unavailable",
      });
  };
  router.get("/store-setup/receipt-template-published", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some(
        (key) =>
          key !== "storeReference" &&
          key !== "templateReference" &&
          key !== "installed" &&
          key !== "locale",
      ) ||
      typeof request.query.storeReference !== "string" ||
      // WP-2423 (2026-10-16): either a template, or `installed=true` for the receipt template the
      // Store started with (installer-published).
      (request.query.installed === undefined
        ? typeof request.query.templateReference !== "string"
        : request.query.installed !== "true" || request.query.templateReference !== undefined) ||
      typeof request.query.locale !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
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
      receiptTemplatePublishedFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }

    let expectedStoreReference: string, templateReference: string | undefined, locale: string;
    try {
      expectedStoreReference = parseStoreAdministrationReference(request.query.storeReference);
      templateReference =
        request.query.installed === "true"
          ? undefined
          : parseStoreAdministrationReference(request.query.templateReference);
      if (expectedStoreReference !== expectedScope.storeReference) throw new Error("invalid");
      if (
        typeof request.query.locale !== "string" ||
        !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(request.query.locale)
      )
        throw new Error("invalid");
      locale = request.query.locale;
    } catch {
      receiptTemplatePublishedFailure(
        response,
        new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
      );
      return;
    }
    const port = options.receiptTemplatePublished;
    if (!port) {
      receiptTemplatePublishedFailure(response, undefined);
      return;
    }
    void (
      templateReference === undefined
        ? port.readInstalled({ sessionCookie, expectedStoreReference, expectedScope, locale })
        : port.read({
            sessionCookie,
            expectedStoreReference,
            expectedScope,
            templateReference,
            locale,
          })
    )
      .then((value) =>
        // WP-2423: this Store has no installer-published receipt template to go back to.
        value === null
          ? response.status(404).json({ error: "receipt_template_installed_none" })
          : response.json(value),
      )
      .catch((error) => receiptTemplatePublishedFailure(response, error));
  });

  const receiptTemplateSubmitFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_submit_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_submit_conflict"
              : "receipt_template_submit_unavailable",
      });
  };
  router.post(
    "/store-setup/receipt-template-submit",
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
        receiptTemplateSubmitFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      try {
        bindMerchantReceiptTemplateSubmitCommand(request.body, expectedScope);
      } catch (error) {
        receiptTemplateSubmitFailure(response, error);
        return;
      }
      const port = options.receiptTemplateSubmit;
      if (!port) {
        receiptTemplateSubmitFailure(response, undefined);
        return;
      }
      void port
        .write({ sessionCookie, csrf, command: request.body, expectedScope })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateSubmitFailure(response, error));
    },
  );

  const receiptTemplateLifecycleFailure = (response: express.Response, error: unknown): void => {
    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: why the Owner's own approval was not accepted.
    if (error instanceof MerchantSoleOperatorGateError) {
      response
        .status(403)
        .set("Cache-Control", NO_STORE)
        .json({
          error:
            error.code === "NeedsReverification"
              ? "sole_operator_needs_verification"
              : error.reason === "Off"
                ? "sole_operator_off"
                : "sole_operator_not_in_effect",
        });
      return;
    }
    const code = error instanceof DigitalReceiptTemplateError ? error.code : undefined;
    const invalid = code === "RECEIPT_TEMPLATE_INPUT_INVALID";
    const forbidden = code === "RECEIPT_TEMPLATE_PERMISSION_DENIED";
    const conflict = code === "RECEIPT_TEMPLATE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "receipt_template_lifecycle_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "receipt_template_lifecycle_conflict"
              : "receipt_template_lifecycle_unavailable",
      });
  };
  router.post(
    "/store-setup/receipt-template-lifecycle",
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
        receiptTemplateLifecycleFailure(
          response,
          new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID"),
        );
        return;
      }
      // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: an Approve may ask to be given alone, as sole
      // operator ("approvalMode": "SoleOperator"); the command itself is unchanged.
      let command: unknown = request.body,
        approvalMode: "SoleOperator" | undefined;
      try {
        if (
          request.body !== null &&
          typeof request.body === "object" &&
          !Array.isArray(request.body) &&
          Object.hasOwn(request.body, "approvalMode")
        ) {
          const { approvalMode: mode, ...rest } = request.body as Record<string, unknown>;
          if (mode !== "SoleOperator" || rest.command !== "Approve")
            throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
          approvalMode = "SoleOperator";
          command = rest;
        }
        bindMerchantReceiptTemplateLifecycleCommand(command, expectedScope);
      } catch (error) {
        receiptTemplateLifecycleFailure(response, error);
        return;
      }
      const port = options.receiptTemplateLifecycle;
      if (!port) {
        receiptTemplateLifecycleFailure(response, undefined);
        return;
      }
      void port
        .write({
          sessionCookie,
          csrf,
          command,
          expectedScope,
          ...(approvalMode === undefined ? {} : { approvalMode }),
        })
        .then((value) => response.json(value))
        .catch((error) => receiptTemplateLifecycleFailure(response, error));
    },
  );
}
