/** Merchant BFF routes: store configuration (ordinary commands, hours, withdrawal). Registered by createMerchantBffRouter (merchant-bff.ts). */
import express, { type Router } from "express";
import {
  MerchantSoleOperatorBasisError,
  MerchantSoleOperatorGateError,
} from "./merchant-sole-operator.js";
import {
  parseStoreAdministrationReference,
  parseStoreConfigurationOrdinaryCommand,
  parseStoreConfigurationOrdinaryReceipt,
  parseStoreConfigurationOrdinaryResolve,
  StoreConfigurationAdministrationError,
  StoreConfigurationAdministrationServiceError,
  StoreConfigurationOriginalError,
  type StoreConfigurationOriginalScope,
  StoreSetupOperationError,
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
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCatalogInstant } from "@rms/catalog";
import {
  parseMerchantStoreConfigurationHistoryPage,
  parseMerchantStoreConfigurationOrdinaryWorkspace,
} from "./merchant-store-configuration-ordinary-values.js";
import type {
  MerchantBffRouterOptions,
  MerchantStoreConfigurationOrdinaryPort,
} from "./merchant-bff-contract.js";
import { MerchantStoreHoursNoChangeError } from "./merchant-store-configuration.js";
import { MerchantStoreConfigurationWithdrawalError } from "./merchant-store-configuration-withdrawal.js";

export function installMerchantStoreConfigurationRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const ordinaryFailure = (response: express.Response, error: unknown): void => {
    // WP-2423 (v15 2026-10-16): approved alone while sole operator was off; withdraw it instead.
    if (error instanceof MerchantSoleOperatorBasisError) {
      response
        .status(409)
        .set("Cache-Control", NO_STORE)
        .json({ error: "sole_operator_approval_invalid" });
      return;
    }
    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: why the Owner's own approval was not accepted.
    if (error instanceof MerchantSoleOperatorGateError) {
      response
        .status(403)
        .set("Cache-Control", NO_STORE)
        .json({
          error:
            error.code !== "NotInEffect"
              ? "sole_operator_needs_verification"
              : error.reason === "Off"
                ? "sole_operator_off"
                : "sole_operator_not_in_effect",
        });
      return;
    }
    const code =
      error instanceof StoreConfigurationOriginalError ||
      error instanceof StoreConfigurationAdministrationError ||
      error instanceof StoreSetupOperationError ||
      error instanceof StoreConfigurationAdministrationServiceError
        ? error.code
        : undefined;
    // WP-2423 (v15 D2/D3): refusals the Owner can act on, each with its plain reason.
    const reason =
      code === "STORE_SETUP_OPERATION_INCOMPLETE"
        ? "store_setup_incomplete"
        : code === "STORE_SETUP_OPERATION_OUTDATED"
          ? "store_setup_outdated"
          : code === "STORE_CONFIGURATION_OPEN_CHANGE_BY_ANOTHER"
            ? "open_change_by_another"
            : code === "STORE_CONFIGURATION_WITHDRAWN"
              ? "store_configuration_withdrawn"
              : code === "STORE_CONFIGURATION_NOT_YOUR_CHANGE"
                ? "not_your_change"
                : null;
    if (reason !== null) {
      response.status(409).set("Cache-Control", NO_STORE).json({ error: reason });
      return;
    }
    const invalid =
      code === "STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID" ||
      code === "STORE_CONFIGURATION_INPUT_INVALID";
    const forbidden = code === "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED";
    const conflict =
      code === "STORE_CONFIGURATION_ORIGINAL_VERSION_CONFLICT" ||
      code === "STORE_SETUP_OPERATION_VERSION_CONFLICT" ||
      code === "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT" ||
      code === "STORE_CONFIGURATION_STATE_INVALID" ||
      code === "STORE_CONFIGURATION_OVERLAP" ||
      code === "STORE_CONFIGURATION_GATE_REQUIRED" ||
      // WP-2423 DEC-STORE-SETUP-PUBLICATION: a publication check or a newer recorded state
      // refused the step; the screen re-reads the checks instead of reporting an outage.
      code === "STORE_CONFIGURATION_REFERENCE_INVALID" ||
      code === "STORE_CONFIGURATION_VERSION_CONFLICT" ||
      code === "STORE_CONFIGURATION_LIFECYCLE_CONFLICT";
    response
      .status(invalid ? 400 : forbidden ? 403 : conflict ? 409 : 503)
      .set("Cache-Control", NO_STORE)
      .json({
        error: invalid
          ? "store_configuration_ordinary_invalid"
          : forbidden
            ? "request_denied"
            : conflict
              ? "store_configuration_ordinary_conflict"
              : "store_configuration_ordinary_unavailable",
      });
  };
  const ordinaryScope = (request: express.Request): StoreConfigurationOriginalScope => {
    const encoded = exactHeader(request, "x-bop-store-setup-scope");
    if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/u.test(encoded))
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    const bytes = Buffer.from(encoded, "base64url"),
      text = bytes.toString("utf8");
    if (bytes.toString("base64url") !== encoded || !Buffer.from(text, "utf8").equals(bytes))
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
    const raw = readClosedRecord(JSON.parse(text), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ]);
    return Object.freeze({
      tenantReference: parseStoreAdministrationReference(raw.tenantReference),
      brandReference: parseStoreAdministrationReference(raw.brandReference),
      storeReference: parseStoreAdministrationReference(raw.storeReference),
      actorReference: parseStoreAdministrationReference(raw.actorReference),
    });
  };
  const ordinaryInput = (value: unknown, scope: StoreConfigurationOriginalScope) => {
    const profile =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "profile")?.value
        : undefined;
    const parsed =
      profile === "StoreConfigurationOrdinaryResolveV1"
        ? parseStoreConfigurationOrdinaryResolve(value)
        : parseStoreConfigurationOrdinaryCommand(value);
    if (
      Object.entries(scope).some(
        ([key, reference]) => Object.getOwnPropertyDescriptor(parsed, key)?.value !== reference,
      )
    )
      throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
    const body = { ...parsed, profile: "StoreConfigurationOrdinaryCommandV1" };
    Reflect.deleteProperty(body, "intentDigest");
    const command = parseStoreConfigurationOrdinaryCommand(body),
      intentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
    if ("intentDigest" in parsed && parsed.intentDigest !== intentDigest)
      throw new StoreConfigurationOriginalError(
        "STORE_CONFIGURATION_ORIGINAL_IDEMPOTENCY_CONFLICT",
      );
    return { parsed, command, intentDigest };
  };
  const ordinaryReceipt = (value: unknown, input: ReturnType<typeof ordinaryInput>) => {
    const receipt = parseStoreConfigurationOrdinaryReceipt(value),
      body = { ...receipt, profile: "StoreConfigurationOrdinaryCommandV1" };
    for (const key of [
      "intentDigest",
      "outcome",
      "operation",
      "auditReference",
      "occurredAt",
      "dataClassification",
    ])
      Reflect.deleteProperty(body, key);
    if (
      canonicalizeRfc8785(parseStoreConfigurationOrdinaryCommand(body)) !==
        canonicalizeRfc8785(input.command) ||
      receipt.intentDigest !== input.intentDigest
    )
      throw new Error("invalid ordinary response");
    return receipt;
  };
  const ordinaryRead = (
    response: express.Response,
    requestInput: Parameters<MerchantStoreConfigurationOrdinaryPort["read"]>[0],
  ) => {
    const port = options.storeConfigurationOrdinary,
      read = port?.read,
      clock = options.storeConfigurationOrdinaryClock,
      now = clock?.now;
    // WP-2423 Q15/Q16: a deployment that does not compose Store configuration publication answers
    // that plainly (404), so Store setup hides the publication panel instead of showing an outage.
    if (port === undefined && clock === undefined) {
      response
        .status(404)
        .set("Cache-Control", NO_STORE)
        .json({ error: "store_configuration_publication_not_offered" });
      return;
    }
    if (!port || typeof read !== "function" || !clock || typeof now !== "function") {
      ordinaryFailure(response, undefined);
      return;
    }
    let before: string;
    try {
      before = parseCatalogInstant(now.call(clock));
    } catch {
      ordinaryFailure(response, undefined);
      return;
    }
    void read
      .call(port, requestInput)
      .then((value) => {
        try {
          if (
            options.storeConfigurationOrdinary !== port ||
            port.read !== read ||
            options.storeConfigurationOrdinaryClock !== clock ||
            clock.now !== now
          )
            throw new Error("changed ordinary response source");
          const view = parseMerchantStoreConfigurationOrdinaryWorkspace(
              value,
              requestInput.expectedScope,
            ),
            at = parseCatalogInstant(now.call(clock));
          if (
            at < before ||
            String(view.observedAt) > String(at) ||
            String(view.validUntil) <= String(at)
          )
            throw new Error("unavailable ordinary response");
          if (requestInput.original) {
            if (view.original !== null)
              ordinaryReceipt(
                view.original,
                ordinaryInput(requestInput.original, requestInput.expectedScope),
              );
          } else if (view.original !== null) throw new Error("unexpected original response");
          response.json(view);
        } catch {
          ordinaryFailure(response, undefined);
        }
      })
      .catch((error) => ordinaryFailure(response, error));
  };
  router.get("/store-configuration/ordinary", safeRead(options), (request, response) => {
    response.set("Cache-Control", NO_STORE);
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      sessionCookie === null ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1 ||
      rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1
    ) {
      denied(response);
      return;
    }
    try {
      if (
        Object.keys(request.query).length !== 1 ||
        typeof request.query.expectedStoreReference !== "string"
      )
        throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
      const expectedScope = ordinaryScope(request),
        expectedStoreReference = parseStoreAdministrationReference(
          request.query.expectedStoreReference,
        );
      if (expectedStoreReference !== expectedScope.storeReference)
        throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED");
      ordinaryRead(response, { sessionCookie, expectedStoreReference, expectedScope });
    } catch (error) {
      ordinaryFailure(
        response,
        error instanceof StoreConfigurationOriginalError
          ? error
          : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
      );
    }
  });
  router.post(
    "/store-configuration/ordinary-history",
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
      try {
        const expectedScope = ordinaryScope(request);
        const body = readClosedRecord(request.body, ["expectedStoreReference", "beforeSequence"]);
        const expectedStoreReference = parseStoreAdministrationReference(
            body.expectedStoreReference,
          ),
          beforeSequence = body.beforeSequence;
        if (expectedStoreReference !== expectedScope.storeReference)
          throw new StoreConfigurationOriginalError(
            "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
          );
        if (
          beforeSequence !== null &&
          (typeof beforeSequence !== "number" ||
            !Number.isSafeInteger(beforeSequence) ||
            beforeSequence < 1)
        )
          throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
        const port = options.storeConfigurationOrdinary,
          read = port?.history,
          clock = options.storeConfigurationOrdinaryClock,
          now = clock?.now;
        if (!port || !read || !clock || typeof now !== "function") {
          ordinaryFailure(response, undefined);
          return;
        }
        let origin: string;
        try {
          origin = parseCanonicalInstant(now.call(clock));
        } catch {
          ordinaryFailure(response, undefined);
          return;
        }
        void read
          .call(port, {
            sessionCookie,
            csrf,
            expectedStoreReference,
            expectedScope,
            beforeSequence,
          })
          .then((value) => {
            if (
              options.storeConfigurationOrdinary !== port ||
              port.history !== read ||
              options.storeConfigurationOrdinaryClock !== clock ||
              clock.now !== now
            )
              throw new Error("Changed history source");
            const page = parseMerchantStoreConfigurationHistoryPage(
                value,
                expectedScope,
                beforeSequence,
              ),
              at = parseCanonicalInstant(now.call(clock));
            if (
              at < origin ||
              page.observedAt < origin ||
              page.observedAt > at ||
              at >= page.validUntil ||
              Date.parse(at) - Date.parse(origin) >= 5000
            )
              throw new Error("Expired history source");
            response.set("Cache-Control", NO_STORE).json(page);
          })
          .catch((error) => ordinaryFailure(response, error));
      } catch (error) {
        ordinaryFailure(
          response,
          error instanceof StoreConfigurationOriginalError
            ? error
            : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
        );
      }
    },
  );
  for (const path of [
    "/store-configuration/ordinary-command",
    "/store-configuration/ordinary-state",
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant"),
        csrf = exactHeader(request, "x-bop-csrf");
      if (
        sessionCookie === null ||
        csrf === null ||
        !/^[A-Za-z0-9_-]{43}$/u.test(csrf) ||
        rawHeaderValues(request, "x-bop-store-setup-scope").length !== 1 ||
        Object.keys(request.query).length !== 0
      ) {
        denied(response);
        return;
      }
      try {
        const expectedScope = ordinaryScope(request);
        if (path.endsWith("ordinary-state")) {
          const body = readClosedRecord(request.body, ["original", "expectedStoreReference"]),
            original = parseStoreConfigurationOrdinaryResolve(body.original);
          ordinaryInput(original, expectedScope);
          const expectedStoreReference = parseStoreAdministrationReference(
            body.expectedStoreReference,
          );
          if (expectedStoreReference !== expectedScope.storeReference)
            throw new StoreConfigurationOriginalError(
              "STORE_CONFIGURATION_ORIGINAL_PERMISSION_DENIED",
            );
          void options.service
            .authorize({ sessionCookie, csrf })
            .then(() =>
              ordinaryRead(response, {
                sessionCookie,
                expectedStoreReference,
                expectedScope,
                original,
                csrf,
              }),
            )
            .catch(() => denied(response));
          return;
        }
        const withMode =
          request.body !== null &&
          typeof request.body === "object" &&
          Object.hasOwn(request.body, "approvalMode");
        const body = readClosedRecord(request.body, [
            "command",
            ...(withMode ? ["approvalMode"] : []),
          ]),
          input = ordinaryInput(body.command, expectedScope);
        if (withMode && body.approvalMode !== "SoleOperator")
          throw new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID");
        const approvalMode = withMode ? ("SoleOperator" as const) : undefined,
          port = options.storeConfigurationOrdinary,
          write = port?.write;
        const clock = options.storeConfigurationOrdinaryClock,
          now = clock?.now;
        if (!port || typeof write !== "function" || !clock || typeof now !== "function") {
          ordinaryFailure(response, undefined);
          return;
        }
        let before: string;
        try {
          before = parseCatalogInstant(now.call(clock));
        } catch {
          ordinaryFailure(response, undefined);
          return;
        }
        void write
          .call(port, {
            sessionCookie,
            csrf,
            command: input.parsed,
            expectedScope,
            ...(approvalMode === undefined ? {} : { approvalMode }),
          })
          .then((value) => {
            try {
              if (
                options.storeConfigurationOrdinary !== port ||
                port.write !== write ||
                options.storeConfigurationOrdinaryClock !== clock ||
                clock.now !== now
              )
                throw new Error("changed ordinary response source");
              const receipt = ordinaryReceipt(value, input),
                at = parseCatalogInstant(now.call(clock));
              if (at < before || receipt.occurredAt > String(at))
                throw new Error("future ordinary response");
              response.json(receipt);
            } catch {
              ordinaryFailure(response, undefined);
            }
          })
          .catch((error) => ordinaryFailure(response, error));
      } catch (error) {
        ordinaryFailure(
          response,
          error instanceof StoreConfigurationOriginalError
            ? error
            : new StoreConfigurationOriginalError("STORE_CONFIGURATION_ORIGINAL_INPUT_INVALID"),
        );
      }
    });

  router.get("/store-configuration", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (
      request.method !== "GET" ||
      sessionCookie === null ||
      Object.keys(request.query).length !== 0 ||
      request.body !== undefined ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.storeConfigurationState) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfigurationState(sessionCookie)
      .then((state) => response.json(state))
      .catch(() => denied(response));
  });

  router.post("/store-configuration", sameOriginMutation(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const csrf = exactHeader(request, "x-bop-csrf");
    if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
      denied(response);
      return;
    }
    if (!options.storeConfiguration) {
      response.status(503).json({ error: "store_configuration_unavailable" });
      return;
    }
    void options
      .storeConfiguration({ sessionCookie, csrf, command: request.body })
      .then((result) =>
        response.json({ status: result.status, resultingVersion: result.resultingVersion }),
      )
      .catch((error: unknown) => {
        const code: unknown =
          error instanceof Error
            ? Object.getOwnPropertyDescriptor(error, "code")?.value
            : undefined;
        // WP-2423 (2026-10-16 v15): the hours saved are the hours already saved; nothing written.
        if (error instanceof MerchantStoreHoursNoChangeError)
          response.status(409).json({ error: "no_change" });
        // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: why the Owner's own approval was not accepted.
        else if (error instanceof MerchantSoleOperatorGateError)
          response.status(403).json({
            error:
              error.code !== "NotInEffect"
                ? "sole_operator_needs_verification"
                : error.reason === "Off"
                  ? "sole_operator_off"
                  : "sole_operator_not_in_effect",
          });
        // WP-2423 (v15 2026-10-16): approved alone while sole operator was off; withdraw it.
        else if (error instanceof MerchantSoleOperatorBasisError)
          response.status(409).json({ error: "sole_operator_approval_invalid" });
        // WP-2423 (v15 D2/D3): another person's open change, or a withdrawn one, said plainly.
        else if (code === "STORE_CONFIGURATION_OPEN_CHANGE_BY_ANOTHER")
          response.status(409).json({ error: "open_change_by_another" });
        // WP-2423 (v15): only the person who made a change checks it or sends it for approval;
        // the person who made or sent a change approves it only alone as sole operator.
        else if (code === "STORE_CONFIGURATION_NOT_YOUR_CHANGE")
          response.status(409).json({ error: "not_your_change" });
        else if (code === "STORE_CONFIGURATION_SELF_APPROVAL")
          response.status(409).json({ error: "approval_needs_another_person" });
        else if (code === "STORE_CONFIGURATION_WITHDRAWN")
          response.status(409).json({ error: "store_configuration_withdrawn" });
        // A step on a change that moved on meanwhile (e.g. another Owner approved it first).
        else if (
          code === "STORE_CONFIGURATION_VERSION_CONFLICT" ||
          code === "STORE_CONFIGURATION_LIFECYCLE_CONFLICT" ||
          code === "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT"
        )
          response.status(409).json({ error: "store_configuration_conflict" });
        // WP-2423 Q4: an owner rule rejected the content (not access), so staff can correct it.
        // Transport binding failures stay denied.
        else if (
          code === "STORE_CONFIGURATION_COMMAND_INVALID" ||
          code === "STORE_CONFIGURATION_REFERENCE_INVALID" ||
          code === "STORE_CONFIGURATION_APPROVAL_INVALID" ||
          code === "STORE_CONFIGURATION_LIVE_GATE_INVALID" ||
          (error instanceof Error && error.message === "STORE_CONFIGURATION_REFERENCE_INVALID")
        )
          response.status(422).json({ error: "store_configuration_rejected" });
        else denied(response);
      });
  });

  // WP-2423 (v15 D2/D3): withdraw (own) or decline (another person's) the Store's configuration
  // that is not published yet; append-only record and audit.
  router.post(
    "/store-configuration/withdrawal",
    sameOriginMutation(options),
    (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
        denied(response);
        return;
      }
      const port = options.storeConfigurationWithdrawal;
      if (!port) {
        response.status(503).json({ error: "store_configuration_unavailable" });
        return;
      }
      const restore = options.storeHoursRestore;
      void port({ sessionCookie, csrf, command: request.body })
        .then(async (result) => {
          // WP-2423 (2026-10-16 v15): the withdrawn hours leave Store setup too (its own
          // transaction; repeated by a retried withdrawal). The withdrawal stands either way.
          let setupHoursRestored = false;
          if (restore !== undefined)
            try {
              setupHoursRestored =
                (
                  await restore({
                    sessionCookie,
                    csrf,
                    withdrawalReference: String(
                      (request.body as { auditReference?: unknown }).auditReference,
                    ),
                  })
                ).status === "Restored";
            } catch {
              setupHoursRestored = false;
            }
          response.json({ status: result.status, kind: result.kind, setupHoursRestored });
        })
        .catch((error: unknown) => {
          if (transactionConflictRetryLater(response, error)) return;
          if (!(error instanceof MerchantStoreConfigurationWithdrawalError)) {
            response.status(503).json({ error: "store_configuration_unavailable" });
            return;
          }
          if (error.code === "Invalid")
            response.status(400).json({ error: "store_configuration_withdrawal_invalid" });
          else if (error.code === "Conflict")
            response.status(409).json({ error: "store_configuration_conflict" });
          else denied(response);
        });
    },
  );

  // WP-2423 Q4: the Store Manager's hours change when the configuration came from Store setup.
  router.post(
    "/store-configuration/hours-draft",
    sameOriginMutation(options),
    (request, response) => {
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      const csrf = exactHeader(request, "x-bop-csrf");
      if (sessionCookie === null || csrf === null || Object.keys(request.query).length !== 0) {
        denied(response);
        return;
      }
      if (!options.storeHoursDraft) {
        response.status(503).json({ error: "store_configuration_unavailable" });
        return;
      }
      void options
        .storeHoursDraft({ sessionCookie, csrf, command: request.body })
        .then((result) =>
          response.json({ status: result.status, resultingVersion: result.resultingVersion }),
        )
        .catch((error: unknown) => {
          const code: unknown =
            error instanceof Error
              ? Object.getOwnPropertyDescriptor(error, "code")?.value
              : undefined;
          // WP-2423 (2026-10-16 v15): the hours already saved; nothing written.
          if (error instanceof MerchantStoreHoursNoChangeError)
            response.status(409).json({ error: "no_change" });
          else if (code === "STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES")
            response.status(409).json({ error: "store_setup_has_unpublished_changes" });
          else if (code === "STORE_CONFIGURATION_OPEN_CHANGE_BY_ANOTHER")
            response.status(409).json({ error: "open_change_by_another" });
          else if (
            code === "STORE_CONFIGURATION_VERSION_CONFLICT" ||
            code === "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT" ||
            code === "STORE_CONFIGURATION_LIFECYCLE_CONFLICT" ||
            code === "STORE_SETUP_OPERATION_VERSION_CONFLICT" ||
            code === "STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT"
          )
            response.status(409).json({ error: "store_configuration_conflict" });
          else if (
            code === "STORE_CONFIGURATION_COMMAND_INVALID" ||
            code === "STORE_CONFIGURATION_REFERENCE_INVALID"
          )
            response.status(422).json({ error: "store_configuration_rejected" });
          else denied(response);
        });
    },
  );
}
