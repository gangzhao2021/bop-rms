/** Merchant BFF routes: request body parsers and their size limits. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { httpRequestLimits } from "./http-security.js";
import { productPhotoBytesMaximum } from "./merchant-products.js";
import { NO_STORE, sameOriginMutation } from "./merchant-bff-http.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantBffBodyParsers(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const ordinaryJson = express.json({ limit: "8kb", strict: true });
  const storeSetupJson = express.json({ limit: 2_097_152, strict: true });
  const storeSetupReferenceJson = express.json({ limit: 32_768, strict: true });
  const draftBytes = new WeakMap<object, number>();
  const completeDraftJson = express.json({
    limit: httpRequestLimits.jsonBodyBytesMaximum,
    strict: true,
    verify(request, _response, bytes) {
      draftBytes.set(request, bytes.byteLength);
    },
  });
  // The complete owning Option document has a one-MiB canonical command cap.
  // Control requests keep the small transport budget.
  const optionDraftJson = express.json({ limit: 1_048_576, strict: true });
  const optionControlJson = express.json({ limit: "8kb", strict: true });
  const taxDraftJson = express.json({ limit: 98_304, strict: true });
  const taxSimulationJson = express.json({ limit: 196_608, strict: true });
  const taxMaterialJson = express.json({ limit: 1_056_768, strict: true });
  router.use((request, response, next) => {
    if (
      request.method === "POST" &&
      [
        "/store-configuration/ordinary-command",
        "/store-configuration/ordinary-state",
        "/store-configuration/ordinary-history",
      ].includes(request.path)
    ) {
      ordinaryJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "store_configuration_ordinary_invalid" });
      });
      return;
    }
    // WP-2423 menu descriptions and photos: a product photo is sent as the raw image bytes; a
    // cross-site request is refused before its body is read.
    if (request.method === "POST" && request.path === "/commerce/products/photo") {
      sameOriginMutation(options)(request, response, () =>
        express.raw({ type: () => true, limit: productPhotoBytesMaximum })(
          request,
          response,
          (error?: unknown) => {
            if (!error) {
              next();
              return;
            }
            const large =
              typeof error === "object" &&
              error !== null &&
              "type" in error &&
              error.type === "entity.too.large";
            response
              .status(large ? 413 : 400)
              .set("Cache-Control", NO_STORE)
              .json({ error: large ? "PhotoTooLarge" : "Invalid" });
          },
        ),
      );
      return;
    }
    // WP-2423 / DEC-INV-OPENING: an opening count may carry up to 5000 lines.
    if (
      request.method === "POST" &&
      (request.path === "/supply/opening-count/command" ||
        request.path === "/supply/receipts/command" ||
        request.path === "/commerce/recipes/command" ||
        request.path === "/commerce/pricing/command")
    ) {
      express.json({ limit: 1_048_576, strict: true })(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "Invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      [
        "/organization/brands/topology/draft/workspace",
        "/organization/brands/topology/draft/save",
        "/organization/brands/topology/draft/resolve",
      ].includes(request.path)
    ) {
      const parser = request.path.endsWith("/save")
        ? express.json({ limit: 2_105_344, strict: true })
        : ordinaryJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "brand_store_topology_invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      (request.path === "/tax-config/authoring/commands" ||
        request.path === "/tax-config/authoring/resolve-original" ||
        request.path === "/tax-config/authoring/simulate" ||
        request.path === "/tax-config/authoring/materials/commands" ||
        request.path === "/tax-config/authoring/materials/resolve-original" ||
        request.path === "/tax-config/authoring/materials/compare" ||
        request.path === "/tax-config/authoring/candidates/commands" ||
        request.path === "/tax-config/authoring/candidates/resolve-original")
    ) {
      const parser = request.path.startsWith("/tax-config/authoring/candidates/")
        ? ordinaryJson
        : request.path === "/tax-config/authoring/materials/commands"
          ? taxMaterialJson
          : request.path.endsWith("/commands")
            ? taxDraftJson
            : request.path.endsWith("/simulate")
              ? taxSimulationJson
              : ordinaryJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const large =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(large ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "tax_config_authoring_invalid" });
      });
      return;
    }
    if (
      request.method === "POST" &&
      (/^\/store-setup\/references\/(address|contact)$/u.test(request.path) ||
        request.path === "/store-setup/payment-configuration" ||
        request.path === "/store-setup/receipt-template-draft" ||
        request.path === "/store-setup/receipt-template-submit" ||
        request.path === "/store-setup/receipt-template-lifecycle" ||
        /^\/store-setup\/receipt-artifacts\/[^/]+$/u.test(request.path))
    ) {
      storeSetupReferenceJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error:
              request.path === "/store-setup/receipt-template-lifecycle"
                ? "receipt_template_lifecycle_invalid"
                : request.path === "/store-setup/receipt-template-submit"
                  ? "receipt_template_submit_invalid"
                  : request.path === "/store-setup/receipt-template-draft"
                    ? "receipt_template_draft_invalid"
                    : request.path.startsWith("/store-setup/receipt-artifacts/")
                      ? "receipt_template_artifact_invalid"
                      : request.path === "/store-setup/payment-configuration"
                        ? "store_payment_configuration_invalid"
                        : "store_setup_reference_invalid",
          });
      });
      return;
    }
    if (request.method === "POST" && request.path === "/store-setup") {
      storeSetupJson(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({ error: "store_setup_invalid" });
      });
      return;
    }
    const optionDraft =
      request.path === "/catalog/option-sets/create" ||
      request.path === "/catalog/option-sets/draft";
    const optionControl =
      request.path === "/catalog/products/option-binding-picker" ||
      request.path === "/catalog/option-sets/list" ||
      request.path === "/catalog/option-sets/current-editor" ||
      request.path === "/catalog/option-sets/current-published" ||
      request.path === "/catalog/option-sets/history" ||
      request.path === "/catalog/option-sets/authoring/resolve" ||
      request.path === "/catalog/option-sets/authoring/context" ||
      request.path === "/catalog/option-sets/publication/context" ||
      request.path === "/catalog/option-sets/publication/command" ||
      request.path === "/catalog/option-sets/publication/resolve" ||
      request.path === "/pricing/option-prices/scope" ||
      request.path === "/pricing/option-prices/current" ||
      request.path === "/pricing/option-prices/command" ||
      request.path === "/pricing/option-prices/review/current" ||
      request.path === "/pricing/option-prices/review/command" ||
      request.path === "/pricing/option-prices/review/resolve" ||
      request.path === "/pricing/option-prices/resolve";
    if (request.method === "POST" && (optionDraft || optionControl)) {
      const parser = optionDraft ? optionDraftJson : optionControlJson;
      parser(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error: request.path.startsWith("/pricing/option-prices/")
              ? "option_price_invalid"
              : request.path === "/catalog/products/option-binding-picker"
                ? "product_option_picker_invalid"
                : request.path === "/catalog/option-sets/current-published"
                  ? "option_set_current_publication_invalid"
                  : request.path === "/catalog/option-sets/history"
                    ? "option_set_history_invalid"
                    : request.path === "/catalog/option-sets/publication/context"
                      ? "option_set_publication_context_invalid"
                      : request.path === "/catalog/option-sets/publication/command" ||
                          request.path === "/catalog/option-sets/publication/resolve"
                        ? "option_set_publication_invalid"
                        : "option_set_authoring_invalid",
          });
      });
      return;
    }
    if (request.method !== "POST" || request.path !== "/catalog/products/draft") {
      ordinaryJson(request, response, next);
      return;
    }
    completeDraftJson(request, response, (error?: unknown) => {
      const size = draftBytes.get(request) ?? 0;
      draftBytes.delete(request);
      if (error) {
        const tooLarge =
          typeof error === "object" &&
          error !== null &&
          "type" in error &&
          error.type === "entity.too.large";
        response
          .status(tooLarge ? 413 : 400)
          .set("Cache-Control", NO_STORE)
          .json({
            error: "product_draft_invalid",
          });
        return;
      }
      const body: unknown = request.body;
      const draft = body && typeof body === "object" && "draft" in body ? body.draft : undefined;
      // Larger transport is only a complete-content candidate. The command still
      // performs closed structural parsing and current permission/reference checks.
      if (
        size > 8192 &&
        !(draft && typeof draft === "object" && Object.hasOwn(draft, "editorContent"))
      ) {
        response
          .status(413)
          .set("Cache-Control", NO_STORE)
          .json({ error: "product_draft_invalid" });
        return;
      }
      next();
    });
  });
}
