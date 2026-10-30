/**
 * WP-2423 (v15 2026-10-16): the merchant BFF must not drop a read-model field the browser parses.
 *
 * Orders and Home never showed how long a paid dine-in round waited because the BFF copied each
 * Order field by hand and left `awaitingAcceptanceSince` out, while the browser specs mocked the
 * BFF response and the BFF tests cast their read-model stubs (`as never`). This contract runs the
 * real BFF routes over read-model values typed as the read model's full output (every optional
 * field required, so a new read-model field fails the typecheck until it is added here) and
 * parses each response with the real browser client. The response objects are wrapped in a
 * recorder: every key the client asks for that the response does not have is recorded, and the
 * test fails when such a key exists at the same place in the read-model output — a field the
 * client parses that the BFF dropped. Fields the client never asks for (internal facts the BFF
 * deliberately withholds) are not affected.
 */
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRawBrowserCredential } from "../../../packages/bop/identity/src/index.js";
import { createApp } from "../../../apps/api/src/app.js";
import type {
  MerchantBffRouterOptions,
  MerchantBffService,
} from "../../../apps/api/src/merchant-bff.js";
import { createCurrentOrderQueueClient } from "../../../apps/merchant-web/src/current-order-queue-client.js";
import { createKitchenBoardClient } from "../../../apps/merchant-web/src/kitchen-board-client.js";
import { parseKitchenBoardView } from "../../../apps/merchant-web/src/kitchen-board.js";
import { parsePickupQueueView } from "../../../apps/merchant-web/src/pickup.js";
import { createDiningSessionClient } from "../../../apps/merchant-web/src/dining-session-client.js";
import { createSettlementClient } from "../../../apps/merchant-web/src/settlement-client.js";
import { createPickupClient } from "../../../apps/merchant-web/src/pickup-client.js";
import { createStaffPinClient } from "../../../apps/merchant-web/src/staff-pin-client.js";
import type { createMerchantStaffPin } from "../../../apps/api/src/merchant-staff-pin.js";

/** The read model's output with every optional field present (nullable fields stay nullable). */
type Full<T> = T extends string
  ? `${T}` extends T
    ? T
    : string // a branded string is written as its JSON value
  : T extends number | boolean | bigint | null | undefined
    ? T
    : T extends readonly (infer U)[]
      ? readonly Full<U>[]
      : { [K in keyof T]-?: Full<Exclude<T[K], undefined>> };
type Output<K extends keyof MerchantBffRouterOptions> = Full<
  NonNullable<MerchantBffRouterOptions[K]> extends (...args: never) => infer R ? Awaited<R> : never
>;

