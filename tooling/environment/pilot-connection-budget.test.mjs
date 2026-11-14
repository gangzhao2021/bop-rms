import { expect, it } from "vitest";
import {
  pilotApiRoleConnectionLimit,
  pilotApiRoleMinimumLimit,
  pilotEffectiveRoleLimit,
  pilotProcessPoolSize,
  planPilotConnections,
} from "./pilot-connection-budget.mjs";
import {
  admitServedStores,
  PILOT_CONNECTION_BUDGET_EXCEEDED,
  reportConnectionBudget,
} from "./pilot-served-stores.mjs";

const stores = (n) => Array.from({ length: n }, (_, i) => "stores/demo-" + (i + 2));
/** Every process at its pool size, plus the operators' headroom. */
const total = (plan) => {
  const size = (file) => pilotProcessPoolSize(plan, "/app/tooling/environment/" + file);
  // One process and one pool per entry; the first Store's five workers; one for the other Stores.
  return (
    size("pilot-api-entry.mjs") +
    size("pilot-https-entry.mjs") +
    size("pilot-business-worker.mjs") +
    size("pilot-kitchen-queue-worker.mjs") +
    size("pilot-reconciliation-worker.mjs") +
    size("pilot-daily-settlement-worker.mjs") +
    size("pilot-dining-exception-worker.mjs") +
    size("pilot-store-workers.mjs") +
    10
  );
};

it("every process fits the role's limit, whatever the Store count", () => {
  for (const limit of [30, 45, 60, pilotApiRoleConnectionLimit, 150, 400])
    for (let storeCount = 1; storeCount <= 100; storeCount += 1) {
      const plan = planPilotConnections({ storeCount, limit });
      if (plan.admittedStores > 0) expect(total(plan)).toBeLessThanOrEqual(limit);
    }
});

it("DEC-MULTI-MERCHANT-ONE-INSTALLATION A5: Stores no longer cost five processes' connections each", () => {
  const three = planPilotConnections({ storeCount: 3, limit: pilotApiRoleConnectionLimit });
  expect(three.admittedStores).toBe(3);
  expect(three.pools).toEqual({ api: 7, https: 5, business: 3, worker: 2 });
  expect(pilotProcessPoolSize(three, "x/pilot-api-entry.mjs")).toBe(21);
  expect(pilotProcessPoolSize(three, "x/pilot-https-entry.mjs")).toBe(15);
  expect(pilotProcessPoolSize(three, "x/pilot-store-workers.mjs")).toBe(6);
  // The old limit of four Stores at this role limit is gone.
  expect(planPilotConnections({ storeCount: 5, limit: 80 }).admittedStores).toBe(5);
  const many = planPilotConnections({ storeCount: 18, limit: 80 });
  expect(many.admittedStores).toBe(18);
  expect(pilotProcessPoolSize(many, "x/pilot-store-workers.mjs")).toBe(16);
  // A larger role limit serves more.
  expect(planPilotConnections({ storeCount: 100, limit: 80 }).admittedStores).toBeLessThan(100);
  expect(planPilotConnections({ storeCount: 100, limit: 300 }).admittedStores).toBe(100);
  // One Store has no shared worker process.
  const one = planPilotConnections({ storeCount: 1, limit: 80 });
  expect(pilotProcessPoolSize(one, "x/pilot-store-workers.mjs")).toBe(0);
  expect(pilotProcessPoolSize(one, "x/pilot-api-entry.mjs")).toBe(7);
});

it("a Store that doesn't fit is named and not started; the Stores before it keep running", () => {
  const { admitted, refused } = admitServedStores(stores(30), 45);
  expect(admitted.length).toBeGreaterThan(0);
  expect(admitted[0]).toBe("stores/demo-2");
  expect(refused.at(-1)).toBe("stores/demo-31");
  expect(admitted.length + refused.length).toBe(30);
  const lines = [];
  reportConnectionBudget(["stores/demo-3"], 45, (line) => lines.push(JSON.parse(line)));
  expect(lines).toEqual([
    {
      level: 50,
      event: PILOT_CONNECTION_BUDGET_EXCEEDED,
      store: "stores/demo-3",
      roleLimit: 45,
    },
  ]);
  // An unreadable limit never stops a Store: the database then answers for itself.
  expect(admitServedStores(stores(9), null).refused).toEqual([]);
});

it("the database's own limits decide, and the role is reported not ready below one Store's need", () => {
  expect(pilotEffectiveRoleLimit({ roleLimit: 80, maxConnections: 100 })).toBe(80);
  expect(pilotEffectiveRoleLimit({ roleLimit: -1, maxConnections: 100 })).toBe(80);
  expect(pilotEffectiveRoleLimit({ roleLimit: 90, maxConnections: 60 })).toBe(40);
  expect(pilotApiRoleMinimumLimit).toBe(26);
  expect(planPilotConnections({ storeCount: 1, limit: 25 }).admittedStores).toBe(0);
});

it("an operator command takes a small pool", () => {
  const plan = planPilotConnections({ storeCount: 1, limit: 80 });
  expect(pilotProcessPoolSize(plan, "/app/tooling/environment/pilot-acl-export.mjs")).toBe(2);
  expect(pilotProcessPoolSize(plan, undefined)).toBe(2);
});
