import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCustomerCartClient, setCustomerCartCsrfCredential } from "./cart-client.js";
import { CartClientError } from "./types.js";
import {
  getParticipationEnded,
  setCustomerCsrfCredential,
  setParticipationEnded,
} from "../session/customer-transaction-context.js";
import { cartText, participationEndedText } from "../journey/messages.js";
import { zhHans as zh } from "../i18n/zh-Hans.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageRoot } from "../i18n/i18n.js";

const ended = (reason: string) =>
  new Response(
    JSON.stringify({
      schemaVersion: 1,
      error: {
        code: "cart_participant_ended",
        messageKey: "customer.cart.participant_ended",
        reason,
      },
    }),
    { status: 409 },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCartCsrfCredential(null);
  setParticipationEnded(null);
});

describe("M126 I.2: a phone whose place at the table ended is told why", () => {
  it.each(["Left", "TableClosed", "Changed"] as const)(
    "reads %s from the Store's answer, never as an expired visit",
    async (reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ended(reason)),
      );
      const failure = await createBrowserCustomerCartClient()
        .loadCurrent()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CartClientError);
      expect((failure as CartClientError).code).toBe("cart_participant_ended");
      expect(getParticipationEnded()).toBe(reason);
    },
  );

  it("an answer with no reason it knows still isn't an expired visit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ended("Other")),
    );
    const failure = await createBrowserCustomerCartClient()
      .loadCurrent()
      .catch((error: unknown) => error);
    expect((failure as CartClientError).code).toBe("cart_participant_ended");
    expect(getParticipationEnded()).toBeNull();
    expect(participationEndedText()[0]).toBe("This phone is no longer at this table");
  });

  it("says each reason in plain words, in English and Chinese, and a new visit forgets it", () => {
    setParticipationEnded("TableClosed");
    expect(cartText.failure.participationEnded).toEqual([
      "This table’s visit has ended",
      "Open your table to see its bill and receipt.",
    ]);
    setParticipationEnded("Changed");
    expect(participationEndedText()[1]).toBe("Open your table to see where your party is now.");
    for (const reason of ["Left", "TableClosed", "Changed"] as const) {
      setParticipationEnded(reason);
      for (const text of participationEndedText()) {
        expect(zh[text], text).toBeTruthy();
        expect(text.toLowerCase()).not.toMatch(/expired|session|scan the location/u);
      }
    }
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    try {
      setParticipationEnded("Changed");
      expect(participationEndedText()[0]).toBe("你们换桌了");
    } finally {
      renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
    }
    setCustomerCsrfCredential("c".repeat(43));
    expect(getParticipationEnded()).toBeNull();
  });
});
