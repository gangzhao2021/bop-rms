import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import {
  createStoreReceiptProfileClient,
  StoreReceiptProfileClientError,
} from "./store-receipt-profile-client.js";
import { receiptPrivacyFieldErrors } from "./StoreReceiptPrivacyPanel.js";
import { ReceiptSetupNotice } from "./StoreTaxReviewPage.js";

const csrf = "A".repeat(43);
// TEST-ONLY numbers: shaped like CRA / Revenu Québec numbers, not real registrations.
const view = {
  observedAt: "2026-10-14T12:00:00.000Z",
  canChange: true,
  version: 1,
  recordedAt: "2026-10-14T11:00:00.000Z",
  details: {
    gstHstNumber: "000000000RT0001",
    qstNumber: null,
    pstNumber: null,
    privacyNoticeUrl: null,
  },
  gaps: { taxRegistrationMissing: false, privacyNoticeMissing: true },
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("WP-2423 Q15/Q16 receipt and privacy details client", () => {
  it("loads the details and sends only what the Owner typed with the version they saw", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(200, view))
      .mockResolvedValueOnce(
        json(200, {
          status: "Recorded",
          version: 2,
          recordedAt: view.observedAt,
          gaps: { taxRegistrationMissing: false, privacyNoticeMissing: false },
        }),
      );
    const client = createStoreReceiptProfileClient({ csrf, fetcher });
    expect((await client.load()).details.gstHstNumber).toBe("000000000RT0001");
    const body = {
      expectedVersion: 1,
      operationReference: "01902501-0000-7000-8000-000000000001",
      details: { ...view.details, privacyNoticeUrl: "https://example.test/privacy" },
    };
    expect(await client.save(body)).toEqual({
      version: 2,
      gaps: { taxRegistrationMissing: false, privacyNoticeMissing: false },
    });
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/merchant/store/receipt-profile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-BOP-CSRF"]).toBe(csrf);
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it.each([
    [403, {}, "PermissionDenied"],
    [409, { error: "profile_changed" }, "Conflict"],
    [409, { error: "no_change" }, "NoChange"],
    [422, { error: "invalid_details" }, "Invalid"],
    [503, {}, "Unavailable"],
    [500, {}, "OutcomeUnknown"],
  ])("maps %i %j to %s", async (status, body, code) => {
    const client = createStoreReceiptProfileClient({
      csrf,
      fetcher: vi.fn().mockResolvedValue(json(status, body)),
    });
    await expect(
      client.save({
        expectedVersion: 0,
        operationReference: "01902501-0000-7000-8000-000000000001",
        details: view.details,
      }),
    ).rejects.toEqual(new StoreReceiptProfileClientError(code as never));
  });

  it("shows field mistakes in the shapes the tax authorities publish", () => {
    const ok = {
      gstHstNumber: "000000000 RT 0001",
      qstNumber: "",
      pstNumber: "",
      privacyNoticeUrl: "https://example.test/privacy",
    };
    expect(receiptPrivacyFieldErrors(ok)).toEqual({});
    const errors = receiptPrivacyFieldErrors({
      gstHstNumber: "12345",
      qstNumber: "000000000RT0001",
      pstNumber: "<b>",
      privacyNoticeUrl: "http://example.test/privacy",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "gstHstNumber",
      "privacyNoticeUrl",
      "pstNumber",
      "qstNumber",
    ]);
  });

  it("warns staff what customer receipts and checkout still lack, and nothing when complete", () => {
    const render = (gaps: { taxRegistrationMissing: boolean; privacyNoticeMissing: boolean }) =>
      renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(ReceiptSetupNotice, { gaps, storeSetupHref: "/app/setup" }),
        ),
      );
    const both = render({ taxRegistrationMissing: true, privacyNoticeMissing: true });
    expect(both).toContain("Customer receipts show no GST/HST registration number");
    expect(both).toContain("Add your privacy notice link before going live");
    expect(both).toContain("Store setup → Receipts and privacy");
    expect(render({ taxRegistrationMissing: false, privacyNoticeMissing: false })).toBe("");
  });
});
