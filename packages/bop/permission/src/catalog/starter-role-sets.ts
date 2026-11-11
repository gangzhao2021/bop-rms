import { storePermissionCodes } from "./store-permission-catalog.js";

/**
 * WP-2423 store-type starter roles (Owner 2026-11-06 "预设一些角色与权限，另外允许店家自定义；店家也可以
 * 对预设进行增删改", DEC-STORE-TYPE-STARTER-ROLES): what a kind of shop starts its roles from.
 *
 * A starter role is not a BOP preset. Applying a set creates the Store's own roles (Custom, through
 * the same approval as any new role), so the owner adds, removes and edits them like any other and
 * a later BOP change never writes over them. They are built only from the permission catalog, so
 * no catalog revision or Store role upgrade is involved. Each role has one fixed internal code, so
 * a Store holds a starter role at most once whichever sets it starts from.
 */
export const starterStoreTypes = [
  "TeaShop",
  "DessertShop",
  "Hotpot",
  "FullService",
  "CounterOnly",
] as const;
export type StarterStoreType = (typeof starterStoreTypes)[number];
export const starterRoleKeys = [
  "counter",
  "drink_maker",
  "dessert_maker",
  "floor",
  "runner",
  "cashier",
] as const;
export type StarterRoleKey = (typeof starterRoleKeys)[number];
export interface StarterRoleDefinition {
  readonly key: StarterRoleKey;
  /** Internal code (database grammar); never shown. */
  readonly roleCode: string;
  /** English source text; staff read it in their language. */
  readonly displayName: string;
  readonly description: string;
  /** Catalog codes only; legacy equivalents are added when the role is built. */
  readonly actions: readonly string[];
}
export interface StarterRoleSetDefinition {
  readonly storeType: StarterStoreType;
  /** The kind of shop, in the owner's words. */
  readonly label: string;
  readonly add: readonly StarterRoleKey[];
  /** Presets (role codes) this kind of shop keeps working with. */
  readonly keep: readonly string[];
  /**
   * Presets this kind of shop does not use: put away (removed, can be brought back) when the owner
   * says so and nobody holds them. The Owner preset and Area Manager are never touched.
   */
  readonly putAway: readonly string[];
}

const tasks = ["task.read", "task.claim", "task.complete"] as const;
/**
 * Tables page and table checkout check `dining.operate`, which a role holds through these two (a
 * runner or cashier needs the Tables page to serve or settle a table).
 */
const tablesPage = ["dining.table.read", "dining.session.manage"] as const;
const maker = [
  "merchant.access",
  "kitchen.work_item.read",
  "kitchen.work_item.accept",
  "kitchen.work_item.start",
  "kitchen.work_item.complete",
  // Remake a drink or dessert made wrong; the first one is recorded as waste.
  "kitchen.work_item.rework",
  "kitchen.exception.manage",
  // Tapioca, a topping or a fruit ran out: off for the rest of today.
  "catalog.sku.sold_out.mark",
  "inventory.waste.record",
  // Makers call the number and hand the order over at most tea and dessert counters.
  "fulfillment.pickup.read",
  "fulfillment.pickup.complete",
] as const;

