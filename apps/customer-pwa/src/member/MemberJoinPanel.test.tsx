// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import { MemberJoinPanel } from "./MemberJoinPanel.js";
import { MemberClientError, memberClient, type MemberClient } from "./member-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const text = () => (container.textContent ?? "").replace(/\s+/gu, " ");
const settle = () =>
  act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve));
  });

/**
 * A stand-in for the points server: each part is earned once (claimed again: nothing to claim, as
 * the api answers), and a part no longer listed once earned. `failures` makes a part's next claims
 * fail for a moment (the connection).
 */
function server(failures: Map<number, number>) {
  const points = new Map([
    [1, 187],
    [2, 188],
  ]);
  const earned = new Set<number>();
  const claims: (number | null)[] = [];
  const client = {
    ...memberClient,
    state: async () => ({
      offered: true,
      signedIn: true,
      claim:
        earned.size === points.size
          ? null
          : {
              until: "2099-01-01T00:00:00.000Z",
              parts: [...points]
                .filter(([part]) => !earned.has(part))
                .map(([partNumber, value]) => ({ partNumber, points: value, certain: true })),
            },
    }),
    claim: async (partNumber: number | null) => {
      claims.push(partNumber);
      const part = partNumber ?? 0;
      if (earned.has(part) || !points.has(part))
        throw new MemberClientError("member_nothing_to_claim");
      const left = failures.get(part) ?? 0;
      if (left > 0) {
        failures.set(part, left - 1);
        throw new MemberClientError("member_unavailable");
      }
      earned.add(part);
      return { earnedPoints: points.get(part) ?? 0 };
    },
  } satisfies MemberClient;
  return { client, claims };
}

/**
 * Batch 63 review (F06): a phone that paid Part 1 and Part 2 claims both in turn. Part 1 was added
 * and Part 2 failed; trying again claimed Part 1 again, which the server refused (already earned),
 * so Part 2 was offered only after a reload. Trying again now claims only Part 2, and says what
 * was added in all.
 */
it("batch 63 review: trying again after one part failed claims only the parts still unclaimed", async () => {
  // The automatic add on opening fails for both; the guest's tap adds Part 1, Part 2 fails once.
  const { client, claims } = server(
    new Map([
      [1, 1],
      [2, 2],
    ]),
  );
  await act(async () => {
    root.render(
      <LanguageRoot initial="en">
        {() => (
          <MemoryRouter>
            <MemberJoinPanel client={client} />
          </MemoryRouter>
        )}
      </LanguageRoot>,
    );
  });
  await settle();
  expect(text()).toContain("Add 375 points for what you paid");
  const add = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Add my points");
  await act(async () => add()?.click());
  await settle();
  expect(claims).toEqual([1, 2, 1, 2]);
  // Part 1 is added; only Part 2 is offered now, with what went wrong.
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(text()).toContain("Add 188 points for this order");
  await act(async () => add()?.click());
  await settle();
  expect(claims).toEqual([1, 2, 1, 2, 2]);
  expect(text()).toContain("375 points added for this order.");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
