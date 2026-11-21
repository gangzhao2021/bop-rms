import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearUnansweredCounterSend,
  keepUnansweredCounterSend,
  loadUnansweredCounterSend,
  paperPaymentDigest,
} from "./counter-unanswered-send.js";

const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

// DEC-PAPER-SEND-IDEMPOTENT: a counter send with no answer survives a reload of the page.
describe("counter: an unanswered send kept for the Store", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
  });
  const send = {
    operationReference: id(1),
    sentAt: "2026-11-11T20:00:00.000Z",
    recordedAfterOutage: true,
    paperPayment: {
      digest: paperPaymentDigest('["x","CardMachine","SLIP",null]'),
      reference: id(2),
    },
  };

  it("keeps it per Store until it is answered, and drops it after three days", () => {
    keepUnansweredCounterSend("store-1", send);
    const now = Date.parse(send.sentAt) + 60_000;
    expect(loadUnansweredCounterSend("store-1", now)).toEqual(send);
    expect(loadUnansweredCounterSend("store-2", now)).toBeNull();
    expect(
      loadUnansweredCounterSend("store-1", Date.parse(send.sentAt) + 73 * 3_600_000),
    ).toBeNull();
    // Dropped, not kept for later.
    expect(store.size).toBe(0);
    keepUnansweredCounterSend("store-1", send);
    clearUnansweredCounterSend("store-1");
    expect(loadUnansweredCounterSend("store-1", now)).toBeNull();
  });

  it("keeps no slip, and a changed slip, time or tender is another digest", () => {
    keepUnansweredCounterSend("store-1", send);
    expect([...store.values()].join()).not.toContain("SLIP");
    expect(paperPaymentDigest('["x","CardMachine","SLIP",null]')).toBe(send.paperPayment.digest);
    expect(paperPaymentDigest('["x","CardMachine","SLIP2",null]')).not.toBe(
      send.paperPayment.digest,
    );
  });

  it("ignores what it can't read, and works without the browser's storage", () => {
    store.set("bop.counter.unansweredSend.v1.store-1", "{not json");
    expect(loadUnansweredCounterSend("store-1")).toBeNull();
    store.set(
      "bop.counter.unansweredSend.v1.store-1",
      JSON.stringify({ ...send, operationReference: "not-a-reference" }),
    );
    expect(loadUnansweredCounterSend("store-1")).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => keepUnansweredCounterSend("store-1", send)).not.toThrow();
    expect(loadUnansweredCounterSend("store-1")).toBeNull();
    expect(() => clearUnansweredCounterSend("store-1")).not.toThrow();
  });
});
