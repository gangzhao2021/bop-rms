import { describe, expect, it, vi } from "vitest";
import { roleEditorFixture, roleListFixture } from "./role-administration-pages.fixtures.js";
import {
  createRoleAdministrationPageClient,
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

describe("WP-2423 role command refusals", () => {
  it("tells a PIN sign-in refusal apart from a missing permission", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "full_sign_in_required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    const client = createRoleAdministrationPageClient("c".repeat(43), fetcher);
    const request = {
      operation: "Activate",
      roleReference: "01909974-0000-7000-8000-000000000001",
      expectedVersion: 1,
      operationReference: "01909974-0000-7000-8000-000000000002",
      reasonCode: "ROLE_ACTIVATED",
      draft: null,
    } as unknown as Parameters<typeof client.command>[0];
    await expect(client.command(request)).rejects.toMatchObject({ code: "FullSignInRequired" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "PermissionDenied" });
  });
});
