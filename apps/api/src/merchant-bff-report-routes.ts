/** Merchant BFF routes: settlement and store reports. Registered by createMerchantBffRouter (merchant-bff.ts). */
import { cookie, denied, NO_STORE, rawHeaderValues, safeRead } from "./merchant-bff-http.js";
import express, { type Router } from "express";
import {
  type StoreSalesReportExportKind,
  storeSalesReportExportKinds,
} from "./store-sales-report.js";
import type { MerchantBffRouterOptions } from "./merchant-bff-contract.js";

export function installMerchantReportRoutes(
  router: Router,
  options: MerchantBffRouterOptions,
): void {
  router.get("/settlement", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const businessDate = request.query.businessDate;
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      sessionCookie === null ||
      Object.keys(request.query).some((key) => key !== "businessDate") ||
      (businessDate !== undefined &&
        (typeof businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate))) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    ) {
      denied(response);
      return;
    }
    if (!options.settlement) {
      response.status(503).json({ error: "settlement_unavailable" });
      return;
    }
    void options
      .settlement({ sessionCookie, businessDate: businessDate === undefined ? null : businessDate })
      .then((view) => response.json(view))
      .catch((error: unknown) => {
        // WP-2423 Q7 (v15): records busy with live work is a retry-later, not a refusal.
        if ((error as { code?: unknown } | null)?.code === "MERCHANT_SETTLEMENT_BUSY") {
          response
            .status(503)
            .set("Cache-Control", NO_STORE)
            .set("Retry-After", "5")
            .json({ error: "settlement_busy" });
          return;
        }
        // WP-2423: a day before the Store's records begin is an answer, not a refusal.
        const notCovered = error as { code?: unknown; firstBusinessDate?: unknown } | null;
        if (
          notCovered?.code === "MERCHANT_SETTLEMENT_NOT_COVERED" &&
          typeof notCovered.firstBusinessDate === "string" &&
          /^\d{4}-\d{2}-\d{2}$/u.test(notCovered.firstBusinessDate)
        ) {
          response.status(404).set("Cache-Control", NO_STORE).json({
            error: "settlement_not_covered",
            firstBusinessDate: notCovered.firstBusinessDate,
          });
          return;
        }
        denied(response);
      });
  });

  // WP-2423 Q14: the Store's reports for a range of business days, and one report as CSV.
  const reportRange = (request: express.Request, extra: readonly string[]) => {
    const { from, to } = request.query;
    const date = (value: unknown) =>
      value === undefined || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value));
    if (
      request.method !== "GET" ||
      request.body !== undefined ||
      Object.keys(request.query).some((key) => !["from", "to", ...extra].includes(key)) ||
      !date(from) ||
      !date(to) ||
      rawHeaderValues(request, "origin").length > 1 ||
      rawHeaderValues(request, "sec-fetch-site").length !== 1
    )
      return null;
    return {
      from: typeof from === "string" ? from : null,
      to: typeof to === "string" ? to : null,
    };
  };
  const reportFailure = (response: express.Response) => (error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === "MERCHANT_STORE_REPORTS_BUSY") {
      response
        .status(503)
        .set("Cache-Control", NO_STORE)
        .set("Retry-After", "5")
        .json({ error: "reports_busy" });
      return;
    }
    denied(response);
  };
  router.get("/reports", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const range = reportRange(request, []);
    if (sessionCookie === null || range === null) {
      denied(response);
      return;
    }
    if (!options.storeReports) {
      response.status(503).set("Cache-Control", NO_STORE).json({ error: "reports_unavailable" });
      return;
    }
    void options.storeReports
      .read({ sessionCookie, ...range })
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch(reportFailure(response));
  });
  // WP-2423 item 8 ② (Figma 47-2): the closing summary — today so far, with the open tables.
  router.get("/reports/tonight", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    if (sessionCookie === null || Object.keys(request.query).length > 0) {
      denied(response);
      return;
    }
    if (!options.storeReports) {
      response.status(503).set("Cache-Control", NO_STORE).json({ error: "reports_unavailable" });
      return;
    }
    void options.storeReports
      .tonight({ sessionCookie })
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch(reportFailure(response));
  });
  // DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 7: another Store's closing summary for the
  // Brand page, for a person allowed at that Store (checked there; no switch).
  router.get("/reports/stores/:storeReference/tonight", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const storeReference = request.params.storeReference;
    if (
      sessionCookie === null ||
      Object.keys(request.query).length > 0 ||
      typeof storeReference !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(storeReference)
    ) {
      denied(response);
      return;
    }
    if (!options.storeReports) {
      response.status(503).set("Cache-Control", NO_STORE).json({ error: "reports_unavailable" });
      return;
    }
    void options.storeReports
      .storeTonight({ sessionCookie, storeReference })
      .then((view) => response.set("Cache-Control", NO_STORE).json(view))
      .catch(reportFailure(response));
  });
  router.get("/reports/export", safeRead(options), (request, response) => {
    const sessionCookie = cookie(request, "__Host-bop-merchant");
    const range = reportRange(request, ["report"]);
    const report = request.query.report;
    if (
      sessionCookie === null ||
      range === null ||
      typeof report !== "string" ||
      !(storeSalesReportExportKinds as readonly string[]).includes(report)
    ) {
      denied(response);
      return;
    }
    if (!options.storeReports) {
      response.status(503).set("Cache-Control", NO_STORE).json({ error: "reports_unavailable" });
      return;
    }
    void options.storeReports
      .export({ sessionCookie, ...range, report: report as StoreSalesReportExportKind })
      .then((file) =>
        response
          .status(200)
          .set("Cache-Control", NO_STORE)
          .set("Content-Type", "text/csv; charset=utf-8")
          .set("Content-Disposition", `attachment; filename="${file.fileName}"`)
          .set("X-Content-Type-Options", "nosniff")
          .send(file.body),
      )
      .catch(reportFailure(response));
  });
}
