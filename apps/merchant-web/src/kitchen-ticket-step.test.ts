import { describe, expect, it } from "vitest";
import {
  kitchenLineFinishable,
  kitchenLineNeedsStartFirst,
  kitchenTicketNextStep,
  kitchenTicketRounds,
  kitchenTicketStartStep,
  kitchenTicketState,
  kitchenTicketShownState,
  kitchenRoundNumbers,
} from "./KitchenBoardPages.js";
import type { KitchenBoardItem } from "./kitchen-board.js";

const ref = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString().padStart(12, "0");
function item(
  n: number,
  status: KitchenBoardItem["status"],
  o: { accepted?: boolean; done?: number; ready?: boolean } = {},
): KitchenBoardItem {
  return {
    workItemReference: ref(n),
    ticketReference: ref(900),
    orderReference: ref(901),
    stationLabel: null,
    displayName: `TEST dish ${n}`,
    status,
    requiredQuantity: 2,
    completedQuantity: o.done ?? 0,
    createdAt: "2026-10-26T22:00:00.000Z",
    allergenCue: "Unavailable",
    exceptionStatus: "Unavailable",
    selectedOptions: [],
    execution: {
      orderItemReference: ref(n + 100),
      stationReference: ref(902),
      ticketVersion: "3",
      workItemVersion: "1",
      acceptedAt: o.accepted || status !== "Queued" ? "2026-10-26T22:01:00.000Z" : null,
      readyAt: o.ready ? "2026-10-26T22:05:00.000Z" : null,
    },
  } as KitchenBoardItem;
}

const roundItem = (
  n: number,
  status: KitchenBoardItem["status"],
  ticket: number,
  createdAt: string,
): KitchenBoardItem => ({ ...item(n, status), ticketReference: ref(ticket), createdAt });

