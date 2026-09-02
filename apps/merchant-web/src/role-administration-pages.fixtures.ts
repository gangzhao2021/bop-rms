const role = {
  roleReference: "018f2195-0000-7000-8000-000000000001",
  code: "access_admin",
  name: "Access administrator",
  description: "Synthetic role used only for contract verification",
  scope: "Brand",
  status: "InReview",
  type: "Custom",
  version: 3,
  memberCount: 2,
  permissions: [
    {
      action: "identity.role.view",
      group: "Role administration",
      highRisk: false,
      dependencies: [],
    },
    {
      action: "identity.role.activate",
      group: "Role administration",
      highRisk: true,
      dependencies: ["identity.role.approve"],
    },
  ],
  submittedBy: "Synthetic submitter",
  approvedBy: null,
  history: ["Draft saved", "Submitted for independent approval"],
} as const;
export const roleListFixture = {
  screenId: "IAM-ROLE-LIST",
  sourceAsOf: "2026-08-15T15:00:00.000Z",
  freshness: "Fresh",
  completeness: "Complete",
  roles: [role],
  mayManage: true,
} as const;
export const roleEditorFixture = { ...roleListFixture, screenId: "IAM-ROLE-EDITOR" } as const;
