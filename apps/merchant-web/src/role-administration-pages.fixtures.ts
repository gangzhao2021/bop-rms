/** WP-2423 role presets: synthetic role page payloads (no real store, person or code shown). */
const catalog = [
  {
    action: "ordering.order.read",
    group: "Orders and bills",
    description: "View orders",
    highRisk: false,
    warning: null,
    riskRank: null,
  },
  {
    action: "payment.refund.approve",
    group: "Payments and refunds",
    description: "Approve a refund above the requester's limit",
    highRisk: true,
    warning: "Can approve refunds. Money leaves your business.",
    riskRank: 0,
  },
  {
    action: "ordering.order.comp",
    group: "Orders and bills",
    description: "Comp or discount dishes before the table pays",
    highRisk: true,
    warning: "Can take money off a bill (comp or discount). Each one is recorded under their name.",
    riskRank: 2,
  },
] as const;
const role = {
  roleReference: "018f2195-0000-7000-8000-000000000001",
  name: "Front of House",
  description: "Orders, tables and payments",
  scope: "Store",
  version: 5,
  kind: "Preset",
  locked: false,
  state: "InUse",
  memberCount: 3,
  waitingAssignments: 0,
  permissions: ["ordering.order.read"],
  change: {
    status: "InReview",
    name: "Front of House",
    description: "Orders, tables and payments",
    permissions: ["ordering.order.comp", "ordering.order.read", "payment.refund.approve"],
    added: ["payment.refund.approve", "ordering.order.comp"],
    removed: [],
    restore: false,
    rebased: false,
    by: "Ana",
    at: "2026-11-06T16:39:00.000Z",
    approvedAlone: false,
    approval: { mine: false, soleOperator: null, needsHolderOf: [] },
  },
  lastOutcome: null,
  operations: ["Approve", "Reject"],
  history: [{ decision: "Submitted", by: "Ana", at: "2026-11-06T16:39:00.000Z" }],
} as const;
export const roleListFixture = {
  screenId: "IAM-ROLE-LIST",
  sourceAsOf: "2026-11-06T17:00:00.000Z",
  freshness: "Fresh",
  completeness: "Complete",
  roles: [
    role,
    {
      ...role,
      roleReference: "018f2195-0000-7000-8000-000000000002",
      name: "Inventory Manager",
      state: "Removed",
      memberCount: 0,
      change: null,
      operations: ["Activate", "Duplicate"],
      history: [],
    },
  ],
  mayManage: true,
  catalog,
} as const;
export const roleEditorFixture = {
  ...roleListFixture,
  screenId: "IAM-ROLE-EDITOR",
  roles: [role],
} as const;
export const roleWaitingFixture = {
  screenId: "APPROVAL-INBOX",
  sourceAsOf: "2026-11-06T17:00:00.000Z",
  changes: [
    {
      roleReference: "018f2195-0000-7000-8000-000000000001",
      name: "Front of House",
      added: 2,
      removed: 1,
      by: "Ana",
      at: "2026-11-06T16:39:00.000Z",
      action: "Approve",
    },
  ],
} as const;
