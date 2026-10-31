import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import {
  createStaffPageClient,
  parseStaffInviteResult,
  parseStaffPageView,
  parseStaffResendResult,
  parseStaffRevokeResult,
} from "./staff-administration-pages.js";
import {
  INVITE_NAME_HELP,
  InvitationStatusLine,
  inviteReady,
  inviteSentText,
  membershipText,
} from "./StaffAdministrationPages.js";
import { StoreTimeZoneContext } from "./StoreTime.js";

const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const member = {
  actorReference: id(1),
  displayName: "Mia Chen",
  label: "Mia Chen",
  self: false,
  membershipStatus: "Active",
  storeAssignmentStatus: "Active",
  profileVersion: 1,
  assignments: [],
  pending: [],
  mayRequest: true,
  mayRename: true,
  mayRemove: true,
};
const viewer = { mayManage: true, mayApprove: true, brandMayManage: false, brandMayApprove: false };
const invitation = {
  status: "Pending",
  delivery: "Sent",
  emailHint: "m•••@example.com",
  sentAt: "2026-10-20T14:00:00.000Z",
  expiresAt: "2026-10-27T14:00:00.000Z",
  sendCount: 1,
  version: 3,
  mayResend: true,
  mayRevoke: true,
};
const view = (extra: { viewer?: object; staff?: object[]; roles?: object[] } = {}) => ({
  screenId: "IAM-USER-LIST",
  sourceAsOf: "2026-10-20T14:00:00.000Z",
  viewer: extra.viewer ?? viewer,
  roles: extra.roles ?? [],
  staff: extra.staff ?? [member],
});

