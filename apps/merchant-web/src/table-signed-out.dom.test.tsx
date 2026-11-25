// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { buttonNamed, click, mount, selectValue, until } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { setStaffSessionEnded } from "./staff-session-reads.js";
import {
  TableMerge,
  TableMergeError,
  createTableMergeClient,
  type TableMergeClient,
} from "./TableMerge.js";
import { TableSessionClose } from "./TableSessionClose.js";
import type { StaffDiningTable } from "./dining-session-client.js";

/**
 * Batch 64 (v15 b63 live, TM2): the shared owner sign-in was pushed out by other screens. Right
 * after that a Merge answered 403 and said "Your role can't merge tables. Ask the owner or a
 * manager.", and the Close section told the Owner "以你当前的权限无法检查这张桌台的订单。请店主或店长关台。"
 * while the checkout above said the sign-in had ended. Refused because the sign-in ended, they say
 * to sign in again; a real role refusal (signed in) still says the role.
 */
const id = (n: number) => "01a4d564-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const seated = (n: number, label: string): StaffDiningTable =>
  ({
    tableReference: id(n),
    stableLabel: label,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: id(n + 50),
    elapsedMinutes: 5,
    qrCodeValidUntil: null,
    paymentTiming: "PayLater",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    session: { phase: "Active", version: 4, orderReference: id(n + 80), paymentStarted: false },
  }) as unknown as StaffDiningTable;
const a = seated(1, "T63 A"),
  b = seated(2, "T63 B");

afterEach(() => {
  setStaffSessionEnded(false);
  setLanguageForTest("en");
  document.body.innerHTML = "";
});

async function tapMerge(client: TableMergeClient) {
  const { container } = await mount(
    <TableMerge
      table={a}
      tables={[a, b]}
      csrf={csrf}
      locked={false}
      onMerged={() => undefined}
      client={client}
      tea={vi.fn()}
    />,
  );
  await selectValue(container.querySelector("select"), b.tableReference);
  await click(buttonNamed(container, /T63 B/u));
  await until(() => container.querySelector('[role="alert"]') !== null);
  return container;
}
const refused = (code: "Denied" | "SignedOut"): TableMergeClient => ({
  merge: () => Promise.reject(new TableMergeError(code)),
});

describe("batch 64: a merge refused after a forced sign-out", () => {
  it("says to sign in again once the signed-out cover is up, not that the role can't merge", async () => {
    const container = await tapMerge(refused("Denied"));
    // Still signed in: a real refusal of the role.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Your role can't merge tables. Ask the owner or a manager.",
    );
    // The guard finds the sign-in ended (the cover goes up): the same refusal now says why.
    await act(async () => setStaffSessionEnded(true));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Your sign-in on this screen has ended, so this wasn't sent. Sign in again, then try again.",
    );
  });
  it("a 401 is a sign-in that ended, in Chinese too", async () => {
    setLanguageForTest("zh-Hans");
    const client = createTableMergeClient(async () => new Response(null, { status: 401 }));
    await expect(
      client.merge(csrf, {
        operationReference: id(90),
        tableReference: a.tableReference,
        expectedTableVersion: 2,
        targetTableReference: b.tableReference,
        expectedTargetTableVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "SignedOut" });
    const container = await tapMerge(refused("SignedOut"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "这台设备上的登录已结束，所以这次没有发送。请重新登录，然后再试一次。",
    );
    expect(container.textContent).not.toContain("你的角色");
  });
});

describe("batch 64: the Close section after a forced sign-out", () => {
  it("says the orders weren't checked because the sign-in ended, never to ask the owner", async () => {
    setLanguageForTest("zh-Hans");
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "PermissionDenied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    const { container } = await mount(
      <MemoryRouter>
        <TableSessionClose
          table={a}
          session={{ phase: "Active", version: 4, orderReference: id(81) }}
          csrf={csrf}
          locked={false}
          onBusy={() => undefined}
          onClosed={() => undefined}
          onRefresh={() => undefined}
          fetcher={fetcher}
        />
      </MemoryRouter>,
    );
    await until(() => (container.textContent ?? "").includes("权限"));
    expect(container.textContent).toContain("以你当前的权限无法检查这张桌台的订单。");
    await act(async () => setStaffSessionEnded(true));
    expect(container.textContent).toContain(
      "这台设备上的登录已结束，所以没有检查这张桌台的订单。请重新登录后继续工作。",
    );
    expect(container.textContent).not.toContain("请店主或店长关台");
  });
});
