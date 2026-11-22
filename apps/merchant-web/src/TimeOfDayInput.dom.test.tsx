// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ServiceInterval } from "./service-control-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
import { IntervalEditor } from "./StoreConfigurationEditor.js";
import { mount, selectValue, settle, unmountMounted } from "./dom-test-kit.fixture.js";

/**
 * Batch 47 review: the hours editor's time control writes times to the minute, and a period can't
 * end at the time it starts, so a Store open all day (Test Merchant 2, 00:00 to the end of the day)
 * could only be saved as 00:00–11:59 p.m., and guests were turned away in the day's last minute.
 * The end field offers the end of the day, saved the way the hours model writes it (23:59:59).
 */
afterEach(async () => {
  await unmountMounted();
  setLanguageForTest("en");
});

const evening: ServiceInterval = {
  startLocalTime: "00:00:00",
  endLocalTime: "23:00:00",
  endsNextDay: false,
  serviceModes: ["DineIn"],
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
};

function Editor({
  initial,
  changed,
}: {
  readonly initial: ServiceInterval;
  readonly changed: (value: Partial<ServiceInterval>) => void;
}) {
  const [interval, setInterval] = useState(initial);
  return (
    <IntervalEditor
      interval={interval}
      index={0}
      modes={["DineIn"]}
      onChange={(value) => {
        changed(value);
        setInterval((current) => ({ ...current, ...value }));
      }}
      onRemove={() => undefined}
    />
  );
}

const group = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('[role="group"]')].find(
    (element) => element.textContent?.startsWith(name) === true,
  ) as HTMLElement;
const select = (container: HTMLElement, name: string, field: string) =>
  group(container, name).querySelector(`select[aria-label="${field}"]`) as HTMLSelectElement | null;
const nextDay = (container: HTMLElement) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent === "Ends next day")
    ?.querySelector("input") as HTMLInputElement;

it("lets staff end a period at the end of the day, saved as the hours model writes it", async () => {
  const changed = vi.fn<(value: Partial<ServiceInterval>) => void>();
  const { container } = await mount(<Editor initial={evening} changed={changed} />);
  const hour = select(container, "End 1", "Hour");
  expect([...(hour?.options ?? [])].map((option) => option.text)).toContain(
    "Midnight (end of day)",
  );
  await selectValue(hour, "end");
  expect(changed).toHaveBeenLastCalledWith({ endLocalTime: "23:59:59", endsNextDay: false });
  await settle();
  // It reads as the end of the day, with no minute or a.m./p.m. beside it, and the day it ends is
  // that day.
  expect(select(container, "End 1", "Hour")?.value).toBe("end");
  expect(select(container, "End 1", "Minute")).toBeNull();
  expect(select(container, "End 1", "a.m. or p.m.")).toBeNull();
  expect(nextDay(container).disabled).toBe(true);
  // The start field has no end of day.
  expect(
    [...(select(container, "Start 1", "Hour")?.options ?? [])].map((o) => o.value),
  ).not.toContain("end");
  // Picking an hour again gives that hour on the hour.
  await selectValue(select(container, "End 1", "Hour"), "10");
  expect(changed).toHaveBeenLastCalledWith({ endLocalTime: "22:00:00" });
  expect(nextDay(container).disabled).toBe(false);
});

it("shows a saved whole day as the end of the day, in Chinese as 24:00", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await mount(
    <Editor initial={{ ...evening, endLocalTime: "23:59:59" }} changed={() => undefined} />,
  );
  await settle();
  const hour = select(container, "结束 1", "小时");
  expect(hour?.value).toBe("end");
  expect(hour?.selectedOptions[0]?.text).toBe("24:00（当天结束）");
  expect(select(container, "结束 1", "分")).toBeNull();
});
