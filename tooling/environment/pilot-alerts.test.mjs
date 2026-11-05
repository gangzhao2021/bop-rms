import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALERT_KEYS,
  advanceAlertState,
  buildAlertBoard,
  emptyAlertState,
  evaluateAlertConditions,
  evaluateStoreConditions,
  planChannelDelivery,
  recordChannelDelivery,
  renderAlert,
  renderMessage,
  uncheckedAlertKeys,
  rootOutboundNotifications,
  storeOutboundNotifications,
} from "./pilot-alerts.mjs";
import { buildWebhookRequest } from "./pilot-alert-channels.mjs";

const T0 = Date.parse("2026-10-15T03:00:00.000Z");
const MIN = 60_000;
const healthy = (now = T0) => ({
  now,
  probes: { api: { ok: true }, customer: { ok: true }, merchant: { ok: true } },
  supervisor: { maintenance: false, reportAgeMs: 5000, attention: [] },
  business: {
    stuckUpdates: { count: 0, oldestAgeMs: 0 },
    retryingUpdates: { count: 0, oldestAgeMs: 0 },
    reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
    settlementExceptions: { count: 0, oldestAgeMs: 0 },
  },
  backup: { lastSuccessAt: new Date(now - 3 * 3600_000).toISOString() },
  certificate: { validTo: new Date(now + 30 * 86400_000).toISOString() },
  disks: [{ name: "runtime", freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 }],
  channels: [],
});
const keys = (conditions) => [...conditions.keys()].sort();

