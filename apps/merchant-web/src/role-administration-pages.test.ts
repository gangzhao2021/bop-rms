import { describe, expect, it } from "vitest";
import { roleEditorFixture, roleListFixture } from "./role-administration-pages.fixtures.js";
import {
  parseRoleAdministrationPageView,
  parseRoleAdministrationRouteReference,
} from "./role-administration-pages.js";
describe("WP-2195 IAM Role screen contracts", () => {
  it("retains high-risk, dependency and assignment impact metadata", () => {
    const role = parseRoleAdministrationPageView(roleEditorFixture, "IAM-ROLE-EDITOR").roles[0];
    expect(role).toMatchObject({
      memberCount: 2,
      status: "InReview",
      submittedBy: "Synthetic submitter",
      approvedBy: null,
    });
    expect(role?.permissions[1]).toMatchObject({
      highRisk: true,
      dependencies: ["identity.role.approve"],
    });
  });
  it("rejects malformed routes, open payloads and self approval", () => {
    expect(() => parseRoleAdministrationRouteReference("access_admin")).toThrow(
      "ROLE_ADMIN_PAGE_INVALID",
    );
    expect(() =>
      parseRoleAdministrationPageView({ ...roleListFixture, extra: true }, "IAM-ROLE-LIST"),
    ).toThrow("ROLE_ADMIN_PAGE_INVALID");
    const selfApproved = {
      ...roleEditorFixture,
      roles: [{ ...roleEditorFixture.roles[0], approvedBy: "Synthetic submitter" }],
    };
    expect(() => parseRoleAdministrationPageView(selfApproved, "IAM-ROLE-EDITOR")).toThrow(
      "ROLE_ADMIN_PAGE_INVALID",
    );
  });
});
