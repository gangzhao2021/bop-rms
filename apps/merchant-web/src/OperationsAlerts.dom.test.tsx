// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useOperationsAlerts } from "./OperationsAlerts.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

afterEach(() => document.body.replaceChildren());

const answer = () =>
  new Response(
    JSON.stringify({
      audience: "Installation",
      monitor: "Reporting",
      observedAt: "2026-10-15T12:00:00.000Z",
      active: [],
      recentlyCleared: [],
      outbound: { email: false, webhooks: 0, heartbeat: false },
      lastSuccessfulBackupAt: "2026-10-15T08:30:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );

function Probe({ fetcher }: { readonly fetcher: typeof fetch }) {
  const { read } = useOperationsAlerts(fetcher, 20);
  return <p data-kind={read.kind}>{read.kind}</p>;
}
const kinds: string[] = [];
const watch = (container: HTMLElement) => {
  const observer = new MutationObserver(() => {
    const kind = container.querySelector("p")?.dataset.kind;
    if (kind !== undefined && kinds.at(-1) !== kind) kinds.push(kind);
  });
  observer.observe(container, { subtree: true, attributes: true, childList: true });
  return observer;
};
const wait = async (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

it("v15 batch 8: one failed read of the store system (as after switching language) is read again, and Home never lists it as not checked", async () => {
  kinds.length = 0;
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return answer();
  });
  const { container } = await mount(<Probe fetcher={fetcher as unknown as typeof fetch} />);
  const observer = watch(container);
  await settle();
  await wait(60);
  await settle();
  observer.disconnect();
  expect(calls).toBe(2);
  expect(container.textContent).toBe("Ready");
  expect(kinds).not.toContain("Unavailable");
});

it("a failure that repeats is listed as not checked", async () => {
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  });
  const { container } = await mount(<Probe fetcher={fetcher as unknown as typeof fetch} />);
  await settle();
  expect(container.textContent).toBe("Loading");
  await wait(60);
  await settle();
  expect(calls).toBe(2);
  expect(container.textContent).toBe("Unavailable");
});
