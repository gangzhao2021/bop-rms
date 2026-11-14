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
  retiredByBop: 0,
  presetUpdate: null,
  change: {
    status: "InReview",
    name: "Front of House",
    description: "Orders, tables and payments",
    permissions: ["ordering.order.comp", "ordering.order.read", "payment.refund.approve"],
    added: ["payment.refund.approve", "ordering.order.comp"],
    removed: [],
    restore: false,
    rebased: false,
    droppedByBop: 0,
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
/** WP-2423 store-type starter roles: what each kind of shop would start from (synthetic). */
const starter = (
  key: string,
  name: string,
  description: string,
  state = "ToAdd",
  roleReference: string | null = null,
) => ({
  key,
  name,
  description,
  permissions: ["merchant.access", "ordering.order.read"],
  state,
  roleReference,
});
const counter = starter(
  "counter",
  "Counter",
  "Takes orders and payment at the counter, hands over pickups, seats pay-first tables and marks items sold out",
);
const fohPreset = {
  roleReference: "018f2195-0000-7000-8000-000000000001",
  name: "Front of House",
  held: true,
  memberCount: 3,
};
const kitchenPreset = {
  roleReference: "018f2195-0000-7000-8000-000000000003",
  name: "Kitchen",
  held: false,
  memberCount: 0,
};
const manager = { roleReference: "018f2195-0000-7000-8000-000000000004", name: "Store Manager" };
export const starterSetsFixture = {
  screenId: "IAM-ROLE-LIST",
  sourceAsOf: "2026-11-06T17:00:00.000Z",
  mayApply: true,
  mayPutAway: true,
  started: false,
  sets: [
    {
      storeType: "TeaShop",
      roles: [
        counter,
        starter(
          "drink_maker",
          "Drink maker",
          "Makes drinks from the order screen, remakes a wrong one, marks items sold out and hands orders over",
        ),
      ],
      keep: [manager],
      putAway: [fohPreset, kitchenPreset],
    },
    {
      storeType: "DessertShop",
      roles: [
        counter,
        starter(
          "dessert_maker",
          "Dessert maker",
          "Makes desserts from the order screen, remakes a wrong one, marks items sold out and hands orders over",
        ),
      ],
      keep: [manager],
      putAway: [fohPreset, kitchenPreset],
    },
    {
      storeType: "Hotpot",
      roles: [
        starter(
          "floor",
          "Floor",
          "Seats guests, takes table orders, accepts guests' rounds, serves dishes and answers table calls",
        ),
        starter(
          "runner",
          "Runner",
          "Brings dishes from the kitchen to the tables and marks them served",
          "NameTaken",
        ),
        starter(
          "cashier",
          "Cashier",
          "Starts table checkout, takes card and cash, closes paid tables, takes takeout orders and hands them over, and records refund requests",
        ),
      ],
      keep: [manager, { roleReference: kitchenPreset.roleReference, name: "Kitchen" }],
      putAway: [fohPreset],
    },
    {
      storeType: "FullService",
      roles: [
        starter(
          "runner",
          "Runner",
          "Brings dishes from the kitchen to the tables and marks them served",
          "NameTaken",
        ),
        starter(
          "cashier",
          "Cashier",
          "Starts table checkout, takes card and cash, closes paid tables, takes takeout orders and hands them over, and records refund requests",
        ),
      ],
      keep: [manager, { roleReference: fohPreset.roleReference, name: "Front of House" }],
      putAway: [],
    },
    { storeType: "CounterOnly", roles: [counter], keep: [manager], putAway: [fohPreset] },
  ],
} as const;
/** The same Store once the tea shop set was sent: Counter and Drink maker wait on its sole owner. */
const waitingStarter = (roleReference: string, name: string) => ({
  ...role,
  roleReference,
  name,
  description: name,
  kind: "Custom",
  state: "NotOn",
  memberCount: 0,
  permissions: [],
  change: {
    ...role.change,
    name,
    description: name,
    permissions: ["ordering.order.read"],
    added: ["ordering.order.read"],
    by: "You",
    approval: {
      mine: true,
      soleOperator: { status: "Effective", otherApprovers: [], verifiedUntil: null },
      needsHolderOf: [],
    },
  },
  operations: ["Withdraw", "ApproveAlone"],
  history: [],
});
export const starterTeaReference = "018f2195-0000-7000-8000-000000000010",
  starterMakerReference = "018f2195-0000-7000-8000-000000000011";
export const starterStartedRolesFixture = {
  ...roleListFixture,
  roles: [
    ...roleListFixture.roles,
    waitingStarter(starterTeaReference, "Counter"),
    waitingStarter(starterMakerReference, "Drink maker"),
  ],
} as const;
export const starterStartedSetsFixture = {
  ...starterSetsFixture,
  started: true,
  sets: starterSetsFixture.sets.map((set) =>
    set.storeType !== "TeaShop"
      ? set
      : {
          ...set,
          roles: [
            { ...set.roles[0], state: "Added", roleReference: starterTeaReference },
            { ...set.roles[1], state: "Added", roleReference: starterMakerReference },
          ],
          putAway: [fohPreset],
        },
  ),
};