describe("WP-2423 Q13 alert rules", () => {
  it("raises nothing when every source is healthy", () => {
    expect(keys(evaluateAlertConditions(healthy()))).toEqual([]);
  });
  it("maps each source to its alert, with escalation by age or size", () => {
    const o = healthy();
    o.probes.customer = { ok: false, failingForMs: 3 * MIN };
    o.supervisor = {
      maintenance: false,
      reportAgeMs: 1000,
      attention: ["business-worker:paymentWait"],
    };
    o.business.stuckUpdates = { count: 2, oldestAgeMs: 10 * MIN };
    o.business.reconciliationDifferences = { count: 1, oldestAgeMs: 30 * 3600_000 };
    o.business.settlementExceptions = { count: 1, oldestAgeMs: 8 * 3600_000 };
    o.backup = {
      lastSuccessAt: new Date(T0 - 27 * 3600_000).toISOString(),
      lastAttempt: { result: "Failed", stage: "dump", attemptsLeft: 2 },
      restoreCheck: { result: "Failed" },
      offsite: { result: "Failed" },
    };
    o.certificate = { validTo: new Date(T0 + 36 * 3600_000).toISOString() };
    o.disks = [{ name: "database", freeBytes: 512 * 1024 ** 2, totalBytes: 60 * 1024 ** 3 }];
    o.channels = [{ kind: "email", failingSince: new Date(T0 - 40 * MIN).toISOString() }];
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(
      [
        "backup.failed",
        "backup.offsite",
        "backup.restore_check",
        "backup.stale",
        "certificate.expiring",
        "channel.delivery",
        "disk.low",
        "entry.customer",
        "payment.updates",
        "reconciliation.differences",
        "service.attention",
        "settlement.exceptions",
      ].sort(),
    );
    expect(c.get("reconciliation.differences").severity).toBe("critical");
    expect(c.get("certificate.expiring").severity).toBe("critical");
    expect(c.get("disk.low").severity).toBe("critical");
  });
  it("DEC-PILOT-INSTALLATION: warns two weeks before the installation's validity ends, urgent in the last 3 days", () => {
    const at = (days) => {
      const o = healthy();
      o.installation = { validUntil: new Date(T0 + days * 86400_000).toISOString() };
      return evaluateAlertConditions(o);
    };
    expect(keys(at(30))).toEqual([]);
    expect(keys(at(15))).toEqual([]);
    expect(at(13).get("installation.validity").severity).toBe("warning");
    expect(at(2).get("installation.validity").severity).toBe("critical");
    expect(at(-1).get("installation.validity").severity).toBe("critical");
    const soon = renderAlert("installation.validity", at(13).get("installation.validity").params);
    expect(soon.title).toBe("The store's ordering setup expires soon");
    expect(soon.summary).toContain("It expires in 13 days");
    expect(soon.action).toContain("Approve a new end date");
    expect(
      renderAlert("installation.validity", at(-1).get("installation.validity").params).title,
    ).toBe("The store's ordering setup has expired");
    const o = healthy();
    o.installation = "unreadable";
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the store setup end date",
    ]);
  });
  it("treats an unreadable source as an alert, never as healthy; a missing supervisor report too", () => {
    const o = healthy();
    o.business = "unreadable";
    o.disks = "unreadable";
    o.supervisor = null;
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["monitor.source", "supervisor.silent"]);
    expect(c.get("monitor.source").params.sources).toEqual([
      "payment and settlement status",
      "disk space",
    ]);
  });
  it("WP-2423: warns while order updates are still being retried, urgent after 30 minutes, and clears once processed", () => {
    const o = healthy();
    o.business.retryingUpdates = { count: 1, oldestAgeMs: 2 * MIN };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["updates.retrying"]);
    expect(c.get("updates.retrying").severity).toBe("warning");
    const text = renderAlert("updates.retrying", c.get("updates.retrying").params);
    expect(text.title).toBe("Some order updates are being retried");
    expect(text.summary).toContain("1 order update is being retried (failing for 2 minutes)");
    expect(text.summary).toContain("Ready orders may not show for pickup yet");
    expect(text.action).toContain("name or phone number");
    expect(text.runbook).toBe("alert-updates-retrying");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    // Raised on the first cycle it is seen (no wait), escalated after 30 minutes.
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "updates.retrying"]]);
    o.business.retryingUpdates = { count: 2, oldestAgeMs: 31 * MIN };
    ({ state, notifications } = advanceAlertState(
      state,
      evaluateAlertConditions(o),
      T0 + 29 * MIN,
    ));
    expect(notifications.map((n) => [n.kind, n.severity])).toEqual([["escalated", "critical"]]);
    // Processed: the condition is gone and the alert clears after the quiet period.
    o.business.retryingUpdates = { count: 0, oldestAgeMs: 0 };
    ({ state, notifications } = advanceAlertState(
      state,
      evaluateAlertConditions(o),
      T0 + 30 * MIN,
    ));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 32 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "updates.retrying"]]);
  });
  it("WP-2423: says receipts are not issued after 2 minutes when the Store's receipt template cannot be used", () => {
    const o = healthy();
    o.business.receiptTemplate = { ready: true };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.receiptTemplate = { ready: false, reason: "TemplateNotProven" };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["receipts.template"]);
    expect(c.get("receipts.template").severity).toBe("critical");
    const text = renderAlert("receipts.template", c.get("receipts.template").params);
    expect(text.title).toBe("Receipts are not being issued");
    expect(text.summary).toContain("The receipt template chosen in Store setup cannot be used");
    expect(text.action).toContain("step 5");
    expect(text.runbook).toBe("alert-receipts-template");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    // A brief failure is not raised; one lasting 2 minutes is, and it clears once receipts work.
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, c, T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "receipts.template"]]);
    o.business.receiptTemplate = { ready: false, reason: "StoreConfigurationUnavailable" };
    expect(
      renderAlert("receipts.template", evaluateAlertConditions(o).get("receipts.template").params)
        .summary,
    ).toContain("published settings could not be read");
    o.business.receiptTemplate = { ready: true };
    ({ state, notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 3 * MIN));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 6 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "receipts.template"]]);
    // A check that could not run is reported as such, never as fine.
    o.business.receiptTemplate = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the receipt template check",
    ]);
  });
  it("WP-2423: says orders cannot be priced after 2 minutes when the published tax settings are not the pilot's", () => {
    const o = healthy();
    o.business.quoteTax = { ready: true };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.quoteTax = { ready: false, reason: "TaxConfigurationMismatch" };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["pricing.tax_configuration"]);
    expect(c.get("pricing.tax_configuration").severity).toBe("critical");
    const text = renderAlert(
      "pricing.tax_configuration",
      c.get("pricing.tax_configuration").params,
    );
    expect(text.title).toBe("Orders cannot be priced");
    expect(text.summary).toContain("tax settings published in Store setup");
    expect(text.action).toContain("on paper");
    expect(text.action).toContain("step 8");
    expect(text.runbook).toBe("alert-pricing-tax-configuration");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    let { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, c, T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([
      ["raised", "pricing.tax_configuration"],
    ]);
    o.business.quoteTax = { ready: false, reason: "StoreConfigurationUnavailable" };
    expect(
      renderAlert(
        "pricing.tax_configuration",
        evaluateAlertConditions(o).get("pricing.tax_configuration").params,
      ).summary,
    ).toContain("published settings could not be read");
    o.business.quoteTax = { ready: true };
    ({ state, notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 3 * MIN));
    expect(notifications).toEqual([]);
    ({ notifications } = advanceAlertState(state, evaluateAlertConditions(o), T0 + 6 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([
      ["cleared", "pricing.tax_configuration"],
    ]);
    o.business.quoteTax = "unreadable";
    expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
      "the check that orders can be priced",
    ]);
  });
  describe("WP-2423 item 9: what a refused Workflow stops, in the words of the floor", () => {
    const both = ["DineIn", "Pickup"];
    const conditions = (refusals, orderTypes = both) => {
      const o = healthy();
      o.business.workflow = { ready: false, refusals, orderTypes };
      return evaluateAlertConditions(o);
    };
    const refused = (binding, rule = "TwoBrandVersions") => ({ binding, rule });
    const stale = (binding) => refused(binding, "ExpectedVersionChanged");
    const say = (condition, key = "orders.workflow") => renderAlert(key, condition.get(key).params);
    const readable = (text) => {
      expect(text.title.length).toBeLessThanOrEqual(120);
      expect(text.summary.length).toBeLessThanOrEqual(600);
      expect(text.action.length).toBeLessThanOrEqual(400);
      // The rule stays in BOP's log, and staff are never sent back the moment the row clears.
      expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(
        /TwoBrandVersions|ExpectedVersionChanged|Workflow|binding|once this clears/u,
      );
      expect(text.runbook).toMatch(/^alert-orders-/u);
    };

    it("is quiet when every Workflow answers", () => {
      const o = healthy();
      o.business.workflow = { ready: true };
      expect(keys(evaluateAlertConditions(o))).toEqual([]);
      o.business.workflow = null;
      expect(keys(evaluateAlertConditions(o))).toEqual([]);
    });
    it("every order type refused: paper and the card machine, urgent", () => {
      const c = conditions([refused("Pickup"), refused("DineIn"), refused("AdditionalRelease")]);
      expect(keys(c)).toEqual(["orders.workflow"]);
      expect(c.get("orders.workflow").severity).toBe("critical");
      expect(c.get("orders.workflow").params).toEqual({
        state: "Orders",
        refused:
          "Pickup:TwoBrandVersions DineIn:TwoBrandVersions AdditionalRelease:TwoBrandVersions",
      });
      const text = say(c);
      readable(text);
      expect(text.title).toBe("New orders cannot go through");
      expect(text.summary).toContain("cannot order or pay on their phones");
      expect(text.action).toContain("Pause all services");
      expect(text.action).toContain("Tell seated tables to order with staff");
      expect(text.action).toContain("paper slip, card machine");
      expect(text.action).toContain("until they say it is fixed");
    });
    it("Pickup only: the floor keeps serving dine-in", () => {
      const c = conditions([refused("Pickup")]);
      expect(c.get("orders.workflow").severity).toBe("critical");
      const text = say(c);
      readable(text);
      expect(text.title).toBe("Pickup orders cannot go through");
      expect(text.summary).toContain("Dine-in is not affected");
      expect(text.action).toContain("Pause pickup");
      expect(text.action).toContain("New pickup orders: paper slip");
      expect(text.action).not.toContain("seated tables");
    });
    it("dine-in only: pickup carries on, and later rounds are stopped with the first", () => {
      for (const refusals of [
        [refused("DineIn")],
        [refused("DineIn"), refused("AdditionalRelease")],
        [refused("DineIn"), stale("AdditionalRelease")],
      ]) {
        const text = say(conditions(refusals));
        readable(text);
        expect(text.title).toBe("Table orders cannot go through");
        expect(text.summary).toContain("Pickup is not affected");
        expect(text.action).toContain("Pause dine-in");
        expect(text.action).toContain("Tell seated tables to order with staff");
      }
    });
    it("a Store with one order type hears only about that one, nothing about the other", () => {
      const state = (refusals, orderTypes) =>
        conditions(refusals, orderTypes).get("orders.workflow").params.state;
      const dineIn = ["DineIn"],
        pickup = ["Pickup"];
      expect(state([refused("DineIn")], dineIn)).toBe("TablesStore");
      expect(state([refused("DineIn"), refused("AdditionalRelease")], dineIn)).toBe("TablesStore");
      expect(state([stale("DineIn")], dineIn)).toBe("PaidTablesStore");
      expect(state([stale("DineIn"), refused("AdditionalRelease")], dineIn)).toBe(
        "PaidTablesStore",
      );
      expect(state([refused("Pickup")], pickup)).toBe("PickupStore");
      expect(state([stale("Pickup")], pickup)).toBe("PaidPickupStore");
      for (const refusals of [[refused("DineIn")], [stale("DineIn")]]) {
        const text = say(conditions(refusals, dineIn));
        readable(text);
        expect(text.title).toMatch(/^(Table orders cannot go|Paid table orders may not)/u);
        expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/pickup/iu);
      }
      for (const refusals of [[refused("Pickup")], [stale("Pickup")]]) {
        const text = say(conditions(refusals, pickup));
        readable(text);
        expect(text.title).toMatch(/^(Pickup orders cannot go|Paid pickup orders may not)/u);
        expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/dine-in|table/iu);
      }
    });
    it("one order type stopped while guests still pay for another pauses both, and says so", () => {
      const state = (refusals) => conditions(refusals).get("orders.workflow").params.state;
      // Tables keep paying for rounds that do not reach the kitchen: nobody may read that the phones
      // are down, and nobody may be left without the pause.
      expect(state([refused("Pickup"), stale("DineIn")])).toBe("PaidOrders");
      expect(state([stale("Pickup"), refused("DineIn")])).toBe("PaidOrders");
      expect(state([stale("Pickup"), stale("DineIn")])).toBe("PaidOrders");
      expect(state([stale("Pickup"), stale("AdditionalRelease")])).toBe("PaidOrders");
      // First rounds go on, so further rounds are still paid for.
      expect(state([refused("Pickup"), refused("AdditionalRelease")])).toBe("PaidOrders");
      // Nothing can be paid for at all: the phones really are down.
      expect(state([refused("Pickup"), refused("DineIn"), stale("AdditionalRelease")])).toBe(
        "Orders",
      );
      const text = say(conditions([refused("Pickup"), stale("DineIn")]));
      readable(text);
      expect(text.summary).toContain("Some guests can still order and pay");
      expect(text.summary).not.toContain("cannot order");
      expect(text.action).toContain("Pause all services");
    });
    it("a stale binding on every order type: guests still pay, so staff stop it themselves", () => {
      const c = conditions([stale("Pickup"), stale("DineIn"), stale("AdditionalRelease")]);
      expect(c.get("orders.workflow").severity).toBe("critical");
      expect(c.get("orders.workflow").params.state).toBe("PaidOrders");
      const text = say(c);
      readable(text);
      expect(text.title).toContain("Paid orders may not reach the kitchen");
      expect(text.summary).toContain("can still order and pay");
      expect(text.summary).not.toContain("cannot order");
      expect(text.action).toContain("Pause all services");
      expect(text.action).toContain("order with staff");
      expect(text.action).toContain("no second payment");
      expect(text.action).toContain("until they say it is fixed");
    });
    it("a stale binding on one order type names that type", () => {
      const pickup = say(conditions([stale("Pickup")]));
      readable(pickup);
      expect(pickup.title).toContain("Paid pickup orders may not reach the kitchen");
      expect(pickup.summary).toContain("Dine-in is not affected");
      expect(pickup.action).toContain("Pause pickup");
      const tables = say(conditions([stale("DineIn")]));
      readable(tables);
      expect(tables.title).toBe("Paid table orders may not reach the kitchen");
      expect(tables.summary).toContain("Pickup is not affected");
      expect(tables.action).toContain("Pause dine-in");
    });
    it("further rounds only: first rounds keep going, and either way of refusing reads the same", () => {
      for (const refusal of [refused("AdditionalRelease"), stale("AdditionalRelease")]) {
        const c = conditions([refusal]);
        expect(c.get("orders.workflow").severity).toBe("critical");
        const text = say(c);
        readable(text);
        expect(text.title).toBe("Paid further rounds may not reach the kitchen");
        expect(text.summary).toContain("First rounds");
        expect(text.action).toContain("order further rounds with staff");
        expect(text.action).not.toMatch(/pause/iu);
      }
    });
    describe("what the row promises the floor, in every state that stops or may lose an order", () => {
      /** What each state of the row is about. */
      const floor = {
        Orders: { pickup: true, tables: true },
        Pickup: { pickup: true, tables: false },
        Tables: { pickup: false, tables: true },
        PaidOrders: { pickup: true, tables: true },
        PaidPickup: { pickup: true, tables: false },
        PaidTables: { pickup: false, tables: true },
        PickupStore: { pickup: true, tables: false },
        TablesStore: { pickup: false, tables: true },
        PaidPickupStore: { pickup: true, tables: false },
        PaidTablesStore: { pickup: false, tables: true },
        FurtherRounds: { pickup: false, tables: true },
      };
      const words = (state) => renderAlert("orders.workflow", { state });
      const states = Object.keys(floor);

      it("a guest who already paid is never charged again, in the rows that say guests cannot pay too", () => {
        for (const state of states) {
          readable(words(state));
          expect(words(state).action, state).toContain(
            "A guest who paid: no second payment; kitchen slip with order number.",
          );
        }
      });
      it("every sale on the card machine is entered afterwards, and a slip for a paid order never is", () => {
        for (const state of states) {
          const { action } = words(state);
          expect(action, state).toContain("card machine");
          expect(action, state).toMatch(/Then enter (the )?paper orders/u);
          // Made from a slip, waiting on Orders: it would otherwise be cooked twice, or entered twice.
          expect(action, state).toMatch(
            floor[state].pickup
              ? /a slip whose order is open: accept it, mark it ready, don't remake it/u
              : /for a slip with an order number, accept that order, mark it ready, do not remake it/u,
          );
        }
      });
      it("a refunded pickup order's slip is entered, never skipped as one to accept", () => {
        // Its slip carries an order number, but the order cannot be accepted any more: skipping it
        // would leave the card-machine payment out of the books.
        for (const [state, { pickup }] of Object.entries(floor)) {
          if (!pickup) continue;
          const { action } = words(state);
          expect(action, state).toContain("Then enter paper orders, refunded ones too;");
          expect(action, state).not.toMatch(/slip with an order number/u);
        }
      });
      it("a pause is long enough and can end early, because it ends by itself with no warning", () => {
        for (const state of states.filter((name) => name !== "FurtherRounds")) {
          const { action } = words(state);
          expect(action, state).toMatch(
            /^Pause (all services|pickup|dine-in) in Hours & ordering/u,
          );
          expect(action, state).toContain("until closing (can resume early)");
        }
      });
      it("guests are told, and seated tables hear from staff because a pause does not reach them", () => {
        for (const state of ["Orders", "Tables", "TablesStore"]) {
          expect(words(state).summary, state).toContain(
            "A pause tells new guests to order with staff",
          );
          expect(words(state).summary, state).toContain("does not reach seated tables");
        }
        for (const state of ["Pickup", "PickupStore"])
          expect(words(state).summary, state).toContain("A pause tells guests to order with staff");
        for (const [state, { tables }] of Object.entries(floor))
          if (tables && state !== "FurtherRounds")
            expect(words(state).action, state).toContain("Tell seated tables to order with staff");
      });
      it("warns that a paid pickup order refunds itself, and says what to do when it has", () => {
        for (const [state, { pickup }] of Object.entries(floor)) {
          const { summary } = words(state);
          if (!pickup) {
            expect(summary, state).not.toMatch(/refunded automatically/u);
            continue;
          }
          expect(summary, state).toContain(
            "A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time)",
          );
          expect(summary, state).toContain("With their agreement take payment on the card machine");
          // A Counter pickup order passes the same refused Workflow: the sheet now, the entry later.
          expect(summary, state).toContain(
            "note it on the incident sheet now (a loss if they decline)",
          );
          expect(summary, state).toContain(
            "as a Counter order recorded after an outage only once BOP support says it is fixed",
          );
        }
        // Where only pickup is at stake, it is in what staff read without opening anything.
        for (const state of ["Pickup", "PaidPickup", "PickupStore", "PaidPickupStore"])
          expect(words(state).action, state).toContain("An unaccepted order refunds itself.");
        for (const state of ["PaidOrders", "PaidPickup", "PaidPickupStore"])
          expect(words(state).title, state).toContain("may be refunded automatically");
      });
      it("words the rows by when a table pays: a table keeps the timing it opened with", () => {
        const further = words("FurtherRounds").action;
        expect(further).toContain("Tables that pay before each round order further rounds");
        expect(further).toContain("Tables that pay at the end carry on as usual");
        const unpaid = renderAlert("orders.unpaid_rounds", {}).action;
        expect(unpaid).toContain("Tables that pay before each round: one with an unpaid round");
        expect(unpaid).toContain("Tables that pay at the end carry on and close once they pay");
        expect(renderAlert("orders.unpaid_rounds", {}).summary).toContain(
          "only a round waiting for staff is affected",
        );
        // No one at such a table pays per round, and it is still told what happens.
        for (const state of ["Orders", "Tables", "TablesStore"])
          expect(words(state).summary, state).toContain(
            "A table that pays at the end still pays at the end",
          );
        for (const state of ["PaidOrders", "PaidTables", "PaidTablesStore"])
          expect(words(state).summary, state).toMatch(/rounds may not send at all/u);
      });
    });
    it("an order type the Store does not offer is never an emergency, and BOP still hears", () => {
      // The hotpot has pickup off and a Pickup binding: no paper on a Saturday for a refused family.
      const pickup = conditions([refused("Pickup")], ["DineIn"]);
      expect(pickup.get("orders.workflow").severity).toBe("warning");
      expect(pickup.get("orders.workflow").params.refused).toBe("Pickup:TwoBrandVersions");
      const text = say(pickup);
      readable(text);
      expect(text.title).toBe("Pickup cannot be turned on yet");
      expect(text.action).toContain("before you turn pickup on");
      expect(`${text.summary} ${text.action}`).not.toMatch(/paper|card machine/u);
      // Turning pickup on makes the same refusal urgent on the next read.
      expect(conditions([refused("Pickup")]).get("orders.workflow").severity).toBe("critical");
      for (const binding of ["DineIn", "AdditionalRelease", "Cancellation"]) {
        const tables = conditions([refused(binding)], ["Pickup"]);
        expect(keys(tables)).toEqual(["orders.workflow"]);
        expect(tables.get("orders.workflow").severity).toBe("warning");
        readable(say(tables));
        expect(say(tables).title).toBe("Dine-in cannot be turned on yet");
      }
      // What it does offer still comes first.
      expect(say(conditions([refused("Pickup"), refused("DineIn")], ["DineIn"])).title).toBe(
        "Table orders cannot go through",
      );
    });
    it("the cancellation Workflow has its own urgent row, and names what staff cannot do", () => {
      const c = conditions([refused("Cancellation", "BrandVersionNotActive")]);
      expect(keys(c)).toEqual(["orders.unpaid_rounds"]);
      expect(c.get("orders.unpaid_rounds").severity).toBe("critical");
      expect(c.get("orders.unpaid_rounds").params).toEqual({
        refused: "Cancellation:BrandVersionNotActive",
      });
      const text = say(c, "orders.unpaid_rounds");
      readable(text);
      expect(text.title).toBe("Unpaid rounds are not being cancelled");
      expect(text.summary).toContain("a manager cannot cancel them");
      expect(text.summary).toContain("sold out");
      expect(text.action).toContain("cannot be closed");
      expect(text.action).toContain("trying again will not help");
      expect(text.action).toContain("another table");
      expect(text.action).toContain("Call BOP support now");
      expect(text.action).not.toContain("Nothing changes");
      // With order Workflows refused too, staff read both.
      const all = conditions([refused("DineIn"), refused("Cancellation")]);
      expect(keys(all)).toEqual(["orders.unpaid_rounds", "orders.workflow"]);
      expect(all.get("orders.workflow").params.refused).toBe("DineIn:TwoBrandVersions");
    });
    it("raises after two minutes, and the rule goes nowhere a person reads", () => {
      const c = conditions([refused("Pickup"), refused("DineIn"), refused("Cancellation")]);
      const { state, notifications } = advanceAlertState(emptyAlertState(), c, T0);
      expect(notifications).toEqual([]);
      const raised = advanceAlertState(state, c, T0 + 2 * MIN);
      expect(raised.notifications.map((n) => [n.kind, n.key])).toEqual([
        ["raised", "orders.workflow"],
        ["raised", "orders.unpaid_rounds"],
      ]);
      const board = buildAlertBoard(raised.state, {
        observedAt: new Date(T0).toISOString(),
        channels: [],
        backup: null,
      });
      expect(board.active.map(({ key }) => key).sort()).toEqual([
        "orders.unpaid_rounds",
        "orders.workflow",
      ]);
      expect(JSON.stringify(board)).not.toContain("TwoBrandVersions");
      const message = renderMessage(raised.notifications, {
        siteLabel: "Main St",
        runbookBase: "x",
      });
      expect(JSON.stringify(message)).not.toContain("TwoBrandVersions");
      // A row that has cleared has no state left, and still has a title.
      const gone = advanceAlertState(raised.state, new Map(), T0 + 3 * MIN);
      const cleared = advanceAlertState(gone.state, new Map(), T0 + 6 * MIN);
      expect(
        buildAlertBoard(cleared.state, {
          observedAt: new Date(T0).toISOString(),
          channels: [],
          backup: null,
        }).recentlyCleared.map(({ title }) => title),
      ).toEqual([
        "Order rules check passes again: stay on paper until BOP support says it is fixed",
        "Unpaid rounds check passes again: keep the noted tables until BOP support says it is fixed",
      ]);
      // Services keep the binding they loaded until restarted: the owner's message says to wait.
      for (const batch of [cleared.notifications, cleared.notifications.slice(0, 1)]) {
        const sent = renderMessage(batch, { siteLabel: "Main St", runbookBase: "x" });
        expect(sent.subject).not.toMatch(/Resolved|resolved/u);
        expect(sent.text).not.toMatch(/Resolved/u);
        expect(sent.text).toContain("until BOP support says it is fixed");
      }
      expect(cleared.notifications.map(({ kind }) => kind)).toEqual(["cleared", "cleared"]);
    });
    const board = (state) =>
      buildAlertBoard(state, {
        observedAt: new Date(T0).toISOString(),
        channels: [],
        backup: null,
      });
    const WAIT = "Order rules check passes again: stay on paper until BOP support says it is fixed";
    /** Raised at T0 + 2 min, absent from T0 + 3 min, cleared at T0 + 6 min. */
    const raiseThenClear = (c, options = {}) => {
      const seen = advanceAlertState(emptyAlertState(), c, T0);
      const raised = advanceAlertState(seen.state, c, T0 + 2 * MIN);
      const gone = advanceAlertState(raised.state, new Map(), T0 + 3 * MIN, undefined, options);
      return advanceAlertState(gone.state, new Map(), T0 + 6 * MIN, undefined, options);
    };
    it("a row that only said an order type cannot be turned on clears as resolved, not as paper", () => {
      // The dine-in-only hotpot was told "nothing to do in the store today"; it never went on paper.
      const cleared = raiseThenClear(conditions([refused("Pickup")], ["DineIn"]));
      expect(cleared.notifications.map(({ kind, key }) => [kind, key])).toEqual([
        ["cleared", "orders.workflow"],
      ]);
      expect(board(cleared.state).recentlyCleared.map(({ title }) => title)).toEqual([
        "Pickup cannot be turned on yet",
      ]);
      const sent = renderMessage(cleared.notifications, { siteLabel: "Main St", runbookBase: "x" });
      expect(sent.subject).toBe("Main St: Resolved - Pickup cannot be turned on yet");
      expect(sent.text).not.toMatch(/paper/u);
      // The same refusal while pickup is offered sent staff to paper, and clears as a wait.
      const urgent = raiseThenClear(conditions([refused("Pickup")]));
      expect(board(urgent.state).recentlyCleared.map(({ title }) => title)).toEqual([WAIT]);
    });
    it("a check that could not run is neither a pass nor a clearing", () => {
      const c = conditions([refused("Pickup"), refused("Cancellation")]);
      const seen = advanceAlertState(emptyAlertState(), c, T0);
      let { state } = advanceAlertState(seen.state, c, T0 + 2 * MIN);
      const unreadable = healthy();
      unreadable.business.workflow = "unreadable";
      expect(uncheckedAlertKeys(unreadable)).toEqual(["orders.workflow", "orders.unpaid_rounds"]);
      expect(uncheckedAlertKeys({ ...unreadable, business: "unreadable" })).toEqual([
        "orders.workflow",
        "orders.unpaid_rounds",
      ]);
      expect(uncheckedAlertKeys(healthy())).toEqual([]);
      const timedOut = evaluateAlertConditions(unreadable);
      expect(timedOut.has("orders.workflow")).toBe(false);
      const all = [];
      for (const minutes of [3, 4, 5, 6, 10]) {
        const next = advanceAlertState(state, timedOut, T0 + minutes * MIN, undefined, {
          unchecked: uncheckedAlertKeys(unreadable),
        });
        all.push(...next.notifications);
        state = next.state;
      }
      expect(all.filter(({ kind }) => kind === "cleared")).toEqual([]);
      // BOP hears that the check could not run; the rows stay as they were.
      expect(Object.keys(state.alerts).sort()).toEqual([
        "monitor.source",
        "orders.unpaid_rounds",
        "orders.workflow",
      ]);
      expect(JSON.stringify(board(state))).not.toContain("passes again");
      expect(board(state).active.map(({ key }) => key)).toContain("orders.workflow");
      // Once a check runs and finds it fixed, the usual two minutes still apply from then.
      const passed = advanceAlertState(state, new Map(), T0 + 11 * MIN);
      expect(passed.notifications.filter(({ key }) => key.startsWith("orders."))).toEqual([]);
      expect(
        advanceAlertState(passed.state, new Map(), T0 + 13 * MIN)
          .notifications.filter(({ key }) => key.startsWith("orders."))
          .map(({ kind }) => kind),
      ).toEqual(["cleared", "cleared"]);
    });
    it("the wait line goes when the row is raised again, and when BOP's planned update ends", () => {
      const c = conditions([stale("Pickup")]);
      // (b) Cleared after the file changed, raised again by the restart: never both on Home.
      const cleared = raiseThenClear(c);
      expect(board(cleared.state).recentlyCleared.map(({ title }) => title)).toEqual([WAIT]);
      const back = advanceAlertState(cleared.state, c, T0 + 20 * MIN);
      const again = advanceAlertState(back.state, c, T0 + 22 * MIN);
      expect(again.notifications.map(({ kind }) => kind)).toEqual(["raised"]);
      expect(board(again.state).active.map(({ key }) => key)).toEqual(["orders.workflow"]);
      expect(board(again.state).recentlyCleared).toEqual([]);
      // (a) BOP fixes it inside a planned update: the line stays while it runs and goes after.
      const during = raiseThenClear(c, { plannedUpdate: true });
      expect(board(during.state).recentlyCleared.map(({ title }) => title)).toEqual([WAIT]);
      const still = advanceAlertState(during.state, new Map(), T0 + 30 * MIN, undefined, {
        plannedUpdate: true,
      });
      expect(board(still.state).recentlyCleared.map(({ title }) => title)).toEqual([WAIT]);
      const after = advanceAlertState(still.state, new Map(), T0 + 40 * MIN);
      expect(after.notifications).toEqual([]);
      expect(board(after.state).recentlyCleared).toEqual([]);
      // With no planned update it stays (Home ends it with the business day), and a resolved line
      // of another kind is not touched by an update.
      expect(
        board(advanceAlertState(cleared.state, new Map(), T0 + 40 * MIN).state).recentlyCleared,
      ).toHaveLength(1);
    });
    it("a rule that is not one fixed word never reaches the log", () => {
      expect(
        conditions([refused("Pickup", "guest Sam at table 4")]).get("orders.workflow").params
          .refused,
      ).toBe("Pickup:Refused");
    });
    it('a read that could not run is "could not check", never the alarm itself', () => {
      const o = healthy();
      o.business.workflow = "unreadable";
      expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
      expect(evaluateAlertConditions(o).get("monitor.source").params.sources).toEqual([
        "the check of the store's order rules",
      ]);
    });
  });
  it("says no backup exists until the first one, and nothing about the supervisor during maintenance", () => {
    const o = healthy();
    o.backup = { lastSuccessAt: null };
    o.supervisor = { maintenance: true, reportAgeMs: 0, attention: [] };
    expect(keys(evaluateAlertConditions(o))).toEqual(["backup.stale"]);
  });
});