describe("DEC-KITCHEN-ONE-TAP: one main step per ticket", () => {
  it("a new ticket offers Finished and Start, never Accept", () => {
    const fresh = [item(1, "Queued")];
    expect(kitchenTicketNextStep(fresh)).toMatchObject({ kind: "Finish", label: "Finished" });
    expect(kitchenTicketStartStep(fresh)?.label).toBe("Start cooking");
    const several = [item(1, "Queued"), item(2, "Queued")];
    expect(kitchenTicketNextStep(several)).toMatchObject({ kind: "Finish", label: "All finished" });
    expect(kitchenTicketStartStep(several)?.label).toBe("Start all");
    expect(
      [kitchenTicketNextStep(several)?.label, kitchenTicketStartStep(several)?.label].join(" "),
    ).not.toMatch(/accept/iu);
  });
  it("a combo's foot button says all when it finishes more than one of its dishes", () => {
    const part = (n: number, done: boolean) => ({
      optionReference: ref(500 + n),
      nameZh: `菜${n}`,
      name: `Dish ${n}`,
      done,
      served: false,
    });
    const combo = (parts: ReturnType<typeof part>[]) => [
      { ...item(1, "Queued"), comboParts: parts } as KitchenBoardItem,
    ];
    // Under two dish buttons, a plain "Finished" would read as one of them.
    expect(kitchenTicketNextStep(combo([part(1, false), part(2, false)]))?.label).toBe(
      "All finished",
    );
    // One dish left: the foot button finishes exactly that one.
    expect(kitchenTicketNextStep(combo([part(1, true), part(2, false)]))?.label).toBe("Finished");
    // Every dish done but the combo still open: one thing to finish.
    expect(kitchenTicketNextStep(combo([part(1, true), part(2, true)]))?.label).toBe("Finished");
  });
  it("a five-dish table takes five taps and the first dish needs no Start", () => {
    const table = [1, 2, 3, 4, 5].map((n) => item(n, "Queued"));
    // Every unfinished dish has its own Done from the moment the ticket appears.
    expect(table.every(kitchenLineFinishable)).toBe(true);
    // After the first dish, the others stay in the same state with the same buttons.
    const afterOne = [{ ...item(1, "Completed", { done: 2, ready: true }) }, ...table.slice(1)];
    expect(afterOne.slice(1).every(kitchenLineFinishable)).toBe(true);
    expect(kitchenTicketNextStep(afterOne)?.items).toHaveLength(4);
    // A dish in progress and a dish not started are finished the same way.
    expect(kitchenLineFinishable(item(1, "In Progress"))).toBe(true);
    expect(kitchenLineFinishable(item(1, "Queued"))).toBe(true);
  });
  it("the main button leaves a newer round alone when nothing is started", () => {
    const first = [
      roundItem(1, "Queued", 900, "2026-10-26T22:00:00.000Z"),
      roundItem(2, "Queued", 900, "2026-10-26T22:00:00.000Z"),
    ];
    const later = [roundItem(3, "Queued", 910, "2026-10-26T22:20:00.000Z")];
    const step = kitchenTicketNextStep([...first, ...later]);
    expect(step?.kind).toBe("Finish");
    // Batch 63 (F51): it says which round it closes (it sits under the newer round).
    expect(step?.label).toBe("Round 1 finished");
    expect(step?.items.map((entry) => entry.displayName)).toEqual(["TEST dish 1", "TEST dish 2"]);
    expect(kitchenTicketStartStep([...first, ...later])?.items).toHaveLength(2);
    // Its own round's turn comes when the round above is done.
    const done = first.map((entry) => ({
      ...entry,
      status: "Completed" as const,
      completedQuantity: 2,
      ...(entry.execution
        ? { execution: { ...entry.execution, readyAt: "2026-10-26T22:05:00.000Z" } }
        : {}),
    }));
    expect(
      kitchenTicketNextStep([...done, ...later])?.items.map((entry) => entry.displayName),
    ).toEqual(["TEST dish 3"]);
    expect(kitchenTicketRounds([...later, ...first]).map((round) => round.items.length)).toEqual([
      2, 1,
    ]);
  });
  it("skips finished and cancelled items and items with no kitchen steps here", () => {
    const noSteps: KitchenBoardItem = { ...item(4, "Queued") };
    delete (noSteps as { execution?: unknown }).execution;
    expect(kitchenTicketNextStep([noSteps, item(5, "Cancelled")])).toBeNull();
    expect(
      kitchenTicketNextStep([
        item(1, "Completed", { done: 2, ready: true }),
        item(2, "In Progress"),
      ])?.items,
    ).toHaveLength(1);
  });
  it("marks ready what is complete and not ready when Expo holds it", () => {
    expect(kitchenTicketNextStep([item(1, "Completed", { done: 2 })])).toMatchObject({
      kind: "MarkReady",
    });
    expect(kitchenTicketNextStep([item(1, "Completed", { done: 2, ready: true })])).toBeNull();
  });
  it("a dish whose allergens need checking starts first: Done only comes after Start", () => {
    const review = { ...item(1, "Queued"), allergenCue: "ReviewRequired" as const };
    expect(kitchenLineNeedsStartFirst(review)).toBe(true);
    expect(kitchenTicketNextStep([review, item(2, "Queued")])).toMatchObject({
      kind: "Start",
      label: "Start cooking",
    });
    expect(kitchenLineNeedsStartFirst({ ...review, status: "In Progress" })).toBe(false);
    expect(kitchenTicketNextStep([{ ...review, status: "In Progress" }])?.kind).toBe("Finish");
  });
  it("accepted but not started is To make: the screen says what is left, not whether a pan is on", () => {
    expect(kitchenTicketState([item(1, "Queued")])).toBe("ToMake");
    expect(kitchenTicketState([item(1, "Queued", { accepted: true })])).toBe("ToMake");
    expect(kitchenTicketState([item(1, "Queued"), item(2, "In Progress")])).toBe("Making");
    expect(kitchenTicketState([item(1, "Completed", { done: 2, ready: true })])).toBe("Done");
  });
  it("a chosen dish of a combo reads to make whatever its combo's status, and has no Start", () => {
    const line = {
      ...item(1, "In Progress"),
      comboPartOf: { comboName: "TEST set", optionReference: ref(7), done: false, stillToMake: [] },
    };
    expect(kitchenTicketState([line])).toBe("ToMake");
    expect(kitchenTicketStartStep([{ ...line, status: "Queued" as const }])).toBeNull();
    expect(kitchenLineFinishable(line)).toBe(true);
    expect(
      kitchenLineFinishable({ ...line, comboPartOf: { ...line.comboPartOf, done: true } }),
    ).toBe(false);
  });
});

