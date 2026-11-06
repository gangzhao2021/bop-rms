import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import type { OwnNameClient, OwnNameState } from "./OwnNamePrompt.js";
import { staffIdentityText, staffNameStoreFor, StaffIdentityLine } from "./StaffIdentityLine.js";

afterEach(() => setLanguageForTest("en"));

const client = (state: OwnNameState): OwnNameClient & { read: ReturnType<typeof vi.fn> } => ({
  read: vi.fn(() => Promise.resolve(state)),
  save: () => Promise.reject(new Error("not used")),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("M61: the frame says who is signed in", () => {
  it("names the person and how they signed in, in English and Chinese", () => {
    const sam = { name: "Recorded", displayName: "Sam" } as const;
    expect(staffIdentityText(sam, "Pin")).toBe("Sam · signed in with PIN");
    expect(staffIdentityText(sam, "Account")).toBe("Sam · signed in");
    expect(staffIdentityText({ name: "Missing", profileVersion: 0 }, "Account")).toBe(
      "Name not added yet · signed in",
    );
    expect(staffIdentityText({ name: "NotStoreMember" }, "Pin")).toBeNull();
    setLanguageForTest("zh-Hans");
    expect(staffIdentityText(sam, "Pin")).toBe("Sam · 已用 PIN 登录");
    expect(staffIdentityText(sam, "Account")).toBe("Sam · 已登录");
  });

  it("shows nothing until the name is read, never a guess", () => {
    const html = renderToStaticMarkup(
      <StaffIdentityLine
        csrf={"q".repeat(43)}
        storeReference="store-a"
        nameClient={client({ name: "Recorded", displayName: "Sam" })}
      />,
    );
    expect(html).toBe("");
  });

  it("reads the name again after a Store switch with the same sign-in", async () => {
    const csrf = "s".repeat(43);
    const atA = client({ name: "Recorded", displayName: "Sam" });
    const storeA = staffNameStoreFor(csrf, "store-a", atA);
    const stopA = storeA.subscribe(() => undefined);
    await settle();
    expect(storeA.get()).toEqual({
      kind: "Ready",
      state: { name: "Recorded", displayName: "Sam" },
    });
    // The display name is a per-Store member fact: the same csrf at another Store is another read.
    const atB = client({ name: "Recorded", displayName: "Samuel" });
    const storeB = staffNameStoreFor(csrf, "store-b", atB);
    expect(storeB).not.toBe(storeA);
    const stopB = storeB.subscribe(() => undefined);
    await settle();
    expect(atB.read).toHaveBeenCalledTimes(1);
    expect(storeB.get()).toEqual({
      kind: "Ready",
      state: { name: "Recorded", displayName: "Samuel" },
    });
    // The same Store again under the same sign-in reuses one read (sidebar and compact menu).
    expect(staffNameStoreFor(csrf, "store-b")).toBe(storeB);
    stopA();
    stopB();
  });

  it("omits the line when the read fails", async () => {
    const failing: OwnNameClient = {
      read: () => Promise.reject(new Error("offline")),
      save: () => Promise.reject(new Error("not used")),
    };
    const store = staffNameStoreFor("f".repeat(43), "store-a", failing);
    const stop = store.subscribe(() => undefined);
    await settle();
    expect(store.get()).toEqual({ kind: "Failed" });
    stop();
  });
});
