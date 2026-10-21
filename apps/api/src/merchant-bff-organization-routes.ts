/** Merchant BFF routes: brand/store topology, brand lifecycle, roles, staff and sole operator. Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import {
  BrandAdministrationServiceError,
  BrandStoreTopologyError,
  parseBrandReference,
  parseBrandStoreTopologyOperationReceipt,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologySave,
  parsePlatformTenantReference,
} from "@bop/tenant";
import { MerchantBrandStoreTopologyFeatureDisabled } from "./merchant-brand-store-topology-capability.js";
import {
  cookie,
  denied,
  exactHeader,
  NO_STORE,
  rawHeaderValues,
  refundReadFailure,
  safeRead,
  sameOriginMutation,
} from "./merchant-bff-http.js";
import { readClosedRecord } from "@bop/identity";
import { parseBrandStoreTopologyWorkbench } from "./merchant-brand-store-topology-draft.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { MerchantSoleOperatorError } from "./merchant-sole-operator-setting.js";
import { MerchantRoleAdministrationError } from "./merchant-role-administration.js";
import { MerchantStaffAdministrationError } from "./merchant-staff-administration.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantOrganizationRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const topologyFailure = (response: express.Response, error: unknown): void => {
    const code = error instanceof BrandStoreTopologyError ? error.code : undefined;
    const invalid = code === "BRAND_STORE_TOPOLOGY_INPUT_INVALID",
      forbidden = code === "BRAND_STORE_TOPOLOGY_PERMISSION_DENIED";
    const conflict =
      code === "BRAND_STORE_TOPOLOGY_VERSION_CONFLICT" ||
      code === "BRAND_STORE_TOPOLOGY_OPERATION_INTENT_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error:
          error instanceof MerchantBrandStoreTopologyFeatureDisabled
            ? "brand_store_topology_feature_disabled"
            : invalid
              ? "brand_store_topology_invalid"
              : forbidden
                ? "request_denied"
                : conflict
                  ? "brand_store_topology_conflict"
                  : "brand_store_topology_unavailable",
      });
  };
  const topologyScope = (value: unknown) => {
    const r = readClosedRecord(value, ["tenantReference", "brandReference", "actorReference"]);
    return Object.freeze({
      tenantReference: parsePlatformTenantReference(r.tenantReference),
      brandReference: parseBrandReference(r.brandReference),
      actorReference: parseBrandReference(r.actorReference),
    });
  };
  for (const mode of ["workspace", "save", "resolve"] as const)
    router.post(
      "/organization/brands/topology/draft/" + mode,
      sameOriginMutation(options),
      (request, response) => {
        response.set("Cache-Control", NO_STORE);
        const sessionCookie = cookie(request, "__Host-bop-merchant"),
          csrf = exactHeader(request, "x-bop-csrf");
        if (
          sessionCookie === null ||
          csrf === null ||
          !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
          rawHeaderValues(request, "x-bop-csrf").length !== 1 ||
          Object.keys(request.query).length !== 0 ||
          request.body === undefined
        ) {
          denied(response);
          return;
        }
        const port = options.brandStoreTopologyDraft;
        if (!port) {
          topologyFailure(response, undefined);
          return;
        }
        void (async () => {
          let expectedBrandReference: string | undefined,
            expectedScope: ReturnType<typeof topologyScope> | undefined;
          let command:
            | ReturnType<typeof parseBrandStoreTopologySave>
            | ReturnType<typeof parseBrandStoreTopologyResolve>
            | undefined;
          try {
            if (mode === "workspace") {
              const body = readClosedRecord(
                request.body,
                Object.hasOwn(request.body, "expectedScope")
                  ? ["expectedBrandReference", "expectedScope"]
                  : ["expectedBrandReference"],
              );
              expectedBrandReference = String(parseBrandReference(body.expectedBrandReference));
              if (Object.hasOwn(body, "expectedScope"))
                expectedScope = topologyScope(body.expectedScope);
              if (expectedScope && expectedScope.brandReference !== expectedBrandReference)
                throw new Error("invalid");
            } else {
              const body = readClosedRecord(request.body, ["expectedScope", "command"]);
              expectedScope = topologyScope(body.expectedScope);
              command =
                mode === "save"
                  ? parseBrandStoreTopologySave(body.command)
                  : parseBrandStoreTopologyResolve(body.command);
              if (
                Object.entries(expectedScope).some(
                  ([key, value]) => Object.getOwnPropertyDescriptor(command, key)?.value !== value,
                )
              )
                throw new Error("invalid");
            }
          } catch {
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
          }
          if (mode === "workspace") {
            const value = await port.workspace({
              sessionCookie,
              csrf,
              expectedBrandReference,
              ...(expectedScope ? { expectedScope } : {}),
            });
            const result = parseBrandStoreTopologyWorkbench(
              value,
              options.brandStoreTopologyClock?.now(),
            );
            if (
              result.brandReference !== expectedBrandReference ||
              (expectedScope &&
                Object.entries(expectedScope).some(
                  ([key, value]) => Object.getOwnPropertyDescriptor(result, key)?.value !== value,
                ))
            )
              throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
            response.json(result);
            return;
          }
          if (!command || !expectedScope)
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
          const value = await port[mode]({ sessionCookie, csrf, expectedScope, command });
          let result: ReturnType<typeof parseBrandStoreTopologyOperationReceipt>;
          try {
            result = parseBrandStoreTopologyOperationReceipt(value);
          } catch {
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
          }
          const intent =
            command.profile === "BrandStoreTopologySaveV1"
              ? "sha256:" + sha256Hex(canonicalizeRfc8785(command))
              : command.intentDigest;
          if (
            Object.entries(expectedScope).some(
              ([key, value]) => Object.getOwnPropertyDescriptor(result, key)?.value !== value,
            ) ||
            result.operationReference !== command.operationReference ||
            result.expectedRevision !== command.expectedRevision ||
            result.intentDigest !== intent ||
            (command.profile === "BrandStoreTopologySaveV1" &&
              result.snapshot &&
              canonicalizeRfc8785(result.snapshot.content) !== canonicalizeRfc8785(command.content))
          )
            throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
          response.json(result);
        })().catch((error) => topologyFailure(response, error));
      },
    );

  // WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the Brand Owner's sole-operator setting.
  router.get("/organization/sole-operator", safeRead(options), (request, response) => {
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
    if (!options.soleOperator) {
      response.status(503).json({ error: "sole_operator_unavailable" });
      return;
    }
    const port = options.soleOperator;
    void retryTransactionConflict(() => port.read({ sessionCookie }))
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch((error: unknown) => {
        // WP-2423: staff who are not the Brand Owner get "nothing to show", not a refusal.
        if (error instanceof MerchantSoleOperatorError && error.code === "NotOwner") {
          response.set("Cache-Control", NO_STORE).json({ brandOwner: false });
          return;
        }
        if (error instanceof MerchantSoleOperatorError && error.code === "Denied") {
          response
            .status(403)
            .set("Cache-Control", NO_STORE)
            .json({ error: "brand_owner_required" });
          return;
        }
        refundReadFailure(response, error);
      });
  });
  router.post("/organization/sole-operator", sameOriginMutation(options), (request, response) => {
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
    const command = options.soleOperator;
    if (!command) {
      response.status(503).json({ error: "sole_operator_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.set("Cache-Control", NO_STORE).json({
          status: result.status,
          state: result.state,
          version: result.version,
          recordedAt: result.recordedAt,
        }),
      )
      .catch((error: unknown) => {
        response.set("Cache-Control", NO_STORE);
        if (!(error instanceof MerchantSoleOperatorError)) {
          denied(response);
          return;
        }
        if (error.code === "Denied") response.status(403).json({ error: "brand_owner_required" });
        else if (error.code === "NeedsReverification")
          response.status(409).json({ error: "needs_reverification" });
        else if (error.code === "VersionConflict")
          response.status(409).json({ error: "setting_changed" });
        else if (error.code === "NoChange") response.status(409).json({ error: "no_change" });
        else response.status(422).json({ error: "invalid_request" });
      });
  });

  // WP-2423: IAM-ROLE-LIST / IAM-ROLE-EDITOR reads and role administration commands.
  const roleAdministrationStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    InUse: 409,
    Invalid: 400,
    Unavailable: 503,
  } as const;
  const roleAdministrationFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantRoleAdministrationError)) {
      denied(response);
      return;
    }
    response.status(roleAdministrationStatus[error.code]).json({ error: error.code });
  };
  router.post("/organization/roles/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { roleReference?: unknown } | undefined;
    const roleReference = body?.roleReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "roleReference" ||
      (roleReference !== null &&
        (typeof roleReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            roleReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.roleAdministration) {
      response.status(503).json({ error: "role_administration_unavailable" });
      return;
    }
    const roles = options.roleAdministration;
    void (
      roleReference === null
        ? roles.list({ sessionCookie, csrf })
        : roles.detail({ sessionCookie, csrf, roleReference })
    )
      .then((result) => response.json(result))
      .catch((error: unknown) => roleAdministrationFailure(response, error));
  });
  router.post("/organization/roles/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.roleAdministration) {
      response.status(503).json({ error: "role_administration_unavailable" });
      return;
    }
    void options.roleAdministration
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => roleAdministrationFailure(response, error));
  });

  // WP-2423: IAM-USER-LIST / IAM-USER-DETAIL reads and staff role assignment commands.
  const staffStatus = {
    PermissionDenied: 403,
    NotFound: 404,
    Conflict: 409,
    LastOwner: 409,
    BrandRolesRemain: 409,
    PendingRequestsRemain: 409,
    Invalid: 400,
    AlreadyInvited: 409,
    EmailMismatch: 409,
  } as const;
  const staffFailure = (response: express.Response, error: unknown) => {
    if (!(error instanceof MerchantStaffAdministrationError)) {
      denied(response);
      return;
    }
    response.status(staffStatus[error.code]).json({ error: error.code });
  };
  router.post("/organization/staff/query", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    const body = request.body as { actorReference?: unknown } | undefined;
    const actorReference = body?.actorReference ?? null;
    if (
      sessionCookie === null ||
      csrf === null ||
      csrf.length === 0 ||
      Object.keys(request.query).length !== 0 ||
      body === undefined ||
      Object.keys(body).join(",") !== "actorReference" ||
      (actorReference !== null &&
        (typeof actorReference !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            actorReference,
          )))
    ) {
      denied(response);
      return;
    }
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .query({ sessionCookie, csrf, actorReference })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });
  router.post("/organization/staff/command", sameOriginMutation(options), (request, response) => {
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
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .command({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });

  // WP-2423: Home asks a signed-in member with no recorded name to add one (merchant.access).
  router.post("/organization/staff/me", sameOriginMutation(options), (request, response) => {
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
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .ownProfile({ sessionCookie, csrf })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });
  router.post("/organization/staff/me/name", sameOriginMutation(options), (request, response) => {
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
    if (!options.staffAdministration) {
      response.status(503).json({ error: "staff_administration_unavailable" });
      return;
    }
    void options.staffAdministration
      .nameSelf({ sessionCookie, csrf, body: request.body })
      .then((result) => response.json(result))
      .catch((error: unknown) => staffFailure(response, error));
  });

  router.post(
    "/organization/brands/lifecycle",
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
      if (!options.brandLifecycle) {
        response.status(503).json({ error: "brand_lifecycle_unavailable" });
        return;
      }
      void options
        .brandLifecycle({ sessionCookie, csrf, command: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (!(error instanceof BrandAdministrationServiceError)) {
            denied(response);
            return;
          }
          const status =
            error.code === "BRAND_ADMIN_INPUT_INVALID"
              ? 400
              : [
                    "BRAND_ADMIN_VERSION_CONFLICT",
                    "BRAND_ADMIN_IDEMPOTENCY_CONFLICT",
                    "BRAND_ADMIN_LIFECYCLE_CONFLICT",
                  ].includes(error.code)
                ? 409
                : error.code === "BRAND_ADMIN_DEPENDENCY_UNAVAILABLE"
                  ? 503
                  : 403;
          response.status(status).json({
            error:
              status === 400
                ? "brand_lifecycle_invalid"
                : status === 409
                  ? "brand_lifecycle_conflict"
                  : status === 503
                    ? "brand_lifecycle_unavailable"
                    : "request_denied",
          });
        });
    },
  );
}
