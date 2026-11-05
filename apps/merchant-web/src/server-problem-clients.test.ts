import { describe, expect, it } from "vitest";
import { createCurrentOrderQueueClient } from "./current-order-queue-client.js";
import { createDiningSessionClient } from "./dining-session-client.js";
import { isServerProblem } from "./failure-words.js";
import { setLanguageForTest, t } from "./i18n/i18n.js";
import { MenuPageError } from "./store-menu-pages.js";
import { createTableCheckoutClient } from "./table-checkout-client.js";
import { oneStoreSaveFailureText, oneStoreSaveMayContinue } from "./one-store-save-words.js";
import { menuErrorText } from "./StoreMenuPages.js";
import { zhHans } from "./i18n/zh-Hans.js";
import {
  floorServerProblemText,
  notConfirmedPressAgainText,
  serverProblemText,
  tableChangedText,
} from "./failure-words.js";

/**
 * WP-2423 item 10: a server failure read as the restaurant's own wifi sends someone to the router
 * in the middle of service, so the floor clients tell "the server answered and failed" from "no
 * answer", and "the table moved on" from "you may not".
 */
const csrf = "a".repeat(43);
const answer = (status: number, body: unknown = { error: "retry_later" }) =>
  (async () => Response.json(body, { status })) as unknown as typeof fetch;
const noAnswer = (async () => {
  throw new TypeError("network");
}) as unknown as typeof fetch;

describe("the Tables client", () => {
  it("tells a server failure from no answer, on a read", async () => {
    await expect(createDiningSessionClient(answer(503)).tables(csrf)).rejects.toMatchObject({
      code: "ServerProblem",
    });
    await expect(createDiningSessionClient(noAnswer).tables(csrf)).rejects.toMatchObject({
      code: "Unavailable",
    });
  });

  it("only a 401 or 403 is a refusal; a 409 means the table moved on", async () => {
    await expect(
      createDiningSessionClient(answer(403, { error: "request_denied" })).tables(csrf),
    ).rejects.toMatchObject({ code: "Denied" });
    await expect(
      createDiningSessionClient(answer(409, { error: "changed_while_loading" })).tables(csrf),
    ).rejects.toMatchObject({ code: "Changed" });
  });
});

describe("the Orders client", () => {
  it("tells a server failure from no answer", async () => {
    const failed = await createCurrentOrderQueueClient(answer(503))
      .load(null, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(isServerProblem(failed)).toBe(true);
    const lost = await createCurrentOrderQueueClient(noAnswer)
      .load(null, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(isServerProblem(lost)).toBe(false);
  });
});

describe("the table checkout client", () => {
  it("a server failure may have been recorded, whichever body it came with", async () => {
    for (const body of [{ error: "retry_later" }, { error: "unavailable" }, {}])
      await expect(
        createTableCheckoutClient(answer(503, body)).bill(csrf, "x"),
      ).rejects.toMatchObject({ code: "ServerProblem" });
    await expect(createTableCheckoutClient(noAnswer).bill(csrf, "x")).rejects.toMatchObject({
      code: "OutcomeUnknown",
    });
  });
});

describe("a one-page save that stopped", () => {
  it.each(["Offline", "Unavailable", "StoppedPartWay"] as const)(
    "%s goes again as the same operation",
    (code) => {
      expect(oneStoreSaveMayContinue(new MenuPageError(code))).toBe(true);
    },
  );
  it.each(["PermissionDenied", "Conflict", "NotFound", "Invalid"] as const)(
    "%s starts a new one",
    (code) => {
      expect(oneStoreSaveMayContinue(new MenuPageError(code))).toBe(false);
    },
  );
  it("tells an existing item it stopped part-way, and claims nothing about a new one", () => {
    const failed = new MenuPageError("Unavailable");
    expect(oneStoreSaveFailureText(failed, true)).toBe(menuErrorText.StoppedPartWay);
    expect(oneStoreSaveFailureText(failed, false)).toBe(serverProblemText);
  });
  it("never tells the Owner to tell the manager", () => {
    expect(menuErrorText.StoppedPartWay).not.toContain("manager");
  });
});

describe("the words", () => {
  const words = [
    serverProblemText,
    floorServerProblemText,
    notConfirmedPressAgainText,
    tableChangedText,
  ];
  it("never blame the person's permissions or their connection", () => {
    for (const text of words) {
      expect(text.toLowerCase()).not.toContain("permission");
      expect(text.toLowerCase()).not.toContain("connection");
    }
  });
  it("are in Chinese too", () => {
    for (const text of words) expect(zhHans[text]).toBeDefined();
    setLanguageForTest("zh-Hans");
    expect(t("This screen isn't working")).toBe("这个页面暂时用不了");
    setLanguageForTest("en");
  });
});
