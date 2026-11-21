// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { StoreDateTimeSelects } from "./StoreDateTimeSelects.js";
import { mount, selectValue, settle, unmountMounted } from "./dom-test-kit.fixture.js";

afterEach(async () => {
  await unmountMounted();
  setLanguageForTest("en");
});

const now = Date.parse("2026-11-17T12:00:00.000Z");
const named = (container: HTMLElement, name: string) =>
  container.querySelector(`select[aria-label="${name}"]`);

it("WP-2423 batch 29: a Store date and time from selects, never the browser's yyyy-mm-dd box", async () => {
  const changed = vi.fn<(local: string) => void>();
  const { container } = await mount(
    <StoreDateTimeSelects label="Ends at (Store time)" value="" onChange={changed} now={now} />,
  );
  expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
  expect(container.textContent).not.toMatch(/yyyy|mm|dd/u);
  // Nothing is said until every part is chosen.
  await selectValue(named(container, "Ends at (Store time): Year"), "2027");
  await selectValue(named(container, "Ends at (Store time): Month"), "2");
  await selectValue(named(container, "Ends at (Store time): Day"), "28");
  await selectValue(named(container, "Ends at (Store time): Hour of day"), "9");
  expect(changed).toHaveBeenLastCalledWith("");
  await selectValue(named(container, "Ends at (Store time): Minute"), "5");
  expect(changed).toHaveBeenLastCalledWith("2027-02-28T09:05");
  // February 2027 has 28 days.
  expect(named(container, "Ends at (Store time): Day")?.querySelectorAll("option")).toHaveLength(
    29,
  );
});

it("shows a saved value, and its labels in Chinese", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await mount(
    <StoreDateTimeSelects
      label="结束时间（门店时间）"
      value="2026-12-31T23:57"
      onChange={() => undefined}
      now={now}
    />,
  );
  await settle();
  expect(container.textContent).toContain("年");
  expect(container.textContent).toContain("月");
  expect(container.textContent).toContain("时");
  expect(container.textContent).toContain("分");
  expect((named(container, "结束时间（门店时间）：分") as HTMLSelectElement).value).toBe("57");
  expect((named(container, "结束时间（门店时间）：月") as HTMLSelectElement).value).toBe("12");
  expect(container.textContent).not.toMatch(/yyyy/u);
});