describe("WP-2423 Q13 deduplication, reminders and clearing", () => {
  const down = (now) => {
    const o = healthy(now);
    o.probes.api = { ok: false, failingForMs: now - T0 };
    return evaluateAlertConditions(o);
  };
  it("raises a probe failure only after it lasts two minutes, once, then reminds after three hours", () => {
    let { state, notifications } = advanceAlertState(emptyAlertState(), down(T0), T0);
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, down(T0 + MIN), T0 + MIN));
    expect(notifications).toEqual([]);
    ({ state, notifications } = advanceAlertState(state, down(T0 + 2 * MIN), T0 + 2 * MIN));
    expect(notifications.map((n) => [n.kind, n.key])).toEqual([["raised", "entry.api"]]);
    for (let m = 3; m < 180; m += 7) {
      ({ state, notifications } = advanceAlertState(state, down(T0 + m * MIN), T0 + m * MIN));
      expect(notifications).toEqual([]);
    }
    ({ notifications } = advanceAlertState(state, down(T0 + 183 * MIN), T0 + 183 * MIN));
    expect(notifications.map((n) => n.kind)).toEqual(["reminder"]);
  });
  it("drops a blip that never reached the raise delay and clears only after two quiet minutes", () => {
    let { state } = advanceAlertState(emptyAlertState(), down(T0), T0);
    let result = advanceAlertState(state, new Map(), T0 + MIN);
    expect(result.state.alerts).toEqual({});
    expect(result.notifications).toEqual([]);
    state = emptyAlertState();
    for (const m of [0, 2, 3])
      state = advanceAlertState(state, down(T0 + m * MIN), T0 + m * MIN).state;
    result = advanceAlertState(state, new Map(), T0 + 4 * MIN);
    expect(result.notifications).toEqual([]);
    // Flapping back within the clear window neither clears nor raises again.
    result = advanceAlertState(result.state, down(T0 + 5 * MIN), T0 + 5 * MIN);
    expect(result.notifications).toEqual([]);
    result = advanceAlertState(result.state, new Map(), T0 + 6 * MIN);
    result = advanceAlertState(result.state, new Map(), T0 + 8 * MIN);
    expect(result.notifications.map((n) => [n.kind, n.key])).toEqual([["cleared", "entry.api"]]);
    expect(result.state.cleared.map((c) => c.key)).toEqual(["entry.api"]);
  });
  it("notifies again when a warning becomes critical", () => {
    const disk = (free) =>
      evaluateAlertConditions({
        ...healthy(),
        disks: [{ name: "runtime", freeBytes: free, totalBytes: 50 * 1024 ** 3 }],
      });
    let r = advanceAlertState(emptyAlertState(), disk(4 * 1024 ** 3), T0);
    expect(r.notifications.map((n) => [n.kind, n.severity])).toEqual([["raised", "warning"]]);
    r = advanceAlertState(r.state, disk(0.5 * 1024 ** 3), T0 + MIN);
    expect(r.notifications.map((n) => [n.kind, n.severity])).toEqual([["escalated", "critical"]]);
  });
  it("persisted state survives a restart without repeating a raised alert", () => {
    let { state } = advanceAlertState(emptyAlertState(), down(T0), T0);
    state = advanceAlertState(state, down(T0 + 2 * MIN), T0 + 2 * MIN).state;
    const restored = JSON.parse(JSON.stringify(state));
    expect(advanceAlertState(restored, down(T0 + 10 * MIN), T0 + 10 * MIN).notifications).toEqual(
      [],
    );
  });
});

