import type { Router } from "express";
import { cookie, denied, exactHeader, sameOriginMutation } from "./merchant-bff-http.js";
import { MerchantComboPartError } from "./merchant-combo-part-commands.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

/**
 * WP-2423 item 8 ⑥ part 4: one dish of a combo done in the kitchen, or served at its table. Errors
 * carry a code only.
 */
export function installMerchantComboPartRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  const status = {
    PermissionDenied: 403,
    NotFound: 404,
    Invalid: 400,
    NotReady: 409,
    Conflict: 409,
  };
  for (const [path, action] of [
    ["/kitchen/combo-part-done", "kitchenDone"],
    ["/dining/combo-part-served", "tableServed"],
  ] as const)
    router.post(path, sameOriginMutation(options), (request, response) => {
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
      if (!options.comboParts) {
        response.status(503).json({ error: "combo_parts_unavailable" });
        return;
      }
      void options.comboParts[action]({ sessionCookie, csrf, body: request.body })
        .then((result) => response.json(result))
        .catch((error: unknown) => {
          if (!(error instanceof MerchantComboPartError)) {
            denied(response);
            return;
          }
          response.status(status[error.code]).json({ error: error.code });
        });
    });
}