describe("WP-2423 staff command refusals", () => {
  it("tells a PIN sign-in refusal apart from a missing permission", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "full_sign_in_required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "LastOwner" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: "AlreadyInvited" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: "EmailMismatch" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: "Invalid" }, { status: 400 }));
    const client = createStaffPageClient("c".repeat(43), fetcher);
    const request = {
      operation: "Approve",
      changeReference: "01909974-0000-7000-8000-000000000001",
    } as const;
    await expect(client.command(request)).rejects.toMatchObject({ code: "FullSignInRequired" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "LastOwner" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "AlreadyInvited" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "EmailMismatch" });
    await expect(client.command(request)).rejects.toMatchObject({ code: "Invalid" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/organization/staff/command");
  });
});

describe("WP-2423 DEC-COGNITO-STORE-STAFF staff invitations", () => {
  it("reads the view without invitation keys (older server) and with them", () => {
    const old = parseStaffPageView(view(), "IAM-USER-LIST");
    expect(old.viewer.mayInvite).toBe(false);
    expect(old.staff[0]?.invitation).toBeNull();
    const current = parseStaffPageView(
      view({
        viewer: { ...viewer, mayInvite: true },
        roles: [{ roleReference: id(9), code: "STORE_STAFF", name: "Staff", scope: "Store" }],
        staff: [
          { ...member, membershipStatus: "PendingActivation", invitation },
          { ...member, actorReference: id(2), invitation: null },
        ],
      }),
      "IAM-USER-LIST",
    );
    expect(current.viewer.mayInvite).toBe(true);
    expect(current.roles).toHaveLength(1);
    expect(current.staff[0]?.invitation).toEqual(invitation);
    expect(current.staff[0]?.membershipStatus).toBe("PendingActivation");
    expect(current.staff[1]?.invitation).toBeNull();
  });

  it("refuses unknown keys and values in the invitation", () => {
    for (const bad of [
      { ...invitation, email: "mia@example.com" },
      { ...invitation, status: "Sent" },
      { ...invitation, delivery: "Bounced" },
      { ...invitation, sendCount: -1 },
      { ...invitation, sentAt: "today" },
    ])
      expect(() =>
        parseStaffPageView(view({ staff: [{ ...member, invitation: bad }] }), "IAM-USER-LIST"),
      ).toThrow();
    expect(() =>
      parseStaffPageView(view({ viewer: { ...viewer, mayInvite: "yes" } }), "IAM-USER-LIST"),
    ).toThrow();
  });

  it("reads the command answers", () => {
    expect(
      parseStaffInviteResult({ status: "Invited", actorReference: id(3), delivery: "Sent" }),
    ).toEqual({ status: "Invited", actorReference: id(3), delivery: "Sent" });
    expect(() =>
      parseStaffInviteResult({ status: "Queued", actorReference: id(3), delivery: "Sent" }),
    ).toThrow();
    expect(
      parseStaffResendResult({ status: "Resent", delivery: "Unknown", emailNeeded: true }),
    ).toEqual({ status: "Resent", delivery: "Unknown", emailNeeded: true });
    expect(parseStaffRevokeResult({ status: "AlreadyApplied", accountRemoved: false })).toEqual({
      status: "AlreadyApplied",
      accountRemoved: false,
    });
  });

  it("needs a name, a work email and a role before inviting", () => {
    expect(inviteReady("", "mia@example.com", id(9))).toBe(false);
    expect(inviteReady("   ", "mia@example.com", id(9))).toBe(false);
    expect(inviteReady("Mia", "", id(9))).toBe(false);
    expect(inviteReady("Mia", "mia@example.com", "")).toBe(false);
    expect(inviteReady(" Mia ", "mia@example.com", id(9))).toBe(true);
    expect(INVITE_NAME_HELP).toBe("Required — orders, refunds and records show who did what.");
    expect(inviteSentText("Sent")).toBe(
      "Invitation sent. They'll get an email with a temporary password; it expires in 7 days.",
    );
    expect(inviteSentText("Unknown")).toBe(
      "The invitation was saved but we couldn't confirm the email went out. Use Resend on their page.",
    );
  });

  it("names membership and invitation states in plain words", () => {
    expect(membershipText("PendingActivation")).toBe("Invited (not signed in yet)");
    expect(membershipText("Active")).toBe("Active");
    expect(membershipText("Suspended")).toBe("Suspended");
    const line = (value: object | null) =>
      renderToStaticMarkup(
        <StoreTimeZoneContext.Provider value="America/Toronto">
          <InvitationStatusLine
            invitation={value === null ? null : parseInvitation({ ...invitation, ...value })}
          />
        </StoreTimeZoneContext.Provider>,
      );
    expect(staticText(line({}))).toMatch(
      /Invited · email sent\s+Oct 20.*· expires\s+Oct 27, 2026/su,
    );
    expect(staticText(line({ delivery: "Unknown" }))).toContain("Invited · email not confirmed");
    expect(staticText(line({ status: "Expired" }))).toContain("Invitation expired");
    expect(line({ status: "Accepted" })).toBe("");
    expect(line(null)).toBe("");
    expect(findInternalText([staticText(line({}))])).toEqual([]);
  });
});

function parseInvitation(value: object) {
  const parsed = parseStaffPageView(
    view({ staff: [{ ...member, invitation: value }] }),
    "IAM-USER-LIST",
  ).staff[0]?.invitation;
  if (!parsed) throw new Error("no invitation");
  return parsed;
}

describe("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 8: people from the Brand's other Stores", () => {
  it("reads them by name (none from an older server) and refuses anything else", () => {
    expect(parseStaffPageView(view(), "IAM-USER-LIST").otherStoresStaff).toEqual([]);
    const withOthers = { ...view(), otherStoresStaff: [{ actorReference: id(77), label: "Kai" }] };
    expect(parseStaffPageView(withOthers, "IAM-USER-LIST").otherStoresStaff).toEqual([
      { actorReference: id(77), label: "Kai" },
    ]);
    expect(() =>
      parseStaffPageView(
        { ...view(), otherStoresStaff: [{ actorReference: id(77), label: "Kai", email: "x" }] },
        "IAM-USER-LIST",
      ),
    ).toThrow();
  });
});