describe("what the root says about the other Stores", () => {
  it("leaves a Store's own work to its own board, and keeps the process they share", () => {
    const of = (attention, stores = {}) =>
      evaluateAlertConditions({
        ...healthy(),
        supervisor: { maintenance: false, reportAgeMs: 1000, attention },
        stores,
      }).get("service.attention");
    expect(of(["stores/tea:business-worker:events", "stores/hotpot"])).toBe(undefined);
    expect(of(["store-workers", "stores/tea"]).params.services).toEqual(["store-workers"]);
    expect(of(["business-worker:events", "stores/tea"]).params.services).toEqual([
      "business-worker:events",
    ]);
  });
  it("is unchanged where no Store has a board of its own", () => {
    const conditions = evaluateAlertConditions({
      ...healthy(),
      supervisor: {
        maintenance: false,
        reportAgeMs: 1000,
        attention: ["business-worker:events", "kitchen-queue-worker"],
      },
    });
    expect(conditions.get("service.attention").params.services).toEqual([
      "business-worker:events",
      "kitchen-queue-worker",
    ]);
  });
  it("a Store nobody is checking is its own alert, and the rest is said once by the Store itself", () => {
    const of = (stores) =>
      evaluateAlertConditions({
        ...healthy(),
        stores: {
          unchecked: [],
          checksFailing: [],
          background: [],
          settlementNotCovered: [],
          setupEnding: [],
          noSupportNumber: [],
          ...stores,
        },
      });
    expect(keys(of({}))).toEqual([]);
    const unchecked = of({ unchecked: ["tea"] });
    expect(keys(unchecked)).toEqual(["stores.unchecked"]);
    expect(unchecked.get("stores.unchecked").severity).toBe("critical");
    const rest = of({ noSupportNumber: ["tea"] });
    expect(keys(rest)).toEqual(["stores.attention"]);
    expect(rest.get("stores.attention").severity).toBe("warning");
    const kinds = ["raised", "escalated", "reminder", "cleared"];
    const notified = (key) =>
      kinds.map((kind) => ({ id: kind, kind, key, severity: "critical", params: {}, at: "x" }));
    // BOP hears each time a Store stops being checked and when that is over.
    expect(rootOutboundNotifications(notified("stores.unchecked"))).toHaveLength(4);
    expect(rootOutboundNotifications(notified("stores.attention"))).toEqual([]);
    expect(rootOutboundNotifications(notified("ordering.ending"))).toEqual([]);
    // Everything else the root raises goes out as it always did.
    expect(rootOutboundNotifications(notified("entry.api"))).toHaveLength(4);
  });
});

