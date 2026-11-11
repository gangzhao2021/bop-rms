// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutScopeSettingControl } from "./TablePhones.js";
import { mount, settle } from "./dom-test-kit.fixture.js";

// WP-2423 同桌结账 (DEC-OWNER-DEFAULTS-2026-11-06; 门店可在设置里改默认): the Store's default for
// guests paying on their phones at a shared table — the whole table unless a manager changes it.

const csrf = "A".repeat(43);
afterEach(() => {
  document.body.innerHTML = "";
});

function server(canChange: boolean, failFirst = false) {
  let state = { version: 0, defaultScope: "WholeTable", canChange };
  const bodies: Record<string, unknown>[] = [];
  let failures = failFirst ? 1 : 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain("/merchant/dining/checkout-scope-setting");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (body.action === "Change") {
      if (failures > 0) {
        failures -= 1;
        return new Response("{}", { status: 503 });
      }
      state = { ...state, version: state.version + 1, defaultScope: String(body.defaultScope) };
    }
    return new Response(JSON.stringify(state), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    });
  });
  return { fetcher, bodies };
}
const radio = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(name))
    ?.querySelector("input") as HTMLInputElement;

describe("Store default for paying at a shared table", () => {
  it("starts on the whole table; a manager changes it to what each guest added", async () => {
    const { fetcher, bodies } = server(true);
    const { container } = await mount(
      <CheckoutScopeSettingControl csrf={csrf} locked={false} fetcher={fetcher} />,
    );
    await settle();
    expect(container.textContent).toContain(
      "When guests at one table pay on their phones, start with",
    );
    expect(radio(container, "The whole table").checked).toBe(true);
    radio(container, "What each guest added").click();
    await settle();
    expect(bodies.find((body) => body.action === "Change")).toMatchObject({
      action: "Change",
      expectedVersion: 0,
      defaultScope: "OwnDishes",
    });
    expect(radio(container, "What each guest added").checked).toBe(true);
  });

  it("a lost answer is resent with the same operation, never a second change", async () => {
    const { fetcher, bodies } = server(true, true);
    const { container } = await mount(
      <CheckoutScopeSettingControl csrf={csrf} locked={false} fetcher={fetcher} />,
    );
    await settle();
    radio(container, "What each guest added").click();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    radio(container, "What each guest added").click();
    await settle();
    const changes = bodies.filter((body) => body.action === "Change");
    expect(changes).toHaveLength(2);
    expect(changes[1]?.operationReference).toBe(changes[0]?.operationReference);
  });

  it("staff who aren't managers see it but can't change it", async () => {
    const { fetcher, bodies } = server(false);
    const { container } = await mount(
      <CheckoutScopeSettingControl csrf={csrf} locked={false} fetcher={fetcher} />,
    );
    await settle();
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(container.textContent).toContain("A manager changes this.");
    expect(bodies.every((body) => body.action === "Read")).toBe(true);
  });
});
