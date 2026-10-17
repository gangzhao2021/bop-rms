/** Merchant BFF routes: option set list, authoring and publication. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { decodeMerchantProductCommandScopeHeader } from "./merchant-product-command-scope.js";
import {
  CatalogError,
  CatalogOptionSetListError,
  parseCatalogInstant,
  parseCatalogReference,
  parseOptionSetListView,
} from "@rms/catalog";
import {
  cookie,
  denied,
  exactHeader,
  rawHeaderValues,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { readClosedRecord } from "@bop/identity";
import {
  parsePublishingOptionSetPublicationOperation,
  parseRecordedPublishingMutation,
} from "@bop/publishing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantOptionSetRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const optionSetList = options.optionSetList;
  router.post("/catalog/option-sets/list", sameOriginMutation(options), (request, response) => {
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
    if (!optionSetList) {
      response.status(503).json({ error: "option_set_list_unavailable" });
      return;
    }
    void optionSetList({ sessionCookie, csrf, filters: request.body, expectedScope })
      .then((view) => {
        try {
          response.json(parseOptionSetListView(view));
        } catch {
          throw new CatalogOptionSetListError("DependencyUnavailable");
        }
      })
      .catch((error: unknown) => {
        const code =
          error instanceof CatalogOptionSetListError ? error.code : "DependencyUnavailable";
        response
          .status(
            code === "Invalid"
              ? 400
              : code === "Denied"
                ? 403
                : code === "FeatureDisabled" || code === "Stale"
                  ? 409
                  : 503,
          )
          .json({
            error:
              code === "Invalid"
                ? "option_set_list_invalid"
                : code === "Denied"
                  ? "request_denied"
                  : code === "FeatureDisabled"
                    ? "option_set_list_feature_disabled"
                    : code === "Stale"
                      ? "option_set_list_stale"
                      : "option_set_list_unavailable",
          });
      });
  });

  for (const mode of [
    "create",
    "draft",
    "current-editor",
    "current-published",
    "history",
    "authoring/resolve",
    "authoring/context",
    "publication/context",
    "publication/command",
    "publication/resolve",
  ] as const) {
    const endpoint =
      mode === "create"
        ? options.optionSetAuthoring?.create.bind(options.optionSetAuthoring)
        : mode === "draft"
          ? options.optionSetAuthoring?.edit.bind(options.optionSetAuthoring)
          : mode === "current-editor"
            ? options.optionSetEditor
            : mode === "current-published"
              ? options.optionSetCurrentPublication
              : mode === "history"
                ? options.optionSetHistory
                : mode === "authoring/resolve"
                  ? options.optionSetAuthoringResolution
                  : mode === "publication/context"
                    ? options.optionSetPublicationContext
                    : mode === "publication/command"
                      ? options.optionSetPublicationCommand
                      : mode === "publication/resolve"
                        ? options.optionSetPublicationResolution
                        : options.optionSetAuthoringContext;
    const errorPrefix =
      mode === "current-published"
        ? "option_set_current_publication"
        : mode === "history"
          ? "option_set_history"
          : mode === "publication/context"
            ? "option_set_publication_context"
            : mode === "publication/command" || mode === "publication/resolve"
              ? "option_set_publication"
              : "option_set_authoring";
    router.post(
      "/catalog/option-sets/" + mode,
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
        if (!endpoint) {
          response.status(503).json({ error: errorPrefix + "_unavailable" });
          return;
        }
        void endpoint({ sessionCookie, csrf, command: request.body, expectedScope })
          .then((result) => {
            if (mode !== "publication/command" && mode !== "publication/resolve")
              return response.json(result);
            const value = readClosedRecord(
              result,
              Object.hasOwn(result, "outcome")
                ? ["profile", "storeReference", "outcome", "validation"]
                : ["profile", "storeReference", "resolution"],
            );
            const storeReference = parseCatalogReference(value.storeReference);
            if (
              storeReference !== expectedScope.storeReference ||
              value.profile !==
                (mode === "publication/command"
                  ? "CatalogOptionSetPublicationCommandResultV1"
                  : "CatalogOptionSetPublicationResolutionResultV1")
            )
              throw Error();
            if (value.outcome === "Validated") {
              if (mode !== "publication/command" || request.body?.action !== "Validate")
                throw Error();
              const validation = readClosedRecord(value.validation, [
                "checks",
                "findings",
                "decision",
                "observedAt",
                "qualifiedActivationAt",
                "independentApproval",
                "saleEligibility",
              ]);
              if (
                !Array.isArray(validation.checks) ||
                !Array.isArray(validation.findings) ||
                !["Pass", "HardError", "Indeterminate"].includes(String(validation.decision)) ||
                validation.independentApproval !== "NotEvaluated" ||
                validation.saleEligibility !== "NotEvaluated"
              )
                throw Error();
              parseCatalogInstant(validation.observedAt);
              parseCatalogInstant(validation.qualifiedActivationAt);
              return response.json({
                profile: value.profile,
                storeReference,
                outcome: "Validated",
                validation,
              });
            }
            const original = readClosedRecord(
              value.resolution,
              (value.resolution as { outcome?: unknown })?.outcome === "Committed"
                ? ["outcome", "command", "originalOccurredAt", "auditReference", "mutation"]
                : ["outcome", "command", "recordedAt", "auditReference"],
            );
            const command = parsePublishingOptionSetPublicationOperation(original.command);
            if (
              command.brandReference !== expectedScope.brandReference ||
              String(command.selectedStoreReference) !== String(storeReference) ||
              command.operationReference !== request.body?.operationReference ||
              command.action !== request.body?.action
            )
              throw Error();
            const recordedAt = parseCatalogInstant(
              original.outcome === "Committed" ? original.originalOccurredAt : original.recordedAt,
            );
            if (original.outcome === "Committed") {
              const mutation = parseRecordedPublishingMutation(original.mutation);
              if (
                mutation.operation !== command.action ||
                mutation.idempotencyKey !== command.operationReference ||
                mutation.audit.auditId !== original.auditReference ||
                mutation.audit.occurredAt !== recordedAt
              )
                throw Error();
            } else if (original.outcome !== "Abandoned") throw Error();
            return response.json({
              profile: "CatalogOptionSetPublicationReceiptV1",
              storeReference,
              operationReference: command.operationReference,
              action: command.action,
              outcome: original.outcome,
              recordedAt,
            });
          })
          .catch((error: unknown) => {
            const status =
              error instanceof MerchantProductWriteFeatureDisabled
                ? 409
                : error instanceof CatalogError && error.code === "CATALOG_INPUT_INVALID"
                  ? 400
                  : error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED"
                    ? 403
                    : error instanceof CatalogError &&
                        [
                          "CATALOG_VERSION_CONFLICT",
                          "CATALOG_IDEMPOTENCY_CONFLICT",
                          "CATALOG_LIFECYCLE_CONFLICT",
                          "CATALOG_CODE_CONFLICT",
                        ].includes(error.code)
                      ? 409
                      : 503;
            response.status(status).json({
              error:
                error instanceof MerchantProductWriteFeatureDisabled && mode === "current-published"
                  ? "option_set_current_publication_feature_disabled"
                  : error instanceof MerchantProductWriteFeatureDisabled && mode === "history"
                    ? "option_set_history_feature_disabled"
                    : error instanceof MerchantProductWriteFeatureDisabled &&
                        (mode === "publication/context" ||
                          mode === "publication/command" ||
                          mode === "publication/resolve")
                      ? "option_set_publication_feature_disabled"
                      : status === 400
                        ? errorPrefix + "_invalid"
                        : status === 403
                          ? "request_denied"
                          : status === 409
                            ? errorPrefix + "_conflict"
                            : errorPrefix + "_unavailable",
            });
          });
      },
    );
  }
}