describe("WP-2423 Q13 rate limiting per channel", () => {
  const item = (n) => ({
    id: String(n),
    kind: "raised",
    key: "disk.low",
    severity: "warning",
    params: { disks: [] },
    at: new Date(T0 + n * MIN).toISOString(),
  });
  it("sends at most six messages an hour, merging what waits into the next message", () => {
    let channel;
    let sent = 0;
    for (let n = 0; n < 20; n++) {
      const plan = planChannelDelivery(channel, [item(n)], T0 + n * MIN);
      channel = plan.channel;
      if (plan.batch.length > 0) {
        sent += 1;
        channel = recordChannelDelivery(channel, true, T0 + n * MIN);
      }
    }
    expect(sent).toBe(6);
    expect(channel.pending).toHaveLength(14);
    const later = planChannelDelivery(channel, [], T0 + 61 * MIN);
    expect(later.batch).toHaveLength(14);
  });
  it("keeps the last two messages of an hour for the installation's own items, and a send takes everything waiting", () => {
    const fromStore = (n) => ({ ...item(n), key: "payment.updates", store: "tea" });
    let channel;
    const sentAt = [];
    for (let n = 0; n < 8; n++) {
      const plan = planChannelDelivery(channel, [fromStore(n)], T0 + n * MIN);
      channel = plan.channel;
      if (plan.batch.length > 0) {
        sentAt.push(n);
        channel = recordChannelDelivery(channel, true, T0 + n * MIN);
      }
    }
    // A Store's items stop at four, and wait.
    expect(sentAt).toEqual([0, 1, 2, 3]);
    expect(channel.pending.map((entry) => entry.id)).toEqual(["4", "5", "6", "7"]);
    // The installation's own item goes out at once, with what waited.
    const own = planChannelDelivery(channel, [item(8)], T0 + 8 * MIN);
    expect(own.batch.map((entry) => entry.id)).toEqual(["4", "5", "6", "7", "8"]);
    channel = recordChannelDelivery(own.channel, true, T0 + 8 * MIN);
    // Another Store item still waits for a slot: one installation message is left this hour.
    const waiting = planChannelDelivery(channel, [fromStore(9)], T0 + 9 * MIN);
    expect(waiting.batch).toEqual([]);
    const last = planChannelDelivery(waiting.channel, [item(10)], T0 + 10 * MIN);
    expect(last.batch.map((entry) => entry.id)).toEqual(["9", "10"]);
    channel = recordChannelDelivery(last.channel, true, T0 + 10 * MIN);
    // The cap itself still holds for everyone.
    expect(planChannelDelivery(channel, [item(11)], T0 + 11 * MIN).batch).toEqual([]);
    // A Store sends again once under four remain from the last hour.
    expect(planChannelDelivery(channel, [fromStore(12)], T0 + 61 * MIN).batch).toEqual([]);
    expect(
      planChannelDelivery(channel, [fromStore(12)], T0 + 63 * MIN).batch.map((entry) => entry.id),
    ).toEqual(["12"]);
  });
  it("a Store nobody is checking does not open the installation's messages either", () => {
    const fromStore = (n) => ({ ...item(n), key: "payment.updates", store: "tea" });
    const unchecked = (n) => ({ ...item(n), key: "stores.unchecked", params: { stores: ["tea"] } });
    let channel;
    for (let n = 0; n < 4; n++) {
      const plan = planChannelDelivery(channel, [fromStore(n)], T0 + n * MIN);
      channel = recordChannelDelivery(plan.channel, true, T0 + n * MIN);
    }
    const held = planChannelDelivery(channel, [unchecked(4)], T0 + 4 * MIN);
    expect(held.batch).toEqual([]);
    // It waits with the rest, and goes out with the next message of the installation's own.
    const own = planChannelDelivery(held.channel, [item(5)], T0 + 5 * MIN);
    expect(own.batch.map((entry) => entry.key)).toEqual(["stores.unchecked", "disk.low"]);
  });
  it("keeps pending items after a failed delivery and records since when the channel fails", () => {
    const plan = planChannelDelivery(undefined, [item(0)], T0);
    const failed = recordChannelDelivery(plan.channel, false, T0);
    expect(failed.pending).toHaveLength(1);
    expect(failed.failingSince).toBe(new Date(T0).toISOString());
    expect(recordChannelDelivery(failed, true, T0 + MIN).failingSince).toBeNull();
  });
});