const id = (value: number) => `0198a408-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 15, minute)).toISOString();
const storeReference = id(1);
const sessionCookie = parseRawBrowserCredential(Buffer.alloc(32, 2).toString("base64url"));
const csrf = parseRawBrowserCredential(Buffer.alloc(32, 3).toString("base64url"));
const origin = "https://merchant.invalid";
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });

// ---------------------------------------------------------------------------------------------
// Recorder: the key paths a client asked for that the response did not have.
// ---------------------------------------------------------------------------------------------
const asked = new Set<string>();
const inherited = (key: string) => key in Object.prototype || key in Array.prototype;
function record(value: unknown, path: string): unknown {
  if (value === null || typeof value !== "object") return value;
  const array = Array.isArray(value);
  const target: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const [key, child] of Object.entries(value))
    (target as Record<string, unknown>)[key] = record(
      child,
      array ? `${path}[]` : `${path}.${key}`,
    );
  const note = (key: string | symbol) => {
    if (typeof key !== "string" || Object.hasOwn(target, key) || inherited(key)) return;
    asked.add(`${path}.${key}`);
  };
  return new Proxy(target, {
    get(t, key, receiver) {
      note(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      note(key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      note(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  });
}
/** Every key path of a read-model value (array elements as `[]`). */
function paths(value: unknown, path = "", into = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const child of value) paths(child, `${path}[]`, into);
    return into;
  }
  for (const [key, child] of Object.entries(value)) {
    into.add(`${path}.${key}`);
    paths(child, `${path}.${key}`, into);
  }
  return into;
}
/** The read-model fields a client asked for that the BFF response did not carry. */
function dropped(model: unknown, toModelPath: (responsePath: string) => string = (p) => p) {
  const known = paths(model);
  return [...new Set([...asked].map(toModelPath))].filter((path) => known.has(path));
}

// ---------------------------------------------------------------------------------------------
// The real BFF router, served over HTTP; clients reach it through a recording fetch.
// ---------------------------------------------------------------------------------------------
const reads: Partial<Record<keyof MerchantBffRouterOptions, ReturnType<typeof vi.fn>>> = {};
const stub = (key: keyof MerchantBffRouterOptions) => {
  const mock = reads[key];
  if (mock === undefined) throw new Error("read model stub missing");
  return mock;
};
type StaffPinPort = ReturnType<typeof createMerchantStaffPin>;
const tabletRecheck = vi.fn<StaffPinPort["refundRecheck"]>();
const deviceCookie = Buffer.alloc(32, 4).toString("base64url");
let root = "";
let server: import("node:http").Server;
beforeAll(async () => {
  const read = <K extends keyof MerchantBffRouterOptions>(key: K) => {
    const mock = vi.fn();
    reads[key] = mock;
    return mock as unknown as NonNullable<MerchantBffRouterOptions[K]>;
  };
  // The real API application with the real merchant BFF router; only the read models are stubs.
  server = createServer(
    createApp({
      merchantBff: {
        service: {} as MerchantBffService,
        exactOrigin: origin,
        acceptedHost: "merchant.invalid",
        orderQueue: read("orderQueue"),
        kitchenQuery: read("kitchenQuery"),
        diningTables: read("diningTables"),
        settlement: read("settlement"),
        pickupQuery: read("pickupQuery"),
        // v15 cbff9d6f: the tablet re-check is the staff PIN port's (the rest is never called).
        staffPin: { refundRecheck: tabletRecheck } as unknown as StaffPinPort,
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const parsedTexts = new Map<string, unknown>();
const originalParse = JSON.parse;
const fetcher = (async (path: string, init: RequestInit = {}) => {
  const headers: Record<string, string> = {
    Host: "merchant.invalid",
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    Cookie: `__Host-bop-merchant=${sessionCookie}; __Host-bop-store-device=${deviceCookie}`,
  };
  for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>))
    headers[key] = value;
  const { status, contentType, cacheControl, body } = await new Promise<{
    status: number;
    contentType: string;
    cacheControl: string;
    body: string;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(path, root),
      { method: init.method ?? "GET", headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            contentType: String(incoming.headers["content-type"] ?? ""),
            cacheControl: String(incoming.headers["cache-control"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(typeof init.body === "string" ? init.body : undefined);
  });
  const recorded = status === 200 ? record(originalParse(body), "") : undefined;
  if (recorded !== undefined) parsedTexts.set(body, recorded);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "content-type": contentType, "cache-control": cacheControl }),
    json: async () => recorded ?? originalParse(body),
    text: async () => body,
  } as unknown as Response;
}) as unknown as typeof fetch;

async function throughClient<T>(work: () => Promise<T>): Promise<T> {
  asked.clear();
  parsedTexts.clear();
  const spy = vi
    .spyOn(JSON, "parse")
    .mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) =>
      parsedTexts.has(text) ? parsedTexts.get(text) : originalParse(text, reviver),
    );
  try {
    return await work();
  } finally {
    spy.mockRestore();
  }
}

// ---------------------------------------------------------------------------------------------
// Read-model outputs (typed as the full output, so a new read-model field must be added here).
// ---------------------------------------------------------------------------------------------
type Queue = Output<"orderQueue">;
type QueueItem = Queue["items"][number];
const dineIn = {
  orderReference: id(0x903),
  orderNumber: "T7-12",
  orderType: "DineIn",
  sourceChannel: "Qr",
  businessDate: "2026-10-16",
  listedBusinessDate: "2026-10-16",
  earlierDay: false,
  submittedAt: at(0),
  initialBatchReference: id(0x9031),
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  kitchenPhase: null,
  remakingItemCount: 0,
  acceptBy: null,
  acceptanceHold: null,
  awaitingPayment: false,
  canRecordCardMachinePayment: true,
  canViewPayments: true,
  counter: null,
  // DEC-DINE-IN-PAY-LATER: the table's bill on the Orders row (v15 2026-10-27: it was dropped).
  tableBill: { totalMinor: "8000", paid: { amountMinor: "9200", method: "Cash" } },
  paidOnline: { amountMinor: "8000", currencyCode: "CAD" },
  paymentPosition: { refundedMinor: "500", refundPendingMinor: "0" },
  heldStock: null,
  summary: {
    items: [{ name: "Ramen", option: "Large", quantity: 2 }],
    lineCount: 3,
    pickupName: null,
    tableLabel: "T7",
  },
  diningSessionReference: id(0x9039),
  currentPhase: "Accepted",
  currentVersion: 4,
  readyToServeItemCount: 2,
  observedAt: at(30),
  batches: [
    {
      orderBatchReference: id(0x9031),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      awaitingAcceptanceSince: null,
      canCancel: true,
      canCancelItems: true,
      canCancelUnpaid: false,
      paymentDue: null,
      staffCancellation: null,
      staffRound: null,
      // DEC-DINE-IN-PAY-LATER (rule 19): dishes that can come off / came off the unpaid bill.
      unpaidRemovableItems: [id(0x9037)],
      unpaidRemovedItems: [id(0x9038)],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(1),
    },
    {
      orderBatchReference: id(0x9032),
      sequence: 2,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: true,
      // The paid round waiting for staff: Orders and Home warn after 5 and 10 minutes.
      awaitingAcceptanceSince: at(14),
      canCancel: false,
      canCancelItems: false,
      canCancelUnpaid: false,
      paymentDue: null,
      staffCancellation: null,
      staffRound: null,
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(2),
    },
    {
      orderBatchReference: id(0x9033),
      sequence: 3,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: false,
      awaitingAcceptanceSince: null,
      canCancel: false,
      canCancelItems: false,
      canCancelUnpaid: true,
      paymentDue: { status: "Failed", cancelsAt: at(40) },
      staffCancellation: null,
      staffRound: { recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: "1200" },
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(3),
    },
    {
      orderBatchReference: id(0x9034),
      sequence: 4,
      acceptanceStatus: "Cancelled",
      canRequestAcceptance: false,
      awaitingAcceptanceSince: null,
      canCancel: false,
      canCancelItems: false,
      canCancelUnpaid: false,
      paymentDue: null,
      staffCancellation: {
        reasonCode: "GUEST_LEFT",
        cancelledAt: at(20),
        refundStatus: "Pending",
        refundMethod: "CardMachine",
        refundAmountMinor: "900",
      },
      staffRound: {
        recordedAfterOutage: true,
        paidOnCardMachine: { amountMinor: "900", takenAt: at(10), refundedMinor: "0" },
        amountDueMinor: null,
      },
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(4),
    },
  ],
} satisfies QueueItem;
const heldPickup = {
  orderReference: id(0x902),
  orderNumber: "P-31",
  orderType: "Pickup",
  sourceChannel: "Web",
  businessDate: "2026-10-16",
  listedBusinessDate: "2026-10-16",
  earlierDay: false,
  submittedAt: at(1),
  initialBatchReference: id(0x9021),
  canRequestAcceptance: true,
  unfulfillable: null,
  pickupNotCollected: false,
  kitchenPhase: null,
  remakingItemCount: 0,
  acceptBy: at(25),
  acceptanceHold: {
    holdReference: id(0x9029),
    orderBatchReference: id(0x9021),
    heldAt: at(6),
    lapsedDeadline: at(5),
    storeLastSeenAt: at(2),
    decideBy: at(25),
    refundChosen: false,
    canRefund: true,
  },
  awaitingPayment: false,
  canRecordCardMachinePayment: true,
  canViewPayments: true,
  tableBill: null,
  counter: null,
  paidOnline: { amountMinor: "2400", currencyCode: "CAD" },
  paymentPosition: null,
  heldStock: null,
  summary: {
    items: [{ name: "Latte", option: null, quantity: 1 }],
    lineCount: 1,
    pickupName: "TEST Sam",
    tableLabel: null,
  },
  diningSessionReference: null,
  currentPhase: "Submitted",
  currentVersion: 1,
  readyToServeItemCount: 0,
  observedAt: at(30),
  batches: [
    {
      orderBatchReference: id(0x9021),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: true,
      awaitingAcceptanceSince: null,
      canCancel: false,
      canCancelItems: false,
      canCancelUnpaid: false,
      paymentDue: null,
      staffCancellation: null,
      staffRound: null,
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(5),
    },
  ],
} satisfies QueueItem;
const earlierCounterPickup = {
  orderReference: id(0x801),
  orderNumber: "C-4",
  orderType: "Pickup",
  sourceChannel: "Pos",
  businessDate: "2026-10-15",
  listedBusinessDate: "2026-10-15",
  earlierDay: true,
  submittedAt: at(0),
  initialBatchReference: id(0x8011),
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  kitchenPhase: null,
  remakingItemCount: 0,
  acceptBy: null,
  acceptanceHold: null,
  awaitingPayment: false,
  canRecordCardMachinePayment: true,
  canViewPayments: false,
  tableBill: null,
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1500",
      takenAt: at(0),
      recordedAfterOutage: false,
      refundedMinor: "0",
    },
    payBy: null,
    amountDueMinor: null,
  },
  paidOnline: null,
  paymentPosition: null,
  summary: {
    items: [{ name: "Latte", option: "Small", quantity: 1 }],
    lineCount: 1,
    pickupName: null,
    tableLabel: null,
  },
  diningSessionReference: null,
  heldStock: {
    since: at(0),
    state: "Open",
    orderBatchReference: id(0x8011),
    productionStarted: true,
  },
  currentPhase: "InProgress",
  currentVersion: 3,
  readyToServeItemCount: 0,
  observedAt: at(30),
  batches: [
    {
      orderBatchReference: id(0x8011),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      awaitingAcceptanceSince: null,
      canCancel: false,
      canCancelItems: false,
      canCancelUnpaid: false,
      paymentDue: null,
      staffCancellation: null,
      staffRound: null,
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      // WP-2423 item 8 ① segment 2: comps and discounts; Orders v3: when the round was sent.
      compableItems: [],
      compedItems: [],
      submittedAt: at(6),
    },
  ],
} satisfies QueueItem;
const queueView = {
  items: [earlierCounterPickup, dineIn, heldPickup],
  nextAfterOrderReference: null,
  lines: null,
  pickupContact: null,
  paymentPosition: null,
} satisfies Queue;
const line = (n: number, batch: string, canCancel: boolean) => ({
  orderItemReference: id(0x7000 + n),
  orderBatchReference: batch,
  name: `Dish ${n}`,
  options: [{ name: "Extra spicy", quantity: 1 }],
  quantity: 1,
  customerNote: n === 1 ? "No peanuts" : null,
  unitPrice: money("1000"),
  subtotal: money("1000"),
  discount: money("0"),
  tax: money("130"),
  fee: money("0"),
  total: money("1130"),
  // The detail adds what staff may do with each line (absent from the list's lines type).
  canCancel,
  cancellation: null,
});
const detailView = {
  items: [dineIn],
  nextAfterOrderReference: null,
  lines: {
    items: [line(1, id(0x9031), true), line(2, id(0x9032), false)],
    totals: {
      subtotal: money("2000"),
      discount: money("0"),
      tax: money("260"),
      fee: money("0"),
      tip: money("0"),
      total: money("2260"),
    },
  } as Queue["lines"],
  pickupContact: null,
  paymentPosition: { refundedMinor: "500", refundPendingMinor: "0" },
} satisfies Queue;
const pickupDetailView = {
  items: [heldPickup],
  nextAfterOrderReference: null,
  lines: {
    items: [line(3, id(0x9021), false)],
    totals: {
      subtotal: money("1000"),
      discount: money("0"),
      tax: money("130"),
      fee: money("0"),
      tip: money("0"),
      total: money("1130"),
    },
  } as Queue["lines"],
  pickupContact: {
    status: "Available",
    name: "Sam",
    channel: "Phone",
    value: "+14165550100",
    // Kept by the BFF: the browser never needs the contact record's own reference and version.
    detailsReference: id(0x9028),
    detailsVersion: 1,
  },
  paymentPosition: null,
} satisfies Queue;

type KitchenList = Extract<Output<"kitchenQuery">, { items: unknown }>;
const projection = {
  projectionName: "kitchen_work_queue_v1",
  projectionVersion: 1,
  projectionGenerationReference: id(0x601),
  sourceCheckpointReference: id(0x602),
  asOfUtc: at(29),
  projectedAt: at(29),
  activationLagMs: 0,
  freshnessStatus: "Fresh",
  partial: false,
  stale: false,
  lastRebuiltAt: at(0),
  initializedEmpty: false,
  projectionRegistryStatus: "runtime-inactive",
  projectionHealth: "NotAvailable",
  bulkExport: "NotAvailable",
  futureCapabilities: {
    course: "NotAvailable",
    priority: "NotAvailable",
    slaOverdue: "NotAvailable",
    holdReason: "NotAvailable",
    exception: "NotAvailable",
    claim: "NotAvailable",
    eta: "NotAvailable",
    structuredAllergenAssistance: "NotAvailable",
  },
} as const;
const kitchenItem = (n: number, status: "Queued" | "Completed"): KitchenList["items"][number] => ({
  ticketReference: id(0x610),
  workItemReference: id(0x620 + n),
  orderReference: dineIn.orderReference,
  orderBatchReference: id(0x9031),
  orderItemReference: id(0x7000 + n),
  sourceItemOrdinal: n,
  status,
  requiredQuantity: 1,
  completedQuantity: status === "Completed" ? 1 : 0,
  localizedDisplayNames: { "en-CA": `Dish ${n}` },
  selectedOptions: [
    { optionReference: id(0x630 + n), quantity: 1, localizedNames: { "en-CA": "Extra spicy" } },
  ],
  stationReference: id(0x640),
  // WP-2423 item 8 ⑧: no kitchen section; item 8 ⑥: not a combo; item 8 ⑦: a server chased it.
  kitchenSection: null,
  comboParts: [
    {
      optionReference: id(0x650 + n),
      nameZh: "担担面",
      name: "Dan dan noodles",
      done: false,
      served: false,
    },
  ],
  chase: { count: 1, lastChasedAt: at(20) },
  workItemCreatedAt: at(16),
  acceptedAt: at(16),
  orderItemReadyAt: status === "Completed" ? at(25) : null,
  ticketAggregateVersion: "3",
  workItemVersion: "2",
  allergens:
    n === 1
      ? {
          status: "Declared",
          items: [{ code: "PEANUT", name: "Peanuts", classification: "Contains" }],
          // WP-2423 ⑪: whether these are for exactly the options chosen on the item.
          forChoices: true,
        }
      : { status: "Unavailable" },
  orderLabel: {
    orderNumber: "T7-12",
    orderType: "DineIn",
    tableLabel: "T7",
    movedFromTableLabel: null,
    mergedFromTableLabel: null,
    enteredByStaff: false,
  },
  businessDate: "2026-10-16",
  customerNote: n === 1 ? "No peanuts" : null,
});
const kitchenView = {
  ...projection,
  operatorStatus: "Named",
  storeReference,
  canCloseEarlierDayTickets: true,
  // Warn before timeouts: a paid pickup nobody accepted carries its refund deadline to the kitchen.
  // WP-2423 item 8 ⑧: the Store's kitchen sections (none named here).
  kitchenSections: [],
  awaitingAcceptance: [
    {
      orderNumber: "9",
      orderType: "Pickup",
      tableLabel: null,
      movedFromTableLabel: null,
      mergedFromTableLabel: null,
      acceptBy: at(40),
    },
    {
      orderNumber: "T7-13",
      orderType: "DineIn",
      tableLabel: "T7",
      movedFromTableLabel: null,
      mergedFromTableLabel: null,
      acceptBy: null,
    },
  ],
  items: [kitchenItem(1, "Queued"), kitchenItem(2, "Completed")],
  nextCursor: null,
} satisfies KitchenList;

const tablesView = {
  canOperateTables: true,
  canCloseSessions: true,
  canTransferHost: true,
  canCancelUnpaidRounds: true,
  canWriteOff: true,
  items: [
    {
      tableReference: id(0x501),
      stableLabel: "T7",
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      aggregateVersion: 3,
      blockReasonCode: null,
      currentDiningSessionReference: id(0x511),
      elapsedMinutes: 30,
      qrCodeValidUntil: at(59),
      paymentTiming: "PayLater",
      staffCall: null,
      heldRounds: [],
      newPhones: [],
      session: {
        phase: "Active",
        version: 5,
        orderReference: dineIn.orderReference,
        paymentStarted: false,
        mergedTables: [],
      },
      guestRoundsAwaitingPayment: [
        {
          orderReference: dineIn.orderReference,
          orderBatchReference: id(0x9033),
          roundNumber: 3,
          payBy: at(40),
        },
      ],
      roundsAwaitingAcceptance: [{ roundNumber: 2, paidAt: at(14) }],
      staffRoundsAwaitingPayment: [{ payBy: at(45) }],
    },
  ],
  nextAfterTableReference: null,
} satisfies Output<"diningTables">;

const run = {
  runReference: id(0x401),
  mode: "DailySettlement",
  scheduledAt: at(0),
  cutoffAt: at(0),
  completedAt: at(1),
  counts: { Unavailable: 0, Matched: 3, Healed: 0, Unresolved: 0, Difference: 1 },
} as const;
const check = (n: number, outcome: "Matched" | "Difference", runReference = run.runReference) => ({
  checkReference: id(0x410 + n),
  runReference,
  checkedAt: at(1),
  outcome,
  differenceReason: outcome === "Difference" ? "AmountMismatch" : null,
  settlementReference: "po_test_1",
  internalStatus: "Captured",
  providerStatus: "succeeded",
  currencyCode: "CAD" as const,
  internalCapturedMinor: "1000",
  providerCapturedMinor: outcome === "Difference" ? "900" : "1000",
  internalRefundedMinor: "0",
  providerRefundedMinor: "0",
  exceptionReference: outcome === "Difference" ? id(0x420) : null,
});
const settlementView = {
  screenId: "PAY-RECONCILIATION",
  storeLabel: "Training Store",
  businessDate: "2026-10-15",
  window: {
    startsAt: "2026-10-15T04:00:00.000Z",
    endsAt: "2026-10-16T04:00:00.000Z",
    timeZone: "America/Toronto",
    status: "Closed",
  },
  captured: { count: 3, amountMinor: "3000", currencyCode: "CAD" },
  refunded: { count: 1, amountMinor: "500", currencyCode: "CAD" },
  selfApprovedRefunds: { count: 1, amountMinor: "500", currencyCode: "CAD" },
  currentDaySelfApprovedRefunds: {
    count: 0,
    amountMinor: "0",
    currencyCode: "CAD",
    businessDate: "2026-10-16",
  },
  reconciliation: {
    settlement: {
      run,
      checks: [check(1, "Matched"), check(2, "Difference")],
      recheck: {
        run: { ...run, runReference: id(0x402) },
        check: check(4, "Difference", id(0x402)),
        count: 1,
      },
      additionalChecks: [check(3, "Matched", id(0x403))],
    },
    operational: {
      runCount: 1,
      latestRun: { ...run, mode: "Operational" },
      paymentCount: 4,
      outcomes: { Unavailable: 0, Matched: 3, Healed: 0, Unresolved: 0, Difference: 1 },
    },
    differences: [check(2, "Difference")],
    differenceCount: 1,
  },
  cardMachine: {
    taken: { count: 1, amountMinor: "900", currencyCode: "CAD" },
    tipMinor: "100",
    recordedAfterOutageCount: 1,
    refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
  },
  // DEC-DINE-IN-PAY-LATER: tables paid in cash, and bills written off when guests left unpaid.
  cash: {
    received: { count: 1, amountMinor: "1045", currencyCode: "CAD" },
    tipMinor: "0",
    roundingMinor: "-1",
    refunded: { count: 1, amountMinor: "200", currencyCode: "CAD" },
    netMinor: "845",
    recordedAfterOutageCount: 0,
  },
  unpaidWriteOffs: { count: 1, amountMinor: "537", currencyCode: "CAD" },
  comps: { count: 2, amountMinor: "2830", currencyCode: "CAD" },
  unmatchedProviderCharges: {
    captured: { count: 0, amountMinor: "0", currencyCode: "CAD" },
    refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
  },
  projectedAt: at(30),
} satisfies Output<"settlement">;

const pickupView = {
  workstation: { deviceReference: id(0x301), pickupLocationReference: id(0x302) },
  storeReference,
  // WP-2423 item 8 ⑦: guest pickup is on at this Store.
  guestPickupOff: false,
  items: [
    {
      fulfillmentReference: id(0x311),
      orderReference: heldPickup.orderReference,
      phase: "Ready",
      readyAt: at(20),
      publicOrderReference: "AbCdEfGhIjKlMnOpQrStUv",
      orderNumber: "P-31",
      businessDate: "2026-10-16",
      remakeInProgress: 0,
      takenAtCounter: false,
      aggregateVersion: "4",
      proof: { kind: "HumanCode", generation: 1, expiresAt: at(50) },
      codeChecksLocked: true,
      items: [
        {
          fulfillmentItemReference: id(0x321),
          name: "Dish 3",
          options: [{ name: "Extra spicy", quantity: 1 }],
          orderedQuantity: 1,
          readyQuantity: 1,
          handedOverQuantity: 0,
        },
      ],
    },
  ],
  source: "CurrentFulfillment",
  observedAt: at(30),
  nextAfterFulfillmentReference: null,
} satisfies Output<"pickupQuery">;

// ---------------------------------------------------------------------------------------------
const signal = () => new AbortController().signal;

describe("merchant BFF responses carry every read-model field the browser parses", () => {
  it("order queue (Orders and Home)", async () => {
    stub("orderQueue").mockResolvedValue(queueView);
    const view = await throughClient(() =>
      createCurrentOrderQueueClient(fetcher).load(null, signal()),
    );
    expect(
      dropped(queueView, (path) => path.replace(/^\.earlierDayItems\[\]/u, ".items[]")),
    ).toEqual([]);
    const table = view.items.find((item) => item.orderReference === dineIn.orderReference);
    expect(table?.batches[1]?.awaitingAcceptanceSince).toBe(at(14));
    expect(table?.readyToServeItemCount).toBe(2);
    expect(view.items.map((item) => item.orderReference)).toEqual([
      earlierCounterPickup.orderReference,
      dineIn.orderReference,
      heldPickup.orderReference,
    ]);
  });

  it("order detail", async () => {
    for (const model of [detailView, pickupDetailView]) {
      stub("orderQueue").mockResolvedValue(model);
      const order = (model.items[0] ?? dineIn).orderReference;
      const detail = await throughClient(() =>
        createCurrentOrderQueueClient(fetcher).loadDetail(order, signal()),
      );
      // The detail answers the read model's one Order as `order`.
      expect(dropped(model, (path) => path.replace(/^\.order(?=\.|$)/u, ".items[]"))).toEqual([]);
      expect(detail.order.orderReference).toBe(order);
    }
    stub("orderQueue").mockResolvedValue(detailView);
    const detail = await throughClient(() =>
      createCurrentOrderQueueClient(fetcher).loadDetail(dineIn.orderReference, signal()),
    );
    expect(detail.order.batches[1]?.awaitingAcceptanceSince).toBe(at(14));
  });

  it("kitchen board", async () => {
    stub("kitchenQuery").mockResolvedValue(kitchenView);
    const board = parseKitchenBoardView(
      await throughClient(() =>
        createKitchenBoardClient({
          csrf,
          storeLabel: "Training Store",
          storeReference,
          fetcher,
        }).loadQueue(),
      ),
    );
    expect(dropped(kitchenView)).toEqual([]);
    expect(board.items).toHaveLength(2);
    expect(board.awaitingAcceptance?.map((label) => label.acceptBy)).toEqual([at(40), null]);
  });

  it("tables", async () => {
    stub("diningTables").mockResolvedValue(tablesView);
    const tables = await throughClient(() => createDiningSessionClient(fetcher).tables(csrf));
    expect(dropped(tablesView)).toEqual([]);
    expect(tables.items[0]?.roundsAwaitingAcceptance).toEqual([{ roundNumber: 2, paidAt: at(14) }]);
  });

  it("settlement", async () => {
    stub("settlement").mockResolvedValue(settlementView);
    const settlement = await throughClient(() =>
      createSettlementClient(fetcher).load(null, signal()),
    );
    expect(dropped(settlementView)).toEqual([]);
    expect(settlement.businessDate).toBe("2026-10-15");
  });

  it("pickup counter (Home)", async () => {
    stub("pickupQuery").mockResolvedValue(pickupView);
    const pickups = parsePickupQueueView(
      await throughClient(() =>
        createPickupClient({
          csrf,
          storeReference,
          storeLabel: "Training Store",
          fetcher,
        }).loadQueue(),
      ),
    );
    expect(dropped(pickupView)).toEqual([]);
    expect(pickups.items).toHaveLength(1);
  });

  it("tablet refund re-check (signed-out cover and PIN screen)", async () => {
    const model = {
      checkedAt: at(41),
      orders: [
        { orderNumber: "16", acceptBy: null },
        { orderNumber: "17", acceptBy: at(50) },
      ],
    } satisfies Full<Awaited<ReturnType<StaffPinPort["refundRecheck"]>>>;
    tabletRecheck.mockResolvedValue(model);
    const answer = await throughClient(() =>
      createStaffPinClient(null, fetcher).refundRecheck(["16", "17"], signal()),
    );
    expect(dropped(model)).toEqual([]);
    expect(answer).toEqual(model);
    expect(tabletRecheck).toHaveBeenCalledWith(deviceCookie, ["16", "17"]);
  });

  it("the recorder sees a field the BFF drops", async () => {
    // Guard of the guard: a read-model field the client asks for and the response lacks is found.
    asked.clear();
    const response = record({ items: [{ batches: [{ sequence: 1 }] }] }, "") as {
      items: { batches: Record<string, unknown>[] }[];
    };
    expect(Object.hasOwn(response.items[0]?.batches[0] ?? {}, "awaitingAcceptanceSince")).toBe(
      false,
    );
    expect(dropped(queueView)).toEqual([".items[].batches[].awaitingAcceptanceSince"]);
  });
});
