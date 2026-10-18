/** Merchant BFF routes: sign-in, Session, step-up and store context. Registered by createMerchantBffRouter (merchant-bff.ts). */
import {
  type AuthenticationSession,
  type BrowserCookieMutation,
  BrowserSessionError,
} from "@bop/identity";
import express, { type RequestHandler, type Router } from "express";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";
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
import { parseTaxConfigAuthoringCurrent } from "@rms/pricing";
import { parseMerchantWorkspaceSnapshot, targetStoreReference } from "./merchant-bff-workspace.js";
import {
  type MerchantStaffPinRouteOptions,
  resolveStaffSignInEntry,
  storeDeviceCookieName,
} from "./merchant-staff-pin-http.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { BrandStoreTopologyError } from "@bop/tenant";
import { MerchantStepUpError } from "./merchant-mfa-step-up.js";

const signInPathPattern = /^\/(?!\/)[A-Za-z0-9/_?=&.-]{0,200}$/u;

/** WP-2423 Q18: the deadlines staff see; never the Session reference or any credential. */
function sessionDeadlines(session: AuthenticationSession) {
  return {
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    idleTimeoutMinutes: session.policy.idleTimeoutMinutes,
    serverTime: new Date().toISOString(),
  };
}

function serializeCookie(mutation: BrowserCookieMutation): string {
  const { descriptor } = mutation;
  const parts = [
    `${descriptor.name}=${mutation.value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (mutation.clear) parts.push("Max-Age=0");
  else if (descriptor.maxAgeSeconds !== null) parts.push(`Max-Age=${descriptor.maxAgeSeconds}`);
  return parts.join("; ");
}

function oidcCallbackNavigation(options: MerchantBffRouterOptions): RequestHandler {
  return (request, response, next) => {
    const origin = exactHeader(request, "origin");
    const fetchSite = exactHeader(request, "sec-fetch-site");
    if (
      (origin !== null && origin !== options.exactOrigin) ||
      !["same-origin", "cross-site", "none"].includes(fetchSite ?? "")
    ) {
      denied(response);
      return;
    }
    next();
  };
}

export function installMerchantSessionRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
  staffPinRoutes: MerchantStaffPinRouteOptions,
): void {
  async function currentTaxNavigation(value: unknown, sessionCookie: unknown) {
    const workspace = parseMerchantWorkspaceSnapshot(value);
    const navigation = workspace.navigation.filter((item) => item.screenId !== "TAX-CONFIG");
    const port = options.taxConfigAuthoring;
    if (port) {
      try {
        const current = parseTaxConfigAuthoringCurrent(
          await port.current({
            sessionCookie,
            expectedStoreReference: workspace.selectedScope.storeReference,
            configurationReference: null,
          }),
          null,
        );
        if (
          current.storeReference === workspace.selectedScope.storeReference &&
          current.state === null
        ) {
          navigation.push({
            screenId: "TAX-CONFIG",
            label: "Tax",
            href: "/app/commerce/tax",
            permission: "pricing.tax-config.manage",
          });
        }
      } catch {
        // The owning port requires current Session/IAM and FeatureControl. Its
        // refusal hides only this entry; it does not invalidate other workspaces.
      }
    }
    return parseMerchantWorkspaceSnapshot({ ...workspace, navigation });
  }

  router.get("/login", safeRead(options), (request, response) => {
    void options.service
      .start(request.query.returnTo ?? "/")
      .then((result) => {
        response.set("Set-Cookie", serializeCookie(result.cookie));
        response.redirect(303, result.authorizationUrl);
      })
      .catch(() => denied(response));
  });

  router.get("/callback", oidcCallbackNavigation(options), (request, response) => {
    void options.service
      .callback({
        code: request.query.code,
        state: request.query.state,
        authCookie: cookie(request, "__Host-bop-auth"),
      })
      .then(async (result) => {
        // WP-2423 Q18: a full sign-in on a registered tablet signs out the PIN session left on it.
        const staffPin = staffPinRoutes.staffPin;
        const tablet = cookie(request, storeDeviceCookieName);
        if (staffPin !== undefined && tablet !== null)
          await retryTransactionConflict(() =>
            staffPin.afterFullSignIn({ deviceCookie: tablet, session: result.session }),
          ).catch(() => undefined);
        response.set("Set-Cookie", result.cookies.map(serializeCookie));
        response.redirect(303, result.postLoginPath);
      })
      .catch(() => {
        response.set(
          "Set-Cookie",
          "__Host-bop-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        denied(response);
      });
  });

  router.get("/session", safeRead(options), (request, response) => {
    void options.service
      .bootstrap(cookie(request, "__Host-bop-merchant"))
      .then(async (result) => {
        response.json({
          authenticated: true,
          csrf: result.csrf,
          workspace: await currentTaxNavigation(
            result.workspace,
            cookie(request, "__Host-bop-merchant"),
          ),
        });
      })
      .catch((error: unknown) => {
        if (
          error instanceof BrandStoreTopologyError &&
          error.code === "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE"
        ) {
          response.status(503).json({ error: "merchant_workspace_unavailable" });
          return;
        }
        denied(response);
      });
  });

  // WP-2423 Q18: where to sign in (public; no Session needed to find the sign-in page).
  // WP-2423 Q18 option A: on a registered shared tablet, the staff PIN lock screen.
  router.get("/sign-in-entry", safeRead(options), (request, response) => {
    void resolveStaffSignInEntry(request, staffPinRoutes).then((entry) => {
      if (!signInPathPattern.test(entry.path) || typeof entry.testOnly !== "boolean") {
        response.status(503).set("Cache-Control", NO_STORE).json({ error: "sign_in_unavailable" });
        return;
      }
      response.set("Cache-Control", NO_STORE).json({ path: entry.path, testOnly: entry.testOnly });
    });
  });

  // WP-2423 Q18: the Session deadlines. 401 `session_ended` only when the Session has genuinely
  // ended (the browser then signs staff out); 503 when it could not be checked now (retry later);
  // 403 for a refused request (origin, CSRF). A busy Session row never fails the request.
  function sessionDeadlineRoute(extend: boolean): express.RequestHandler {
    return (request, response) => {
      response.set("Cache-Control", NO_STORE);
      const sessionCookie = cookie(request, "__Host-bop-merchant");
      if (sessionCookie === null || sessionCookie === "") {
        response.status(401).json({ error: "session_ended" });
        return;
      }
      const input = { sessionCookie, csrf: request.header("x-bop-csrf") };
      const record = options.service.recordActivity;
      void (
        record === undefined
          ? options.service.authorize(input)
          : record.call(options.service, input, extend)
      )
        .then((session) => {
          response.json(sessionDeadlines(session));
        })
        .catch((error: unknown) => {
          if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_ENDED") {
            response.status(401).json({ error: "session_ended" });
            return;
          }
          if (
            record !== undefined &&
            !(
              error instanceof BrowserSessionError &&
              (error.code === "BROWSER_SESSION_DENIED" ||
                error.code === "BROWSER_SESSION_INPUT_INVALID")
            )
          ) {
            response
              .status(503)
              .set("Retry-After", "30")
              .json({ error: "session_check_unavailable" });
            return;
          }
          denied(response);
        });
    };
  }
  // Read the current deadlines without extending them (e.g. before warning staff).
  router.get("/session/expiry", safeRead(options), sessionDeadlineRoute(false));
  // Genuine staff activity (user action, or a visible operational screen).
  router.post("/session/activity", sameOriginMutation(options), sessionDeadlineRoute(true));

  // WP-2423 Q5: second-factor re-verification by the signed-in staff member (no code echoed).
  // WP-2423 Q5: the signed-in member's current verification (the recency refund approval uses).
  router.get("/identity/step-up", safeRead(options), (request, response) => {
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
    if (!options.mfaStepUp) {
      response.status(503).json({ error: "step_up_unavailable" });
      return;
    }
    const port = options.mfaStepUp;
    void retryTransactionConflict(() => port.status({ sessionCookie }))
      .then((result) =>
        response.set("Cache-Control", NO_STORE).json({ validUntil: result.validUntil }),
      )
      .catch((error: unknown) => refundReadFailure(response, error));
  });

  router.post("/identity/step-up", sameOriginMutation(options), (request, response) => {
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
    const command = options.mfaStepUp;
    if (!command) {
      response.status(503).json({ error: "step_up_unavailable" });
      return;
    }
    void command({ sessionCookie, csrf, command: request.body })
      .then((result) => {
        response.set("Cache-Control", NO_STORE);
        if (result.status === "Verified")
          response.json({
            status: "Verified",
            verifiedAt: result.verifiedAt,
            validUntil: result.validUntil,
          });
        else if (result.status === "Rejected")
          response.status(422).json({
            error: result.reason === "CodeReused" ? "code_already_used" : "code_rejected",
          });
        else
          response
            .status(429)
            .json({ error: "too_many_attempts", retryAfterSeconds: result.retryAfterSeconds });
      })
      .catch((error: unknown) => {
        if (error instanceof MerchantStepUpError && error.code === "NotSetUp") {
          response.status(503).set("Cache-Control", NO_STORE).json({ error: "step_up_not_set_up" });
          return;
        }
        denied(response);
      });
  });

  router.post("/store-context", sameOriginMutation(options), (request, response) => {
    let target: unknown;
    try {
      target = targetStoreReference(request.body);
    } catch {
      denied(response);
      return;
    }
    void options.service
      .switchStore({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
        targetStoreReference: target,
      })
      .then(async (result) => {
        response
          .set("Set-Cookie", serializeCookie(result.cookie))
          .json({ workspace: await currentTaxNavigation(result.workspace, result.cookie.value) });
      })
      .catch(() => denied(response));
  });

  router.post("/protected", sameOriginMutation(options), (request, response) => {
    void options.service
      .authorize({
        sessionCookie: cookie(request, "__Host-bop-merchant"),
        csrf: request.header("x-bop-csrf"),
      })
      .then(() => {
        response.json({ authorized: true });
      })
      .catch(() => denied(response));
  });

  router.post("/logout", sameOriginMutation(options), (request, response) => {
    void options.service
      .logout(cookie(request, "__Host-bop-merchant"))
      .then((mutation) => {
        response.set("Set-Cookie", serializeCookie(mutation)).status(204).end();
      })
      .catch(() => denied(response));
  });
}