describe("WP-2423 Q13 messages are plain language and carry no private data", () => {
  it("never echoes source text: only catalog text and typed values reach a message or the board", () => {
    const secret = "guest@example.com 416-555-0199 tok_live_abc postgres://user:pw@db";
    const o = healthy();
    // Hostile values where a careless rule might interpolate them.
    o.supervisor = { maintenance: false, reportAgeMs: 0, attention: [secret, `api:${secret}`] };
    o.business.stuckUpdates = { count: 3, oldestAgeMs: 5 * MIN, detail: secret };
    o.backup = {
      lastSuccessAt: null,
      lastAttempt: { result: "Failed", stage: secret, attemptsLeft: 0 },
    };
    o.disks = [{ name: secret, freeBytes: 1, totalBytes: 100 }];
    const conditions = evaluateAlertConditions(o);
    const { state, notifications } = advanceAlertState(emptyAlertState(), conditions, T0);
    const message = renderMessage(notifications, {
      siteLabel: "Main St",
      runbookBase: "docs/runbooks/single-store-pilot.md",
    });
    const board = buildAlertBoard(state, {
      observedAt: new Date(T0).toISOString(),
      channels: { email: false, webhooks: 0, heartbeat: false },
      backup: null,
    });
    for (const text of [message.subject, message.text, JSON.stringify(board)]) {
      expect(text).not.toMatch(/@|555|tok_|postgres:|pw/u);
    }
    expect(message.subject).toBe("Main St: 4 problems (urgent)");
    expect(message.text).toContain("What to do:");
    expect(message.text).toContain("Runbook: docs/runbooks/single-store-pilot.md#alert-");
  });
  it("says a payment difference is one payment or a day's totals, and where staff resolve each (v15)", () => {
    const one = renderAlert("reconciliation.differences", { count: 1, oldestAgeMs: 2 * 3600_000 });
    expect(one.title).toBe("Payment differences need checking");
    expect(one.summary).toBe(
      "1 difference between the store's records and the payment provider is still open (oldest 2 hours ago). A difference can be one payment or a business day's totals.",
    );
    expect(one.action).toBe(
      "Open Exceptions to see each difference. For a business day's totals, open Settlement and choose that day; it explains the difference and what to do.",
    );
    const many = renderAlert("reconciliation.differences", { count: 3, oldestAgeMs: 5 * MIN });
    expect(many.summary).toMatch(/^3 differences between .* are still open/u);
    // No screen that does not exist in the staff navigation, and no identifiers.
    for (const text of [one.title, one.summary, one.action, many.summary])
      expect(text).not.toMatch(/Payment reconciliation|payment does not match|[0-9a-f]{8}-/u);
    expect(renderAlert("settlement.exceptions", { count: 1, oldestAgeMs: MIN }).action).toContain(
      "Open Settlement",
    );
  });
  it("tells a restaurant owner what to do in plain words, within the board's limit", () => {
    const params = {
      services: ["api"],
      count: 1,
      oldestAgeMs: MIN,
      downMs: MIN,
      coveredMs: 0,
      stage: "dump",
      attemptsLeft: 0,
      ageMs: MIN,
      remainingMs: MIN,
      disks: [{ name: "runtime", freeBytes: 1024, freePercent: 1 }],
      sources: ["disk space"],
      channels: ["email"],
      failingMs: MIN,
      reportAgeMs: MIN,
      // The most the other Stores' summary can name: the board's limit still holds.
      stores: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
      checksFailing: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
      settlementNotCovered: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
      setupEnding: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
      background: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
      noSupportNumber: Array.from({ length: 99 }, (_, i) => `store-${"x".repeat(50)}-${i}`),
    };
    for (const key of ALERT_KEYS)
      for (const audience of ["Installation", "Merchant"]) {
        const { summary, action } = renderAlert(key, params, { audience });
        // The merchant Home refuses a whole board with a longer action or summary.
        expect(action.length, key).toBeLessThanOrEqual(400);
        expect(summary.length, key).toBeLessThanOrEqual(600);
        for (const text of [summary, action])
          expect(text, key).not.toMatch(
            /pilot|container|operator|service log|monitor log|dead-letter|the host\b|\blog\b/iu,
          );
      }
    expect(renderAlert("entry.api", params).action).toContain("Ask BOP support");
    expect(renderAlert("entry.api", params).action).toContain("take paper orders");
    expect(renderAlert("payment.updates", params).action).toContain("Do not take a second payment");
  });
  it("the other Stores' row says only what to do about the causes it names", () => {
    const action = (parts) => renderAlert("stores.attention", parts).action;
    expect(action({ setupEnding: ["tea"] })).toBe(
      "BOP support: renew those named as ending soon, right after the installation itself (their owners hear only in the last day).",
    );
    expect(action({ noSupportNumber: ["tea"] })).toBe(
      "BOP support: set the support number in the alert settings, so their owners have someone to call.",
    );
    // "Checks are not running" only where that is so.
    expect(action({ checksFailing: ["tea"] })).toBe(
      "BOP support: run the status check and find out why the checks named here are not running.",
    );
    expect(renderAlert("stores.unchecked", { stores: ["tea"] }).action).toBe(
      "BOP support: run the status check and find out why the checks named here are not running.",
    );
    expect(action({ setupEnding: ["tea"], background: ["hotpot"] })).toBe(
      "BOP support: restart the background work named here; renew those named as ending soon, right after the installation itself (their owners hear only in the last day).",
    );
    expect(action({})).toBe("BOP support: run the status check.");
  });
  it("puts the whole site being down first at equal severity, where a phone keeps it", () => {
    const at = (minute) => new Date(T0 + minute * MIN).toISOString();
    const fromStore = (store, minute) => ({
      id: `${store}-${minute}`,
      kind: "raised",
      key: "payment.updates",
      severity: "critical",
      params: { count: 1, oldestAgeMs: 5 * MIN },
      at: at(minute),
      store,
    });
    const siteDown = {
      id: "root",
      kind: "raised",
      key: "entry.api",
      severity: "critical",
      params: { downMs: 2 * MIN },
      at: at(7),
    };
    // The reserved case: these have been waiting, so they are ahead of it in the queue.
    let channel;
    for (const [minute, store] of ["tea", "hotpot", "dessert", "demo-2"].entries())
      channel = recordChannelDelivery(
        planChannelDelivery(channel, [fromStore(store, minute)], T0 + minute * MIN).channel,
        true,
        T0 + minute * MIN,
      );
    for (const [minute, store] of [
      [4, "merchant-2"],
      [5, "demo-3"],
      [6, "tea"],
    ])
      channel = planChannelDelivery(channel, [fromStore(store, minute)], T0 + minute * MIN).channel;
    const { batch } = planChannelDelivery(channel, [siteDown], T0 + 7 * MIN);
    expect(batch.map((entry) => entry.store ?? "root")).toEqual([
      "merchant-2",
      "demo-3",
      "tea",
      "root",
    ]);
    const message = renderMessage(batch, { siteLabel: "BOP Pilot", runbookBase: "https://r.test" });
    expect(message.text.indexOf("Store system is not responding")).toBeLessThan(50);
    const said = "Store system is not responding";
    const pushover = buildWebhookRequest(
      { format: "pushover" },
      { token: "t", userKey: "u" },
      message,
    );
    expect(new globalThis.URLSearchParams(pushover.body).get("message")).toContain(said);
    const sms = buildWebhookRequest(
      { format: "twilio-sms", accountSid: "AC1", from: "+14165550100", to: ["+14165550101"] },
      { authToken: "x" },
      message,
    );
    expect(new globalThis.URLSearchParams(sms.perRecipient[0].body).get("Body")).toContain(said);
  });
  it("orders the lines of one severity: the site, the installation's own, then those about one Store", () => {
    const line = (key, extra = {}) => ({
      id: key,
      kind: "raised",
      key,
      severity: "critical",
      at: new Date(T0).toISOString(),
      params: { downMs: MIN, count: 1, oldestAgeMs: MIN, ageMs: MIN, stores: ["tea"] },
      ...extra,
    });
    const { text } = renderMessage(
      [
        line("payment.updates", { store: "tea" }),
        line("stores.unchecked"),
        line("backup.stale"),
        line("entry.customer"),
        // Severity still comes first: a Store's urgent line before the installation's "today".
        line("disk.low", { severity: "warning", params: { disks: [] } }),
      ],
      { siteLabel: "Main St", runbookBase: "x" },
    );
    expect(text.split("\n\n").map((entry) => entry.split(":")[1].trim().split(".")[0])).toEqual([
      "Customer ordering page is not loading",
      "No recent backup",
      "Order or payment updates are stuck",
      "Some Stores are not being checked",
      "Disk space is running low",
    ]);
  });
  it("names the problem in the subject of a single alert, and resolution plainly", () => {
    const o = healthy();
    o.backup = { lastSuccessAt: null };
    const { state, notifications } = advanceAlertState(
      emptyAlertState(),
      evaluateAlertConditions(o),
      T0,
    );
    expect(renderMessage(notifications, { siteLabel: "Main St", runbookBase: "x" }).subject).toBe(
      "Main St: URGENT - No recent backup",
    );
    let cleared = advanceAlertState(state, new Map(), T0 + MIN);
    cleared = advanceAlertState(cleared.state, new Map(), T0 + 3 * MIN);
    const done = renderMessage(cleared.notifications, { siteLabel: "Main St", runbookBase: "x" });
    expect(done.subject).toBe("Main St: Resolved - No recent backup");
    expect(done.severity).toBe("resolved");
  });
  it("WP-2423: warns when orders from earlier days still hold stock, in staff words", () => {
    const o = healthy();
    o.business.heldStock = { count: 0, openCount: 0, oldestAgeMs: 0 };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.heldStock = { count: 11, openCount: 10, oldestAgeMs: 6 * 24 * 60 * MIN };
    const c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["orders.held_stock"]);
    expect(c.get("orders.held_stock").severity).toBe("warning");
    const text = renderAlert("orders.held_stock", c.get("orders.held_stock").params);
    expect(text.title).toBe("Orders from earlier days are still holding stock");
    expect(text.summary).toContain("11 orders from earlier days still have ingredients set aside");
    expect(text.action).toContain("cancel it");
    expect(text.runbook).toBe("alert-orders-held-stock");
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    expect(`${text.title} ${text.summary} ${text.action}`).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
    o.business.heldStock = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
  });
  it("DEC-PICKUP-CAPACITY-SCHEDULE: warns a day before pickup times run out, urgent in the last hour", () => {
    const o = healthy();
    o.business.pickupCapacity = { coveredMs: 14 * 24 * 60 * MIN };
    expect(keys(evaluateAlertConditions(o))).toEqual([]);
    o.business.pickupCapacity = { coveredMs: 20 * 60 * MIN };
    let c = evaluateAlertConditions(o);
    expect(keys(c)).toEqual(["pickup.capacity_horizon"]);
    expect(c.get("pickup.capacity_horizon").severity).toBe("warning");
    let text = renderAlert("pickup.capacity_horizon", c.get("pickup.capacity_horizon").params);
    expect(text.title).toBe("Pickup times are running out");
    expect(text.summary).toContain("only for the next 20 hours");
    expect(text.runbook).toBe("alert-pickup-capacity-horizon");
    o.business.pickupCapacity = { coveredMs: 0 };
    c = evaluateAlertConditions(o);
    expect(c.get("pickup.capacity_horizon").severity).toBe("critical");
    text = renderAlert("pickup.capacity_horizon", c.get("pickup.capacity_horizon").params);
    expect(text.title).toBe("Pickup orders cannot be taken");
    expect(text.action).toContain("on paper");
    for (const value of [text.title, text.summary, text.action])
      expect(value).not.toMatch(/[A-Z]{2,}_[A-Z]|slot|capacity/iu);
    expect(text.summary.length).toBeLessThanOrEqual(600);
    expect(text.action.length).toBeLessThanOrEqual(400);
    o.business.pickupCapacity = "unreadable";
    expect(keys(evaluateAlertConditions(o))).toEqual(["monitor.source"]);
  });
  it("uses the same closed key list as the merchant Home read", () => {
    const api = readFileSync(
      new URL("../../apps/api/src/merchant-operations-alerts.ts", import.meta.url),
      "utf8",
    );
    const listed = [
      ...api
        .slice(api.indexOf("operationsAlertKeys"), api.indexOf("] as const"))
        .matchAll(/"([a-z]+\.[a-z_]+)"/gu),
    ].map((m) => m[1]);
    expect(listed.sort()).toEqual([...ALERT_KEYS].sort());
  });
});

