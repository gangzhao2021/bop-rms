/** Merchant BFF routes: tax configuration authoring. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import { MerchantTaxConfigFeatureDisabled } from "./merchant-tax-config-capability.js";
import {
  parsePricingReference,
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringRoster,
  parseTaxConfigAuthoringScope,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateRoster,
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialRoster,
  taxConfigAuthoringIntentDigest,
  taxConfigCandidateIntentDigest,
  taxConfigMaterialIntentDigest,
  type TaxConfigMaterialKind,
  TaxConfigWorkflowError,
} from "@rms/pricing";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { Buffer } from "node:buffer";
import {
  parseMerchantTaxConfigMaterialComparisonCommand,
  parseMerchantTaxConfigSimulationCommand,
  parseTaxConfigAuthoringSimulation,
  parseTaxConfigClassificationChoices,
  parseTaxConfigMaterialComparison,
} from "./merchant-tax-config-workbench-values.js";
import { parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantTaxConfigRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const taxConfigAuthoringFailure = (response: express.Response, error: unknown): void => {
    if (error instanceof MerchantTaxConfigFeatureDisabled) {
      response
        .status(503)
        .set("Cache-Control", NO_STORE)
        .json({ error: "tax_config_authoring_feature_disabled" });
      return;
    }
    const code = error instanceof TaxConfigWorkflowError ? error.code : undefined;
    const invalid = code === "TAX_CONFIG_INPUT_INVALID";
    const forbidden = code === "TAX_CONFIG_PERMISSION_DENIED";
    const conflict =
      code === "TAX_CONFIG_VERSION_CONFLICT" ||
      code === "TAX_CONFIG_IDEMPOTENCY_CONFLICT" ||
      code === "TAX_CONFIG_LIFECYCLE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "tax_config_authoring_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "tax_config_authoring_conflict"
              : "tax_config_authoring_unavailable",
      });
  };
  const taxConfigOutput = <T>(work: () => T): T => {
    try {
      return work();
    } catch {
      throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
    }
  };
  const taxConfigExpectedScope = (request: express.Request) => {
    const encoded = exactHeader(request, "x-bop-store-setup-scope");
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
      throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
    const bytes = Buffer.from(encoded, "base64url"),
      decoded = bytes.toString("utf8");
    if (bytes.toString("base64url") !== encoded || !Buffer.from(decoded, "utf8").equals(bytes))
      throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
    return parseTaxConfigAuthoringScope(JSON.parse(decoded));
  };
  router.get("/tax-config/authoring/classifications", safeRead(options), (request, response) => {
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
    let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
    try {
      expectedScope = taxConfigExpectedScope(request);
      if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
    } catch (error) {
      taxConfigAuthoringFailure(
        response,
        error instanceof TaxConfigWorkflowError
          ? error
          : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
      );
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .classifications({
        sessionCookie,
        expectedScope,
        expectedStoreReference: expectedScope.storeReference,
      })
      .then((value) => {
        const result = taxConfigOutput(() => parseTaxConfigClassificationChoices(value));
        if (
          Object.entries(expectedScope).some(
            ([key, reference]) => Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
          )
        )
          throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  router.post(
    "/tax-config/authoring/simulate",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
      let command: ReturnType<typeof parseMerchantTaxConfigSimulationCommand>;
      try {
        expectedScope = taxConfigExpectedScope(request);
        command = parseMerchantTaxConfigSimulationCommand(request.body);
      } catch (error) {
        taxConfigAuthoringFailure(
          response,
          error instanceof TaxConfigWorkflowError
            ? error
            : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
        );
        return;
      }
      const port = options.taxConfigAuthoring;
      if (!port) {
        taxConfigAuthoringFailure(response, undefined);
        return;
      }
      void port
        .simulate({ sessionCookie, csrf, expectedScope, command })
        .then((value) => {
          const result = taxConfigOutput(() => parseTaxConfigAuthoringSimulation(value));
          if (
            Object.entries(expectedScope).some(
              ([key, reference]) =>
                Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
            ) ||
            result.configurationReference !== command.configurationReference ||
            result.versionReference !== command.expectedVersionReference ||
            result.snapshotDigest !== command.expectedSnapshotDigest ||
            result.simulation.fixtureReference !== command.fixture.fixtureReference ||
            result.simulation.kind !== command.fixture.kind
          )
            throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })
        .catch((error) => taxConfigAuthoringFailure(response, error));
    },
  );
  router.get("/tax-config/authoring/scope", safeRead(options), (request, response) => {
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
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 0
    ) {
      denied(response);
      return;
    }
    let expectedStoreReference: ReturnType<typeof parsePricingReference>;
    try {
      expectedStoreReference = parsePricingReference(request.query.storeReference);
    } catch {
      taxConfigAuthoringFailure(response, new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"));
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .current({ sessionCookie, expectedStoreReference, configurationReference: null })
      .then((value) => {
        const result = taxConfigOutput(() => parseTaxConfigAuthoringCurrent(value, null));
        if (result.storeReference !== expectedStoreReference || result.state !== null)
          throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  for (const listing of [false, true]) {
    router.get(
      listing ? "/tax-config/authoring/roster" : "/tax-config/authoring/current",
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant");
        const key = listing ? "afterConfiguration" : "configurationReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some((k) => k !== "storeReference" && k !== key) ||
          typeof request.query.storeReference !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
        let target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
        };
        void (
          listing
            ? port.roster({ ...input, afterConfiguration: target })
            : port.current({ ...input, configurationReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              listing
                ? parseTaxConfigAuthoringRoster(value, target)
                : parseTaxConfigAuthoringCurrent(value, target),
            );
            if (
              Object.entries(expectedScope).some(
                ([key, reference]) =>
                  Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
              )
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            if (
              listing
                ? "afterConfiguration" in result && result.afterConfiguration !== target
                : "configurationReference" in result && result.configurationReference !== target
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving ? "/tax-config/authoring/resolve-original" : "/tax-config/authoring/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
        let command:
          | ReturnType<typeof parseTaxConfigAuthoringCommand>
          | ReturnType<typeof parseTaxConfigAuthoringResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigAuthoringResolve(request.body)
            : parseTaxConfigAuthoringCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope };
        void (resolving ? port.resolve({ ...input, command }) : port.execute({ ...input, command }))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigAuthoringOperation(value));
            if (
              Object.entries(expectedScope).some(
                ([key, reference]) =>
                  Object.getOwnPropertyDescriptor(result, key)?.value !== reference,
              ) ||
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.configurationReference !== command.configurationReference ||
              result.expectedAggregateVersion !== command.expectedAggregateVersion ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigAuthoringIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  const taxMaterialKind = (value: unknown): TaxConfigMaterialKind => {
    if (
      value === "RegistrationApplicability" ||
      value === "ProfessionalReport" ||
      value === "FixtureSuite"
    )
      return value;
    throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
  };
  const taxSameScope = (
    value: object,
    expected: ReturnType<typeof parseTaxConfigAuthoringScope>,
  ) => {
    if (
      Object.entries(expected).some(
        ([key, reference]) => Object.getOwnPropertyDescriptor(value, key)?.value !== reference,
      )
    )
      throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
  };
  router.get("/tax-config/authoring/tax-registrant", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      request.body !== undefined ||
      Object.keys(request.query).some((key) => key !== "storeReference") ||
      typeof request.query.storeReference !== "string" ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>;
    try {
      expectedScope = taxConfigExpectedScope(request);
      if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
    } catch (error) {
      taxConfigAuthoringFailure(
        response,
        error instanceof TaxConfigWorkflowError
          ? error
          : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
      );
      return;
    }
    const port = options.taxConfigAuthoring;
    if (!port) {
      taxConfigAuthoringFailure(response, undefined);
      return;
    }
    void port
      .taxRegistrant({
        sessionCookie,
        expectedScope,
        expectedStoreReference: expectedScope.storeReference,
      })
      .then((value) => {
        const result = taxConfigOutput(() => {
          if (value === null) return null;
          const r = readClosedRecord(value, [
            "profile",
            ...Object.keys(expectedScope),
            "businessFunction",
            "effectiveAt",
            "assignmentReference",
            "assignmentVersion",
            "effectiveFrom",
            "effectiveUntil",
            "operatingEntityReference",
            "entityVersion",
            "operatingEntityProfileVersionReference",
            "profileVersion",
            "legalName",
            "jurisdictionCode",
            "registrationReference",
            "taxRegistrationReference",
            "observedAt",
            "validUntil",
            "qualification",
          ]);
          taxSameScope(r, expectedScope);
          if (
            r.profile !== "TaxRegistrantCurrentSourceV1" ||
            r.businessFunction !== "TaxRegistrant" ||
            r.jurisdictionCode !== "CA-ON" ||
            r.qualification !== "NotEvaluated" ||
            typeof r.legalName !== "string" ||
            !r.legalName.trim() ||
            r.legalName.length > 512 ||
            Array.from(r.legalName).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error("Invalid source");
          for (const key of [
            "assignmentReference",
            "operatingEntityReference",
            "operatingEntityProfileVersionReference",
          ])
            parsePricingReference(r[key]);
          for (const key of ["registrationReference", "taxRegistrationReference"])
            if (r[key] !== null) parsePricingReference(r[key]);
          for (const key of ["assignmentVersion", "entityVersion", "profileVersion"])
            if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < 1)
              throw new Error("Invalid version");
          for (const key of ["effectiveAt", "effectiveFrom", "observedAt", "validUntil"])
            parseCanonicalInstant(r[key]);
          if (r.effectiveUntil !== null) parseCanonicalInstant(r.effectiveUntil);
          const observed = Date.parse(String(r.observedAt)),
            until = Date.parse(String(r.validUntil)),
            effective = Date.parse(String(r.effectiveAt));
          if (
            until <= observed ||
            until - observed > 5000 ||
            effective > observed ||
            Date.parse(String(r.effectiveFrom)) > effective ||
            (r.effectiveUntil !== null && Date.parse(String(r.effectiveUntil)) <= effective)
          )
            throw new Error("Invalid lease");
          return r;
        });
        response.json(result);
      })
      .catch((error) => taxConfigAuthoringFailure(response, error));
  });
  for (const mode of ["current", "version", "roster"] as const) {
    router.get(
      "/tax-config/authoring/materials/" + mode,
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          key =
            mode === "roster"
              ? "afterMaterial"
              : mode === "version"
                ? "versionReference"
                : "materialReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some(
            (k) => !["storeReference", "materialKind", key].includes(k),
          ) ||
          typeof request.query.storeReference !== "string" ||
          typeof request.query.materialKind !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          materialKind: TaxConfigMaterialKind,
          target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          materialKind = taxMaterialKind(request.query.materialKind);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
          if (mode === "version" && target === null)
            throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
          materialKind,
        };
        void (
          mode === "roster"
            ? port.materialRoster({ ...input, afterMaterial: target })
            : mode === "version"
              ? port.materialVersion({ ...input, versionReference: target })
              : port.materialCurrent({ ...input, materialReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              mode === "roster"
                ? parseTaxConfigMaterialRoster(value)
                : parseTaxConfigMaterialCurrent(value),
            );
            taxSameScope(result, expectedScope);
            if (
              result.materialKind !== materialKind ||
              (mode === "roster"
                ? !("afterMaterial" in result) || result.afterMaterial !== target
                : mode === "version"
                  ? !("version" in result) || result.version?.versionReference !== target
                  : !("materialReference" in result) || result.materialReference !== target)
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving
        ? "/tax-config/authoring/materials/resolve-original"
        : "/tax-config/authoring/materials/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          command:
            | ReturnType<typeof parseTaxConfigMaterialCommand>
            | ReturnType<typeof parseTaxConfigMaterialResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigMaterialResolve(request.body)
            : parseTaxConfigMaterialCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope, command };
        void (resolving ? port.materialResolve(input) : port.materialExecute(input))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigMaterialOperation(value));
            taxSameScope(result, expectedScope);
            if (
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.materialReference !== command.materialReference ||
              result.expectedRevision !== command.expectedRevision ||
              result.materialKind !== command.materialKind ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigMaterialIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  for (const listing of [false, true]) {
    router.get(
      listing
        ? "/tax-config/authoring/candidates/roster"
        : "/tax-config/authoring/candidates/current",
      safeRead(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          key = listing ? "afterCandidate" : "targetVersionReference";
        if (
          request.method !== "GET" ||
          sessionCookie === null ||
          request.body !== undefined ||
          Object.keys(request.query).some(
            (k) => !["storeReference", "configurationReference", key].includes(k),
          ) ||
          typeof request.query.storeReference !== "string" ||
          typeof request.query.configurationReference !== "string" ||
          (Object.hasOwn(request.query, key) && typeof request.query[key] !== "string") ||
          rawHeaderValues(request, "origin").length > 1 ||
          rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          configurationReference: ReturnType<typeof parsePricingReference>,
          target: ReturnType<typeof parsePricingReference> | null;
        try {
          expectedScope = taxConfigExpectedScope(request);
          if (parsePricingReference(request.query.storeReference) !== expectedScope.storeReference)
            throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
          configurationReference = parsePricingReference(request.query.configurationReference);
          target = Object.hasOwn(request.query, key)
            ? parsePricingReference(request.query[key])
            : null;
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = {
          sessionCookie,
          expectedScope,
          expectedStoreReference: expectedScope.storeReference,
          configurationReference,
        };
        void (
          listing
            ? port.candidateRoster({ ...input, afterCandidate: target })
            : port.candidateCurrent({ ...input, targetVersionReference: target })
        )
          .then((value) => {
            const result = taxConfigOutput(() =>
              listing
                ? parseTaxConfigCandidateRoster(value)
                : parseTaxConfigCandidateCurrent(value),
            );
            taxSameScope(result, expectedScope);
            if (
              result.configurationReference !== configurationReference ||
              (listing
                ? !("afterCandidate" in result) || result.afterCandidate !== target
                : !("targetVersionReference" in result) ||
                  (target !== null && result.targetVersionReference !== target))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }
  for (const resolving of [false, true]) {
    router.post(
      resolving
        ? "/tax-config/authoring/candidates/resolve-original"
        : "/tax-config/authoring/candidates/commands",
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
          command:
            | ReturnType<typeof parseTaxConfigCandidateCommand>
            | ReturnType<typeof parseTaxConfigCandidateResolve>;
        try {
          expectedScope = taxConfigExpectedScope(request);
          command = resolving
            ? parseTaxConfigCandidateResolve(request.body)
            : parseTaxConfigCandidateCommand(request.body);
        } catch (error) {
          taxConfigAuthoringFailure(
            response,
            error instanceof TaxConfigWorkflowError
              ? error
              : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
          );
          return;
        }
        const port = options.taxConfigAuthoring;
        if (!port) {
          taxConfigAuthoringFailure(response, undefined);
          return;
        }
        const input = { sessionCookie, csrf, expectedScope, command };
        void (resolving ? port.candidateResolve(input) : port.candidatePrepare(input))
          .then((value) => {
            const result = taxConfigOutput(() => parseTaxConfigCandidateOperation(value));
            taxSameScope(result, expectedScope);
            if (
              result.action !== command.action ||
              result.operationReference !== command.operationReference ||
              result.configurationReference !== command.configurationReference ||
              canonicalizeRfc8785(result.expectedDraft) !==
                canonicalizeRfc8785(command.expectedDraft) ||
              canonicalizeRfc8785(result.registrationMaterial) !==
                canonicalizeRfc8785(command.registrationMaterial) ||
              result.intentDigest !==
                ("intentDigest" in command
                  ? command.intentDigest
                  : taxConfigCandidateIntentDigest(expectedScope, command))
            )
              throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
            response.json(result);
          })
          .catch((error) => taxConfigAuthoringFailure(response, error));
      },
    );
  }

  router.post(
    "/tax-config/authoring/materials/compare",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0 ||
        request.body === undefined
      ) {
        denied(response);
        return;
      }
      let expectedScope: ReturnType<typeof parseTaxConfigAuthoringScope>,
        command: ReturnType<typeof parseMerchantTaxConfigMaterialComparisonCommand>;
      try {
        expectedScope = taxConfigExpectedScope(request);
        command = parseMerchantTaxConfigMaterialComparisonCommand(request.body);
      } catch (error) {
        taxConfigAuthoringFailure(
          response,
          error instanceof TaxConfigWorkflowError
            ? error
            : new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID"),
        );
        return;
      }
      const port = options.taxConfigAuthoring;
      if (!port) {
        taxConfigAuthoringFailure(response, undefined);
        return;
      }
      void port
        .materialCompare({ sessionCookie, csrf, expectedScope, command })
        .then((value) => {
          const result = taxConfigOutput(() => parseTaxConfigMaterialComparison(value));
          if (
            canonicalizeRfc8785({
              tenantReference: result.tenantReference,
              brandReference: result.brandReference,
              storeReference: result.storeReference,
              actorReference: result.actorReference,
            }) !== canonicalizeRfc8785(expectedScope) ||
            canonicalizeRfc8785(result.comparison.candidate) !==
              canonicalizeRfc8785(command.targetPublicationCandidate) ||
            canonicalizeRfc8785(result.comparison.suite) !==
              canonicalizeRfc8785(command.fixtureSuiteMaterial)
          )
            throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })
        .catch((error) => taxConfigAuthoringFailure(response, error));
    },
  );
}