describe("WP-2423 batch 63 (F51): the status line agrees with a held Start at once", () => {
  it("reads Being made while Start is held for Undo or on its way, and To make again if it failed", () => {
    const queued = [item(1, "Queued"), item(2, "Queued")];
    expect(kitchenTicketShownState(queued, [])).toBe("ToMake");
    for (const phase of ["Holding", "Waiting", "Sending", "Retrying"] as const)
      expect(kitchenTicketShownState(queued, [{ step: "Start", phase }])).toBe("Making");
    expect(kitchenTicketShownState(queued, [{ step: "Start", phase: "Failed" }])).toBe("ToMake");
    // A held Done does not say Being made; the server's answer moves it on.
    expect(kitchenTicketShownState(queued, [{ step: "Finish", phase: "Holding" }])).toBe("ToMake");
  });
});

describe("WP-2423 batch 64 (v15 b63 live, F51): a two-round ticket says which round is closed and which is left", () => {
  // Order 40 at K63 A: two staff rounds of one dish each. The foot button read a plain
  // "Finished"; it finished round 1 (SQL), round 2 then stood alone with no "Added" heading.
  const round1 = roundItem(1, "Queued", 900, "2026-10-26T22:00:00.000Z");
  const round2 = roundItem(2, "Queued", 910, "2026-10-26T22:20:00.000Z");
  it("names the round on its foot button whatever the round's dish count", () => {
    expect(kitchenTicketNextStep([round1, round2])?.label).toBe("Round 1 finished");
  });
  it("keeps the round's number once the round before it has left the board", () => {
    const seen = new Map<string, string[]>();
    const both = kitchenTicketRounds([round1, round2]);
    expect([...kitchenRoundNumbers(seen, ref(901), both).values()]).toEqual([1, 2]);
    const left = kitchenTicketRounds([round2]);
    const numbers = kitchenRoundNumbers(seen, ref(901), left);
    expect(numbers.get(ref(910))).toBe(2);
    expect(kitchenTicketNextStep([round2], numbers)?.label).toBe("Round 2 finished");
    // A ticket of one round, never seen with another, keeps its plain label.
    expect(kitchenTicketNextStep([round1], new Map([[ref(900), 1]]))?.label).toBe("Finished");
  });
  it("the status says what is left while a Finished is held for Undo", () => {
    const tap = { step: "Finish" as const, phase: "Holding" as const };
    // The whole ticket marked done: Done, never To make under "Marked done · Undo".
    expect(kitchenTicketShownState([round1], [tap], () => tap)).toBe("Done");
    // Round 1 marked done: round 2 is still to make, and that is what the status says.
    const held = (entry: KitchenBoardItem) => (entry === round1 ? tap : undefined);
    expect(kitchenTicketShownState([round1, round2], [tap], held)).toBe("ToMake");
    const making = { ...round2, status: "In Progress" as const };
    expect(
      kitchenTicketShownState([round1, making], [tap], (e) => (e === round1 ? tap : undefined)),
    ).toBe("Making");
    // A failed tap changes nothing.
    const failed = { step: "Finish" as const, phase: "Failed" as const };
    expect(kitchenTicketShownState([round1], [failed], () => failed)).toBe("ToMake");
  });
});
