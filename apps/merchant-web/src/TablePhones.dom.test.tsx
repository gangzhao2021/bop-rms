// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TablePanelPhones } from "./TablePhones.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

// WP-2423 shared-table-checkout (c): removing a phone alone does not stop it joining again by
// scan (M36). The notice says both are needed, and after a removal staff are offered the pause.

const id = (n: number) => "01a4d520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const joinedAt = "2026-10-28T18:00:00.000Z";
const wire = (removed: boolean, paused: boolean) => ({
  diningSessionReference: id(1),
  paused,
  phones: [
    { participantReference: id(11), phoneNumber: 1, joinedAt, left: false, removed: false },
    {
      participantReference: id(12),
      phoneNumber: 2,
      joinedAt: new Date(Date.now() - 60_000).toISOString(),
      left: removed,
      removed,
    },
  ],
  rounds: [],
});

afterEach(() => {
  document.body.innerHTML = "";
});

function server() {
  let removed = false;
  let paused = false;
  const bodies: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { action: string };
      bodies.push(body);
      if (body.action === "Remove") removed = true;
      if (body.action === "Pause") paused = true;
    }
    return new Response(JSON.stringify(wire(removed, paused)), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  });
  return { fetcher, bodies };
}

describe("Table phones: remove, then stop it joining again", () => {
  it("says a new phone must be removed and, to stop it re-joining, joining by scan paused too", async () => {
    const { fetcher } = server();
    const { container } = await mount(
      <TablePanelPhones
        diningSessionReference={id(1)}
        csrf={csrf}
        timeZone="America/Toronto"
        now={Date.now()}
        locked={false}
        refreshKey="1"
        fetcher={fetcher}
      />,
    );
    await settle();
    expect(container.textContent).toContain(
      "Check it belongs to this table. If not, remove it below. To stop it joining again by scan, also pause joining by scan.",
    );
    expect(container.textContent).not.toContain("remove it below or pause joining by scan");
  });

  it("after a removal offers Also pause joining by scan in that row, which pauses once", async () => {
    const { fetcher, bodies } = server();
    const { container } = await mount(
      <TablePanelPhones
        diningSessionReference={id(1)}
        csrf={csrf}
        timeZone="America/Toronto"
        now={Date.now()}
        locked={false}
        refreshKey="1"
        fetcher={fetcher}
      />,
    );
    await settle();
    expect(buttonNamed(container, "Also pause joining by scan")).toBeUndefined();
    await click(buttonNamed(container, "Remove phone 2 from this table"));
    await click(buttonNamed(container, "Remove phone 2"));
    await settle();
    const row = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("Phone 2"),
    );
    const also = row === undefined ? undefined : buttonNamed(row, "Also pause joining by scan");
    expect(also).toBeDefined();
    await click(also);
    await settle();
    const changes = bodies
      .map((body) => (body as { action: string }).action)
      .filter((action) => action !== "State");
    expect(changes).toEqual(["Remove", "Pause"]);
    // Paused now: the offer is gone and the heading offers to resume.
    expect(buttonNamed(container, "Also pause joining by scan")).toBeUndefined();
    expect(buttonNamed(container, "Resume joining by scan")).toBeDefined();
  });
});
