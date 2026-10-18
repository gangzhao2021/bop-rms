/** Merchant BFF routes: option prices and price books. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { decodeMerchantProductCommandScopeHeader } from "./merchant-product-command-scope.js";
import { readClosedRecord } from "@bop/identity";
import {
  createCurrencyMetadataSnapshot,
  OptionPriceAuthoringError,
  optionPriceWireState,
  parseCurrencyCode,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  parsePricingDigest,
  parsePricingReference,
  PriceBookWorkflowError,
} from "@rms/pricing";
import {
  parseCatalogInstant,
  parseCatalogLocale,
  parseLocalizedNames,
  parseProductOptionBinding,
} from "@rms/catalog";
import { publishingLifecycleStates } from "@bop/publishing";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import {
  cookie,
  denied,
  exactHeader,
  rawHeaderValues,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import type { Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantPricingRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.post(
    "/pricing/option-prices/review/current",
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
      const endpoint = options.optionPriceReview;
      if (!endpoint || typeof endpoint.query !== "function") {
        response.status(503).json({ error: "option_price_unavailable" });
        return;
      }
      const positive = (value: unknown) => {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > 2147483647
        )
          throw Error();
        return value;
      };
      let ruleReference: string, call: Promise<unknown>;
      try {
        const envelope = readClosedRecord(request.body, ["ruleReference", "context"]),
          context = readClosedRecord(envelope.context, [
            "productReference",
            "expectedProductAggregateVersion",
            "bindingReference",
            "optionReference",
          ]);
        ruleReference = parsePricingReference(envelope.ruleReference);
        call = endpoint.query({
          sessionCookie,
          csrf,
          expectedScope,
          ruleReference,
          context: {
            productReference: parsePricingReference(context.productReference),
            expectedProductAggregateVersion: positive(context.expectedProductAggregateVersion),
            bindingReference: parsePricingReference(context.bindingReference),
            optionReference: parsePricingReference(context.optionReference),
          },
        });
      } catch {
        response.status(400).json({ error: "option_price_invalid" });
        return;
      }
      void call
        .then((result) => {
          try {
            const value = readClosedRecord(result, [
              "profile",
              "tenantReference",
              "brandReference",
              "storeReference",
              "actorReference",
              "ruleReference",
              "aggregateVersion",
              "draftVersionReference",
              "draftSnapshotDigest",
              "draftAuthorActorReference",
              "policy",
              "review",
              "observedAt",
              "validUntil",
            ]);
            for (const field of [
              "tenantReference",
              "brandReference",
              "storeReference",
              "actorReference",
              "ruleReference",
              "draftVersionReference",
              "draftAuthorActorReference",
            ])
              parsePricingReference(value[field]);
            parsePricingDigest(value.draftSnapshotDigest);
            positive(value.aggregateVersion);
            const observedAt = parseCatalogInstant(value.observedAt),
              validUntil = parseCatalogInstant(value.validUntil);
            if (
              value.profile !== "MerchantOptionPriceReviewCurrentV1" ||
              value.ruleReference !== ruleReference ||
              value.brandReference !== expectedScope.brandReference ||
              value.storeReference !== expectedScope.storeReference ||
              observedAt >= validUntil ||
              Date.parse(validUntil) - Date.parse(observedAt) > 5000
            )
              throw Error();
            const policy = readClosedRecord(value.policy, [
              "familyReference",
              "policyReference",
              "policyVersion",
              "approvalPolicy",
              "effectiveFrom",
              "effectiveUntil",
              "currentPublicationReference",
            ]);
            for (const field of [
              "familyReference",
              "policyReference",
              "currentPublicationReference",
            ])
              parsePricingReference(policy[field]);
            positive(policy.policyVersion);
            const effectiveFrom = parseCatalogInstant(policy.effectiveFrom),
              effectiveUntil =
                policy.effectiveUntil === null ? null : parseCatalogInstant(policy.effectiveUntil);
            if (
              (policy.approvalPolicy !== "Required" && policy.approvalPolicy !== "NotRequired") ||
              (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
            )
              throw Error();
            if (
              value.review === null ||
              typeof value.review !== "object" ||
              Array.isArray(value.review)
            )
              throw Error();
            const discriminator = Object.getOwnPropertyDescriptor(value.review, "outcome");
            if (!discriminator?.enumerable || !("value" in discriminator)) throw Error();
            if (discriminator.value === "Absent") readClosedRecord(value.review, ["outcome"]);
            else {
              const review = readClosedRecord(value.review, [
                  "outcome",
                  "lifecycle",
                  "validationValidUntil",
                  "approvalValidUntil",
                  "submittedActorReference",
                  "approvedActorReference",
                  "sourceAuthority",
                  "qualification",
                ]),
                lifecycle = readClosedRecord(review.lifecycle, [
                  "lifecycleReference",
                  "version",
                  "state",
                  "latestMutationOperationReference",
                ]);
              if (
                review.outcome !== "Recorded" ||
                review.sourceAuthority !== "RecordedHistory" ||
                review.qualification !== "NotEvaluated" ||
                !publishingLifecycleStates.some((state) => state === lifecycle.state)
              )
                throw Error();
              parsePricingReference(lifecycle.lifecycleReference);
              parsePricingReference(lifecycle.latestMutationOperationReference);
              positive(lifecycle.version);
              const validationValidUntil =
                  review.validationValidUntil === null
                    ? null
                    : parseCatalogInstant(review.validationValidUntil),
                approvalValidUntil =
                  review.approvalValidUntil === null
                    ? null
                    : parseCatalogInstant(review.approvalValidUntil);
              if (
                approvalValidUntil !== null &&
                (validationValidUntil === null || approvalValidUntil > validationValidUntil)
              )
                throw Error();
              for (const field of ["submittedActorReference", "approvedActorReference"])
                if (review[field] !== null) parsePricingReference(review[field]);
            }
            response.json(result);
          } catch {
            response.status(503).json({ error: "option_price_unavailable" });
          }
        })
        .catch((error: unknown) => {
          const feature = error instanceof MerchantProductWriteFeatureDisabled,
            code = error instanceof OptionPriceAuthoringError ? error.code : null,
            status = feature
              ? 409
              : code === "OPTION_PRICE_INPUT_INVALID"
                ? 400
                : code === "OPTION_PRICE_PERMISSION_DENIED"
                  ? 403
                  : code !== null &&
                      [
                        "OPTION_PRICE_VERSION_CONFLICT",
                        "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                        "OPTION_PRICE_LIFECYCLE_CONFLICT",
                        "OPTION_PRICE_APPROVAL_REQUIRED",
                        "OPTION_PRICE_CONFLICT",
                      ].includes(code)
                    ? 409
                    : 503;
          response.status(status).json({
            error: feature
              ? "option_price_feature_disabled"
              : status === 400
                ? "option_price_invalid"
                : status === 403
                  ? "request_denied"
                  : status === 409
                    ? "option_price_conflict"
                    : "option_price_unavailable",
          });
        });
    },
  );

  for (const mode of ["command", "resolve"] as const) {
    router.post(
      "/pricing/option-prices/review/" + mode,
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
        const endpoint = options.optionPriceReview;
        if (!endpoint) {
          response.status(503).json({ error: "option_price_unavailable" });
          return;
        }
        let command: Record<string, unknown>, call: Promise<unknown>;
        try {
          const envelope = readClosedRecord(
            request.body,
            mode === "command" ? ["command", "context"] : ["command"],
          );
          command = readClosedRecord(envelope.command, [
            "action",
            "operationReference",
            "ruleReference",
            "draftVersionReference",
            "draftSnapshotDigest",
            "expectedAggregateVersion",
            "validationValidUntil",
            "approvalValidUntil",
            "expectedLifecycle",
          ]);
          if (command.action !== "SubmitReview" && command.action !== "Approve") throw Error();
          parsePricingReference(command.operationReference);
          parsePricingReference(command.ruleReference);
          parsePricingReference(command.draftVersionReference);
          parsePricingDigest(command.draftSnapshotDigest);
          const positive = (v: unknown) => {
            if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 2147483647)
              throw Error();
            return v;
          };
          positive(command.expectedAggregateVersion);
          parseCatalogInstant(command.validationValidUntil);
          if (command.approvalValidUntil !== null) parseCatalogInstant(command.approvalValidUntil);
          if ((command.action === "SubmitReview") !== (command.approvalValidUntil === null))
            throw Error();
          if (command.expectedLifecycle !== null) {
            const head = readClosedRecord(command.expectedLifecycle, [
              "lifecycleReference",
              "version",
              "state",
              "latestMutationOperationReference",
            ]);
            parsePricingReference(head.lifecycleReference);
            parsePricingReference(head.latestMutationOperationReference);
            positive(head.version);
            if (head.state !== (command.action === "Approve" ? "InReview" : "Draft")) throw Error();
          } else if (command.action === "Approve") throw Error();
          if (mode === "resolve")
            call = endpoint.resolve({ sessionCookie, csrf, expectedScope, command });
          else {
            const raw = readClosedRecord(envelope.context, [
              "productReference",
              "expectedProductAggregateVersion",
              "bindingReference",
              "optionReference",
            ]);
            call = endpoint.execute({
              sessionCookie,
              csrf,
              expectedScope,
              command,
              context: {
                productReference: parsePricingReference(raw.productReference),
                expectedProductAggregateVersion: positive(raw.expectedProductAggregateVersion),
                bindingReference: parsePricingReference(raw.bindingReference),
                optionReference: parsePricingReference(raw.optionReference),
              },
            });
          }
        } catch {
          response.status(400).json({ error: "option_price_invalid" });
          return;
        }
        void call
          .then((result) => {
            try {
              const value = readClosedRecord(result, [
                "profile",
                "action",
                "operationReference",
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
                "outcome",
                "occurredAt",
                "observedAt",
                "validUntil",
              ]);
              for (const key of [
                "operationReference",
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
              ])
                parsePricingReference(value[key]);
              const occurred = parseCatalogInstant(value.occurredAt),
                observed = parseCatalogInstant(value.observedAt),
                until = parseCatalogInstant(value.validUntil);
              if (
                value.profile !== "MerchantOptionPriceReviewResultV1" ||
                value.action !== command.action ||
                value.operationReference !== command.operationReference ||
                value.brandReference !== expectedScope.brandReference ||
                value.storeReference !== expectedScope.storeReference ||
                (value.outcome !== "Committed" && value.outcome !== "Abandoned") ||
                occurred > observed ||
                observed >= until ||
                Date.parse(until) - Date.parse(observed) > 5000
              )
                throw Error();
              response.json(result);
            } catch {
              response.status(503).json({ error: "option_price_unavailable" });
            }
          })
          .catch((error: unknown) => {
            const feature = error instanceof MerchantProductWriteFeatureDisabled,
              code = error instanceof OptionPriceAuthoringError ? error.code : null,
              status = feature
                ? 409
                : code === "OPTION_PRICE_INPUT_INVALID"
                  ? 400
                  : code === "OPTION_PRICE_PERMISSION_DENIED"
                    ? 403
                    : code !== null &&
                        [
                          "OPTION_PRICE_VERSION_CONFLICT",
                          "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                          "OPTION_PRICE_LIFECYCLE_CONFLICT",
                          "OPTION_PRICE_APPROVAL_REQUIRED",
                          "OPTION_PRICE_CONFLICT",
                        ].includes(code)
                      ? 409
                      : 503;
            response.status(status).json({
              error: feature
                ? "option_price_feature_disabled"
                : status === 400
                  ? "option_price_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "option_price_conflict"
                      : "option_price_unavailable",
            });
          });
      },
    );
  }

  for (const mode of ["scope", "current", "command", "resolve"] as const) {
    router.post(
      "/pricing/option-prices/" + mode,
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
        const endpoint = options.optionPriceAuthoring;
        if (!endpoint) {
          response.status(503).json({ error: "option_price_unavailable" });
          return;
        }
        let call: Promise<unknown>;
        try {
          const envelope = readClosedRecord(
            request.body,
            mode === "scope"
              ? []
              : mode === "current"
                ? ["context"]
                : mode === "command"
                  ? ["command", "context"]
                  : ["command"],
          );
          if (mode === "scope") {
            if (typeof endpoint.scope !== "function") {
              response.status(503).json({ error: "option_price_unavailable" });
              return;
            }
            call = endpoint.scope({ sessionCookie, csrf, expectedScope });
          } else if (mode === "resolve") {
            const command = parseOptionPriceAuthoringCommand(envelope.command);
            call = endpoint.resolve({ sessionCookie, csrf, expectedScope, command });
          } else {
            const raw = readClosedRecord(
              envelope.context,
              mode === "current"
                ? [
                    "productReference",
                    "expectedProductAggregateVersion",
                    "bindingReference",
                    "optionReference",
                  ]
                : ["productReference", "expectedProductAggregateVersion"],
            );
            if (
              typeof raw.expectedProductAggregateVersion !== "number" ||
              !Number.isSafeInteger(raw.expectedProductAggregateVersion) ||
              raw.expectedProductAggregateVersion < 1 ||
              raw.expectedProductAggregateVersion > 2147483647
            )
              throw Error();
            const context = {
              productReference: parsePricingReference(raw.productReference),
              expectedProductAggregateVersion: raw.expectedProductAggregateVersion,
            };
            call =
              mode === "current"
                ? endpoint.query({
                    sessionCookie,
                    csrf,
                    expectedScope,
                    context: {
                      ...context,
                      bindingReference: parsePricingReference(raw.bindingReference),
                      optionReference: parsePricingReference(raw.optionReference),
                    },
                  })
                : endpoint.execute({
                    sessionCookie,
                    csrf,
                    expectedScope,
                    command: parseOptionPriceAuthoringCommand(envelope.command),
                    context,
                  });
          }
        } catch {
          response.status(400).json({ error: "option_price_invalid" });
          return;
        }
        void call
          .then((result) => {
            try {
              const raw = readClosedRecord(
                  result,
                  mode === "scope"
                    ? [
                        "profile",
                        "tenantReference",
                        "brandReference",
                        "storeReference",
                        "actorReference",
                        "observedAt",
                        "validUntil",
                      ]
                    : mode === "current"
                      ? [
                          "profile",
                          "tenantReference",
                          "brandReference",
                          "storeReference",
                          "actorReference",
                          "context",
                          "states",
                          "observedAt",
                          "validUntil",
                        ]
                      : [
                          "profile",
                          "action",
                          "operationReference",
                          "tenantReference",
                          "brandReference",
                          "storeReference",
                          "actorReference",
                          "outcome",
                          "state",
                          "occurredAt",
                          "observedAt",
                          "validUntil",
                        ],
                ),
                tenant = parsePricingReference(raw.tenantReference),
                brand = parsePricingReference(raw.brandReference),
                store = parsePricingReference(raw.storeReference),
                actor = parsePricingReference(raw.actorReference),
                observedAt = parseCatalogInstant(raw.observedAt),
                validUntil = parseCatalogInstant(raw.validUntil);
              if (
                brand !== expectedScope.brandReference ||
                store !== expectedScope.storeReference ||
                validUntil <= observedAt ||
                Date.parse(validUntil) - Date.parse(observedAt) > 5000
              )
                throw Error();
              if (mode === "scope") {
                if (raw.profile !== "MerchantOptionPriceScopeV1") throw Error();
              } else if (mode === "current") {
                const context = readClosedRecord(raw.context, [
                    "profile",
                    "tenantReference",
                    "brandReference",
                    "storeReference",
                    "actorReference",
                    "productReference",
                    "productAggregateVersion",
                    "productVersionReference",
                    "productSnapshotDigest",
                    "binding",
                    "versionResolution",
                    "optionReference",
                    "optionSetReference",
                    "optionSetVersionReference",
                    "optionSourceDigest",
                    "optionSourceAuthority",
                    "defaultLocale",
                    "localizedNames",
                    "choices",
                    "skus",
                    "currencyMetadata",
                    "referenceEligibility",
                    "publishValidation",
                    "observedAt",
                    "validUntil",
                  ]),
                  binding = parseProductOptionBinding(context.binding),
                  requested = readClosedRecord(
                    readClosedRecord(request.body, ["context"]).context,
                    [
                      "productReference",
                      "expectedProductAggregateVersion",
                      "bindingReference",
                      "optionReference",
                    ],
                  );
                if (
                  raw.profile !== "MerchantOptionPriceAuthoringQueryV1" ||
                  context.profile !== "MerchantOptionPriceContextV1" ||
                  context.tenantReference !== tenant ||
                  context.brandReference !== brand ||
                  context.storeReference !== store ||
                  context.actorReference !== actor ||
                  context.productReference !== requested.productReference ||
                  context.productAggregateVersion !== requested.expectedProductAggregateVersion ||
                  binding.bindingReference !== requested.bindingReference ||
                  context.optionReference !== requested.optionReference ||
                  context.optionSetReference !== binding.optionSetReference ||
                  context.optionSetVersionReference !== binding.optionSetVersionReference ||
                  context.referenceEligibility !== "NotEvaluated" ||
                  context.publishValidation !== "Incomplete" ||
                  !["Pinned", "CurrentPublished"].includes(String(context.versionResolution)) ||
                  context.optionSourceAuthority !==
                    (context.versionResolution === "Pinned"
                      ? "RecordedFrozen"
                      : "CurrentPublishingReleaseAndFrozenContent") ||
                  parseCatalogInstant(context.observedAt) > observedAt ||
                  parseCatalogInstant(context.validUntil) !== validUntil ||
                  !Array.isArray(raw.states) ||
                  raw.states.length > 1000
                )
                  throw Error();
                const seen = new Set<string>();
                const locale = parseCatalogLocale(context.defaultLocale),
                  metadata = readClosedRecord(context.currencyMetadata, [
                    "currencyCode",
                    "minorUnitExponent",
                    "metadataVersion",
                    "metadataVersionReference",
                    "metadataDigest",
                  ]);
                parseLocalizedNames(context.localizedNames, locale);
                parsePricingReference(context.productVersionReference);
                parsePricingDigest(context.productSnapshotDigest);
                parsePricingDigest(context.optionSourceDigest);
                if (
                  typeof metadata.minorUnitExponent !== "number" ||
                  typeof metadata.metadataVersion !== "number" ||
                  !Array.isArray(context.choices) ||
                  !Array.isArray(context.skus)
                )
                  throw Error();
                createCurrencyMetadataSnapshot({
                  currencyCode: parseCurrencyCode(metadata.currencyCode),
                  minorUnitExponent: metadata.minorUnitExponent,
                  metadataVersion: metadata.metadataVersion,
                  metadataVersionReference: parsePricingReference(
                    metadata.metadataVersionReference,
                  ),
                  metadataDigest: parsePricingDigest(metadata.metadataDigest),
                });
                const choices = new Set<string>();
                for (const item of context.choices) {
                  const choice = readClosedRecord(item, [
                      "optionReference",
                      "stableCode",
                      "lifecycle",
                      "localizedNames",
                    ]),
                    reference = parsePricingReference(choice.optionReference);
                  if (
                    choices.has(reference) ||
                    !binding.enabledOptionReferences.some((value) => String(value) === reference) ||
                    typeof choice.stableCode !== "string" ||
                    !["Draft", "Active", "Inactive", "Archived"].includes(String(choice.lifecycle))
                  )
                    throw Error();
                  choices.add(reference);
                  parseLocalizedNames(choice.localizedNames, locale);
                }
                if (
                  choices.size !== binding.enabledOptionReferences.length ||
                  !choices.has(parsePricingReference(context.optionReference))
                )
                  throw Error();
                const skus = new Set<string>();
                for (const item of context.skus) {
                  const sku = readClosedRecord(item, [
                      "skuReference",
                      "skuCode",
                      "lifecycle",
                      "localizedNames",
                    ]),
                    reference = parsePricingReference(sku.skuReference),
                    names = sku.localizedNames;
                  if (
                    skus.has(reference) ||
                    typeof sku.skuCode !== "string" ||
                    !["Draft", "Active", "Suspended", "Discontinued", "Archived"].includes(
                      String(sku.lifecycle),
                    ) ||
                    names === null ||
                    typeof names !== "object" ||
                    Array.isArray(names)
                  )
                    throw Error();
                  skus.add(reference);
                  const skuLocale = Object.keys(names)[0];
                  if (skuLocale === undefined) throw Error();
                  parseLocalizedNames(names, skuLocale);
                }
                for (const value of raw.states) {
                  const state = parseOptionPriceAuthoringState(value);
                  if (
                    state.brandReference !== brand ||
                    String(state.bindingReference) !== String(binding.bindingReference) ||
                    state.optionReference !== context.optionReference ||
                    seen.has(state.ruleReference)
                  )
                    throw Error();
                  seen.add(state.ruleReference);
                  optionPriceWireState(state);
                }
              } else {
                const original = parseOptionPriceAuthoringCommand(
                    readClosedRecord(
                      request.body,
                      mode === "command" ? ["command", "context"] : ["command"],
                    ).command,
                  ),
                  recordedAt = parseCatalogInstant(raw.occurredAt);
                if (
                  raw.profile !== "MerchantOptionPriceAuthoringResultV1" ||
                  raw.action !== original.action ||
                  raw.operationReference !== original.operationReference ||
                  !["Committed", "Abandoned"].includes(String(raw.outcome)) ||
                  (raw.outcome === "Abandoned") !== (raw.state === null) ||
                  recordedAt > observedAt
                )
                  throw Error();
                if (raw.state !== null) {
                  const state = parseOptionPriceAuthoringState(raw.state);
                  if (
                    state.brandReference !== brand ||
                    state.ruleReference !== original.ruleReference ||
                    state.updatedAt !== recordedAt
                  )
                    throw Error();
                  optionPriceWireState(state);
                }
              }
              response.json(result);
            } catch {
              response.status(503).json({ error: "option_price_unavailable" });
            }
          })
          .catch((error: unknown) => {
            const feature = error instanceof MerchantProductWriteFeatureDisabled,
              code = error instanceof OptionPriceAuthoringError ? error.code : null,
              status = feature
                ? 409
                : code === "OPTION_PRICE_INPUT_INVALID"
                  ? 400
                  : code === "OPTION_PRICE_PERMISSION_DENIED"
                    ? 403
                    : code !== null &&
                        [
                          "OPTION_PRICE_VERSION_CONFLICT",
                          "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
                          "OPTION_PRICE_LIFECYCLE_CONFLICT",
                          "OPTION_PRICE_APPROVAL_REQUIRED",
                          "OPTION_PRICE_CONFLICT",
                        ].includes(code)
                      ? 409
                      : 503;
            response.status(status).json({
              error: feature
                ? "option_price_feature_disabled"
                : status === 400
                  ? "option_price_invalid"
                  : status === 403
                    ? "request_denied"
                    : status === 409
                      ? "option_price_conflict"
                      : "option_price_unavailable",
            });
          });
      },
    );
  }

  router.post("/pricing/price-books", sameOriginMutation(options), (request, response) => {
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
    if (!options.priceBooks) {
      response.status(503).json({ error: "price_book_unavailable" });
      return;
    }
    void options
      .priceBooks({ sessionCookie, csrf, command: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => {
        if (!(error instanceof PriceBookWorkflowError)) {
          denied(response);
          return;
        }
        const status =
          error.code === "PRICE_BOOK_INPUT_INVALID"
            ? 400
            : [
                  "PRICE_BOOK_VERSION_CONFLICT",
                  "PRICE_BOOK_IDEMPOTENCY_CONFLICT",
                  "PRICE_BOOK_CODE_CONFLICT",
                  "PRICE_BOOK_LIFECYCLE_CONFLICT",
                ].includes(error.code)
              ? 409
              : error.code === "PRICE_BOOK_COVERAGE_INVALID"
                ? 422
                : error.code === "PRICE_BOOK_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
        response.status(status).json({
          error:
            status === 403
              ? "request_denied"
              : status === 400
                ? "price_book_invalid"
                : status === 409
                  ? "price_book_conflict"
                  : status === 422
                    ? "price_book_coverage_invalid"
                    : "price_book_unavailable",
        });
      });
  });
}
