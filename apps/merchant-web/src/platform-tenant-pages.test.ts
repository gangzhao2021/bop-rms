import { describe, expect, it } from "vitest";
import {
  platformTenantDetailFixture,
  platformTenantListFixture,
} from "./platform-tenant-pages.fixtures.js";
import {
  parsePlatformTenantDetailView,
  parsePlatformTenantListView,
} from "./platform-tenant-pages.js";
describe("WP-2197 Platform Tenant screen contract", () => {
  it("parses exact list and detail state", () => {
    expect(parsePlatformTenantListView(platformTenantListFixture).tenants[0]?.region).toBe("CA-ON");
    expect(
      parsePlatformTenantDetailView(
        platformTenantDetailFixture,
        platformTenantDetailFixture.tenant.tenantReference,
      ).capabilities,
    ).toHaveLength(3);
  });
  it("rejects unscoped, surplus and route-conflicting data", () => {
    expect(() =>
      parsePlatformTenantListView({
        ...platformTenantListFixture,
        access: { ...platformTenantListFixture.access, supportCaseReference: null },
      }),
    ).toThrow("PLATFORM_TENANT_PAGE_INVALID");
    expect(() =>
      parsePlatformTenantListView({ ...platformTenantListFixture, secret: "leak" }),
    ).toThrow("PLATFORM_TENANT_PAGE_INVALID");
    expect(() =>
      parsePlatformTenantDetailView(
        platformTenantDetailFixture,
        "018f9816-0000-7000-8000-000000000099",
      ),
    ).toThrow("PLATFORM_TENANT_PAGE_INVALID");
  });
});
