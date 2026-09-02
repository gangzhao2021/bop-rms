import { describe, expect, it } from "vitest";
import { exportJobPageFixture } from "./export-job-pages.fixtures.js";
import { parseExportJobPageView } from "./export-job-pages.js";
describe("WP-2196 Export Job screen contract", () => {
  it("retains classification, expiry and one-time grant state", () => {
    expect(parseExportJobPageView(exportJobPageFixture).jobs[0]).toMatchObject({
      classification: "Internal",
      rowCount: 42,
      grantState: "Ready",
      mayDownload: true,
    });
  });
  it("rejects open payloads and download actions on consumed grants", () => {
    expect(() => parseExportJobPageView({ ...exportJobPageFixture, extra: true })).toThrow(
      "EXPORT_JOB_PAGE_INVALID",
    );
    expect(() =>
      parseExportJobPageView({
        ...exportJobPageFixture,
        jobs: [{ ...exportJobPageFixture.jobs[0], grantState: "Consumed" }],
      }),
    ).toThrow("EXPORT_JOB_PAGE_INVALID");
  });
});
