import { describe, expect, it, vi } from "vitest";
import {
  roleEditorFixture,
  roleListFixture,
  roleWaitingFixture,
} from "./role-administration-pages.fixtures.js";
import {
  createRoleAdministrationPageClient,
  parseRoleAdministrationPageView,
  parseRoleAdministrationRouteReference,
  parseRoleChangesWaiting,
} from "./role-administration-pages.js";
describe("WP-2423 role page contracts", () => {
  it("keeps what staff hold apart from the change waiting", () => {
    const role = parseRoleAdministrationPageView(roleEditorFixture, "IAM-ROLE-EDITOR").roles[0];
    expect(role).toMatchObject({ memberCount: 3, kind: "Preset", state: "InUse" });
    expect(role?.permissions).toEqual(["ordering.order.read"]);
    expect(role?.change?.added).toEqual(["payment.refund.approve", "ordering.order.comp"]);
    expect(parseRoleChangesWaiting(roleWaitingFixture)[0]?.action).toBe("Approve");
  });
  it("rejects malformed routes and open payloads", () => {
    expect(() => parseRoleAdministrationRouteReference("front_of_house")).toThrow(
      "ROLE_ADMIN_PAGE_INVALID",
    );
    expect(() =>
      parseRoleAdministrationPageView({ ...roleListFixture, extra: true }, "IAM-ROLE-LIST"),
    ).toThrow("ROLE_ADMIN_PAGE_INVALID");
    expect(() =>
      parseRoleAdministrationPageView(
        { ...roleEditorFixture, roles: [{ ...roleEditorFixture.roles[0], kind: "System" }] },
        "IAM-ROLE-EDITOR",
      ),
    ).toThrow("ROLE_ADMIN_PAGE_INVALID");
  });
});

describe("WP-2423 role command refusals", () => {
  it("tells a PIN sign-in refusal apart from a missing permission, and names a taken name", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "full_sign_in_required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "NameTaken" }, { status: 409 }));
    const client = createRoleAdministrationPageClient("c".repeat(43), fetcher);
    const request = {
      operation: "Activate",
      roleReference: "01909974-0000-7000-8000-000000000001",
      expectedVersion: 1,
      operationReference: "01909974-0000-7000-8000-000000000002",
      reasonCode: "ROLE_ACTIVATED",
      draft: null,
    } as const;
    await expect(client.command(request)).rejects.toMatchObject({ code: "FullSignInRequired" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "NameTaken" });
  });
});