// DEC-PILOT-ALERTS-BACKUP correction 2: what a Store's own board is made of.
describe("a Store's own conditions", () => {
  const store = (change = {}) => ({
    now: T0,
    store: "tea",
    probes: healthy().probes,
    supervisor: healthy().supervisor,
    business: healthy().business,
    installation: { validUntil: new Date(T0 + 30 * 86400_000).toISOString() },
    ...change,
  });
  it("raises nothing about the installation: no backup, certificate, disk or channel", () => {
    expect(keys(evaluateStoreConditions(store()))).toEqual([]);
    // The same observations that the root would raise on.
    expect(
      keys(
        evaluateStoreConditions(
          store({
            backup: { lastSuccessAt: null },
            certificate: { validTo: new Date(T0 + 36 * 3600_000).toISOString() },
            disks: [{ name: "runtime", freeBytes: 1, totalBytes: 100 }],
            channels: [{ kind: "email", failingSince: new Date(T0 - 40 * MIN).toISOString() }],
          }),
        ),
      ),
    ).toEqual([]);
  });
  it("warns a merchant only in the last day before ordering would stop, whichever would stop it", () => {
    const hours = (value) => new Date(T0 + value * 3600_000).toISOString();
    const ending = (change) => evaluateStoreConditions(store(change)).get("ordering.ending");
    // Two weeks to a day out, the renewal is BOP's to do and says nothing to the merchant.
    expect(ending({ installation: { validUntil: hours(25) } })).toBe(undefined);
    expect(evaluateStoreConditions(store({ installation: { validUntil: hours(25) } })).size).toBe(
      1,
    );
    expect(ending({ certificate: { validTo: hours(25) } })).toBe(undefined);
    // With a day left BOP has evidently not renewed it.
    expect(ending({ installation: { validUntil: hours(23) } })).toEqual({
      severity: "critical",
      params: { endsAt: hours(23), remainingMs: 23 * 3600_000 },
    });
    expect(ending({ certificate: { validTo: hours(23) } }).params.remainingMs).toBe(23 * 3600_000);
    // One row, the sooner of the two.
    expect(
      ending({
        installation: { validUntil: hours(20) },
        certificate: { validTo: hours(2) },
      }).params.remainingMs,
    ).toBe(2 * 3600_000);
    // Stopped already: still said, in the words that are true then.
    const stopped = ending({ installation: { validUntil: hours(-1) } });
    expect(renderAlert("ordering.ending", stopped.params).title).toBe(
      "Ordering at this Store has stopped",
    );
    // Neither known: nothing to say about it (BOP hears the reads failed).
    expect(ending({ installation: "unreadable", certificate: "unreadable" })).toBe(undefined);
    expect(ending({ installation: null, certificate: null })).toBe(undefined);
  });
  it("at the root it is for the Store's staff: no row on BOP's board, and no message of its own", () => {
    const hours = (value) => new Date(T0 + value * 3600_000).toISOString();
    const rootOf = (validUntil) => {
      const conditions = evaluateAlertConditions({ ...healthy(), installation: { validUntil } });
      const { state, notifications } = advanceAlertState(emptyAlertState(), conditions, T0);
      return {
        board: buildAlertBoard(state, {
          observedAt: hours(0),
          channels: { email: false, webhooks: 0, heartbeat: false },
          backup: null,
        }),
        sent: rootOutboundNotifications(notifications),
      };
    };
    const far = rootOf(hours(25));
    expect(far.board.active.map((item) => item.key)).toEqual(["installation.validity"]);
    expect(far.board).not.toHaveProperty("orderingEndsAt");
    const near = rootOf(hours(23));
    // BOP's own row says it, and the Store's staff read the instant on their screens.
    expect(near.board.active.map((item) => item.key)).toEqual(["installation.validity"]);
    expect(near.board.orderingEndsAt).toBe(hours(23));
    expect(near.sent.map((item) => item.key)).toEqual(["installation.validity"]);
  });
  it("a Store's board carries when ordering stops only in the last day, and only while raised", () => {
    const hours = (value) => new Date(T0 + value * 3600_000).toISOString();
    const options = {
      observedAt: hours(0),
      channels: { email: false, webhooks: 0, heartbeat: false },
      backup: null,
      audience: "Merchant",
    };
    const boardAt = (validUntil) =>
      buildAlertBoard(
        advanceAlertState(
          emptyAlertState(),
          evaluateStoreConditions(store({ installation: { validUntil } })),
          T0,
        ).state,
        options,
      );
    expect(boardAt(hours(25))).not.toHaveProperty("orderingEndsAt");
    expect(boardAt(hours(23)).orderingEndsAt).toBe(hours(23));
    expect(boardAt(hours(23)).active.map((item) => item.key)).toContain("ordering.ending");
    // Past the end it still says when.
    expect(boardAt(hours(-1)).orderingEndsAt).toBe(hours(-1));
  });
  it("keeps that warning, counting down, while the read behind it cannot run", () => {
    const hours = (value) => new Date(T0 + value * 3600_000).toISOString();
    const previous = {
      alerts: {
        "ordering.ending": {
          raisedAt: hours(-1),
          severity: "critical",
          params: { endsAt: hours(5), remainingMs: 6 * 3600_000 },
        },
      },
    };
    const held = (change) =>
      evaluateStoreConditions(store({ previous, ...change })).get("ordering.ending");
    expect(held({ installation: "unreadable" }).params.remainingMs).toBe(5 * 3600_000);
    expect(held({ certificate: "unreadable" }).params.remainingMs).toBe(5 * 3600_000);
    // Renewed and readable: gone, whatever it said before.
    expect(held({ certificate: null })).toBe(undefined);
  });
  it("gives the same answer as the root for the same business signals", () => {
    const business = {
      stuckUpdates: { count: 2, oldestAgeMs: 10 * MIN },
      retryingUpdates: { count: 1, oldestAgeMs: 40 * MIN },
      reconciliationDifferences: { count: 1, oldestAgeMs: 30 * 3600_000 },
      settlementExceptions: { count: 1, oldestAgeMs: 8 * 3600_000 },
      receiptTemplate: { ready: false, reason: "TemplateNotProven" },
      quoteTax: { ready: false, reason: "TaxConfigurationMismatch" },
      heldStock: { count: 3, openCount: 3, oldestAgeMs: 26 * 3600_000 },
      pickupCapacity: { coveredMs: 0 },
    };
    const root = evaluateAlertConditions({ ...healthy(), business });
    const own = evaluateStoreConditions(store({ business }));
    expect([...own.entries()].sort()).toEqual([...root.entries()].sort());
  });
  it("at the root a settings read that failed still says receipts and pricing are down", () => {
    const held = { ready: false, reason: "StoreConfigurationUnavailable" };
    const business = { ...healthy().business, receiptTemplate: held, quoteTax: held };
    expect(keys(evaluateAlertConditions({ ...healthy(), business }))).toEqual([
      "pricing.tax_configuration",
      "receipts.template",
    ]);
    const own = evaluateStoreConditions(store({ business }));
    expect(keys(own)).toEqual(["monitor.source"]);
    expect(own.get("monitor.source").params.sources).toEqual([
      "the receipt template check",
      "the check that orders can be priced",
    ]);
  });
  it("a failed read of one part names that part, and keeps only what that part said", () => {
    const raisedAt = new Date(T0 - MIN).toISOString();
    const previous = {
      alerts: Object.fromEntries(
        [
          "payment.updates",
          "reconciliation.differences",
          "settlement.exceptions",
          "settlement.not_covered",
        ].map((key) => [
          key,
          { raisedAt, severity: "warning", params: { count: 1, oldestAgeMs: MIN } },
        ]),
      ),
    };
    const held = (business) =>
      evaluateStoreConditions(
        store({ previous, business: { ...healthy().business, ...business } }),
      );
    const scan = held({ settlementExceptions: "unreadable" });
    expect(keys(scan)).toEqual([
      "monitor.source",
      "settlement.exceptions",
      "settlement.not_covered",
    ]);
    expect(scan.get("monitor.source").params.sources).toEqual(["the day-end settlement check"]);
    const differences = held({ reconciliationDifferences: "unreadable" });
    expect(keys(differences)).toEqual(["monitor.source", "reconciliation.differences"]);
    expect(differences.get("monitor.source").params.sources).toEqual([
      "the check for payment differences",
    ]);
    // A closed day that could not be read is not "none yet": no settlement stays told to BOP.
    const closedDay = held({
      settlementExceptions: null,
      settlementCovered: false,
      closedBusinessDay: "unreadable",
    });
    expect(keys(closedDay)).toEqual(["monitor.source", "settlement.not_covered"]);
    expect(closedDay.get("monitor.source").params.sources).toEqual([
      "the check for closed business days",
    ]);
    const none = held({
      settlementExceptions: null,
      settlementCovered: false,
      closedBusinessDay: false,
    });
    expect(keys(none)).toEqual([]);
  });
  it("background chores no guest notices are for today on a Store's board, not Urgent", () => {
    const flagged = (...attention) =>
      evaluateStoreConditions(
        store({ supervisor: { maintenance: false, reportAgeMs: 1000, attention } }),
      ).get("service.attention").severity;
    expect(flagged("stores/tea:business-worker:contactRetention")).toBe("warning");
    expect(
      flagged(
        "stores/tea:business-worker:contactRetention",
        "stores/tea:business-worker:webhookEvidenceRetention",
      ),
    ).toBe("warning");
    // Anything guests or staff would notice keeps it Urgent.
    expect(
      flagged("stores/tea:business-worker:contactRetention", "stores/tea:business-worker:events"),
    ).toBe("critical");
    expect(flagged("stores/tea")).toBe("critical");
    expect(flagged("store-workers")).toBe("critical");
    // BOP's own board is unchanged.
    expect(
      evaluateAlertConditions({
        ...healthy(),
        supervisor: {
          maintenance: false,
          reportAgeMs: 1000,
          attention: ["business-worker:contactRetention"],
        },
      }).get("service.attention").severity,
    ).toBe("critical");
  });
  it("sends BOP only what is that Store's own", () => {
    const item = (key, params = {}) => ({
      id: key,
      kind: "raised",
      key,
      severity: "warning",
      params,
      at: "x",
    });
    const own = [
      "payment.updates",
      "updates.retrying",
      "receipts.template",
      "pricing.tax_configuration",
      "orders.held_stock",
      "pickup.capacity_horizon",
      "reconciliation.differences",
      "settlement.exceptions",
      "settlement.not_covered",
      "installation.validity",
    ].map((key) => item(key));
    const shared = [
      item("entry.api"),
      item("entry.customer"),
      item("entry.merchant"),
      item("service.attention", { services: ["store-background"], sharedHost: true }),
      item("monitor.source", { sources: ["the service status"] }),
    ];
    const sent = storeOutboundNotifications(
      [
        ...own,
        ...shared,
        item("service.attention", { services: ["business-worker:events"], sharedHost: false }),
        item("monitor.source", { sources: ["the service status", "disk space"] }),
      ],
      "tea",
    );
    expect(sent.map((entry) => entry.key).sort()).toEqual(
      [...own.map((entry) => entry.key), "monitor.source", "service.attention"].sort(),
    );
    expect(sent.every((entry) => entry.store === "tea")).toBe(true);
  });
  // Two decisions each alert needs on a Store's board. Written out: a new key in the catalog fails
  // here until someone has made them, rather than silently never reaching BOP or clearing unread.
  it("every alert of the catalog is decided: whether BOP hears it for a Store, and whether it stays unread", () => {
    const decisions = {
      "entry.api": { sent: false, stays: false },
      "entry.customer": { sent: false, stays: false },
      "entry.merchant": { sent: false, stays: false },
      "supervisor.silent": { sent: false, stays: false },
      "service.attention": { sent: true, stays: true },
      "payment.updates": { sent: true, stays: true },
      "updates.retrying": { sent: true, stays: true },
      "receipts.template": { sent: true, stays: true },
      "pricing.tax_configuration": { sent: true, stays: true },
      "orders.workflow": { sent: true, stays: true },
      "orders.unpaid_rounds": { sent: true, stays: true },
      "orders.held_stock": { sent: true, stays: true },
      "pickup.capacity_horizon": { sent: true, stays: true },
      "reconciliation.differences": { sent: true, stays: true },
      "settlement.exceptions": { sent: true, stays: true },
      "settlement.not_covered": { sent: true, stays: true },
      "stores.unchecked": { sent: false, stays: false },
      "stores.attention": { sent: false, stays: false },
      "backup.failed": { sent: false, stays: false },
      "backup.stale": { sent: false, stays: false },
      "backup.restore_check": { sent: false, stays: false },
      "backup.offsite": { sent: false, stays: false },
      "certificate.expiring": { sent: false, stays: false },
      "installation.validity": { sent: true, stays: false },
      "ordering.ending": { sent: false, stays: true },
      "disk.low": { sent: false, stays: false },
      "monitor.source": { sent: true, stays: true },
      "channel.delivery": { sent: false, stays: false },
    };
    expect(Object.keys(decisions).sort()).toEqual([...ALERT_KEYS].sort());
    const raisedBefore = (key) => ({
      alerts: {
        [key]: {
          raisedAt: new Date(T0 - MIN).toISOString(),
          severity: "warning",
          params: { endsAt: new Date(T0 + MIN).toISOString() },
        },
      },
    });
    for (const [key, decided] of Object.entries(decisions)) {
      const sent = storeOutboundNotifications(
        [{ id: key, kind: "raised", key, severity: "warning", params: {}, at: "x" }],
        "tea",
      );
      const stays = evaluateStoreConditions(
        store({
          supervisor: "unreadable",
          business: "unreadable",
          installation: "unreadable",
          certificate: "unreadable",
          previous: raisedBefore(key),
        }),
      ).has(key);
      expect({ sent: sent.length === 1, stays }, key).toEqual(decided);
    }
  });
  it("names the Store on each line and in a single alert's subject, and only a Store's name", () => {
    const base = { kind: "raised", key: "payment.updates", severity: "critical", at: "x" };
    const params = { count: 1, oldestAgeMs: MIN };
    const config = { siteLabel: "Main St", runbookBase: "x" };
    const one = renderMessage([{ ...base, params, store: "tea" }], config);
    expect(one.subject).toBe("Main St · tea: URGENT - Order or payment updates are stuck");
    expect(one.text).toMatch(/^tea - Problem \(urgent\)/u);
    const hostile = renderMessage([{ ...base, params, store: "guest@example.com" }], config);
    expect(`${hostile.subject} ${hostile.text}`).not.toContain("guest@");
    const none = renderMessage([{ ...base, params }], config);
    expect(none.subject).toBe("Main St: URGENT - Order or payment updates are stuck");
    expect(none.text).toMatch(/^Problem \(urgent\)/u);
  });
});