const roles: Readonly<Record<StarterRoleKey, StarterRoleDefinition>> = Object.freeze({
  counter: {
    key: "counter",
    roleCode: "starter_counter",
    displayName: "Counter",
    description:
      "Takes orders and payment at the counter, hands over pickups, seats pay-first tables and marks items sold out",
    // What Front of House does, at a counter: the same permissions under the shop's own word.
    actions: [
      "merchant.access",
      "ordering.order.read",
      "ordering.order.accept",
      "ordering.order.create_staff",
      "ordering.order.close",
      "fulfillment.pickup.read",
      "fulfillment.pickup.complete",
      ...tablesPage,
      "dining.item.serve",
      "dining.session.close",
      "inventory.waste.record",
      "catalog.sku.sold_out.mark",
      "operations.ordering.pause",
      "payment.refund.request",
      ...tasks,
    ],
  },
  drink_maker: {
    key: "drink_maker",
    roleCode: "starter_drink_maker",
    displayName: "Drink maker",
    description:
      "Makes drinks from the order screen, remakes a wrong one, marks items sold out and hands orders over",
    actions: maker,
  },
  dessert_maker: {
    key: "dessert_maker",
    roleCode: "starter_dessert_maker",
    displayName: "Dessert maker",
    description:
      "Makes desserts from the order screen, remakes a wrong one, marks items sold out and hands orders over",
    actions: maker,
  },
  floor: {
    key: "floor",
    roleCode: "starter_floor",
    displayName: "Floor",
    description:
      "Seats guests, takes table orders, accepts guests' rounds, serves dishes and answers table calls",
    actions: [
      "merchant.access",
      "ordering.order.read",
      "ordering.order.accept",
      "ordering.order.create_staff",
      ...tablesPage,
      "dining.item.serve",
      "catalog.sku.sold_out.mark",
      "inventory.waste.record",
      ...tasks,
    ],
  },
  runner: {
    key: "runner",
    roleCode: "starter_runner",
    displayName: "Runner",
    description: "Brings dishes from the kitchen to the tables and marks them served",
    actions: ["merchant.access", "ordering.order.read", ...tablesPage, "dining.item.serve", ...tasks],
  },
  cashier: {
    key: "cashier",
    roleCode: "starter_cashier",
    displayName: "Cashier",
    description:
      "Starts table checkout, takes card and cash, closes paid tables, takes takeout orders and hands them over, and records refund requests",
    actions: [
      "merchant.access",
      "ordering.order.read",
      "ordering.order.accept",
      "ordering.order.create_staff",
      "ordering.order.close",
      ...tablesPage,
      "dining.item.serve",
      "dining.session.close",
      "fulfillment.pickup.read",
      "fulfillment.pickup.complete",
      "operations.ordering.pause",
      "payment.refund.request",
      ...tasks,
    ],
  },
});

const sets: Readonly<Record<StarterStoreType, StarterRoleSetDefinition>> = Object.freeze({
  TeaShop: {
    storeType: "TeaShop",
    label: "Bubble tea or tea shop",
    add: ["counter", "drink_maker"],
    keep: ["store_manager"],
    putAway: ["front_of_house", "kitchen", "inventory_manager"],
  },
  DessertShop: {
    storeType: "DessertShop",
    label: "Dessert shop",
    add: ["counter", "dessert_maker"],
    keep: ["store_manager"],
    putAway: ["front_of_house", "kitchen", "inventory_manager"],
  },
  Hotpot: {
    storeType: "Hotpot",
    label: "Hotpot restaurant",
    add: ["floor", "runner", "cashier"],
    keep: ["store_manager", "kitchen", "inventory_manager"],
    putAway: ["front_of_house"],
  },
  FullService: {
    storeType: "FullService",
    label: "Full-service Chinese restaurant",
    add: ["runner", "cashier"],
    // Front of House is the server: seats, takes orders, serves and starts checkout.
    keep: ["store_manager", "front_of_house", "kitchen", "inventory_manager"],
    putAway: [],
  },
  CounterOnly: {
    storeType: "CounterOnly",
    label: "Counter service only, no table service",
    add: ["counter"],
    keep: ["store_manager", "kitchen"],
    putAway: ["front_of_house", "inventory_manager"],
  },
});

for (const role of Object.values(roles))
  for (const action of role.actions)
    if (!storePermissionCodes.has(action))
      throw new Error("STARTER_ROLE_PERMISSION_NOT_IN_CATALOG");

export function starterRole(key: StarterRoleKey): StarterRoleDefinition {
  return roles[key];
}
export function starterRoleSet(storeType: StarterStoreType): StarterRoleSetDefinition {
  return sets[storeType];
}
/** The starter role a role code belongs to, or null when it is not one. */
export function starterRoleOfCode(roleCode: string): StarterRoleDefinition | null {
  return Object.values(roles).find((role) => role.roleCode === roleCode) ?? null;
}
