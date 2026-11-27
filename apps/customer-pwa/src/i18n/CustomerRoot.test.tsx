// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerPage } from "../journey/CustomerPage.js";
import { CustomerRoot } from "./CustomerRoot.js";
import { LanguageSwitch } from "./i18n.js";

// Batch 42 (v15 b41 live): with Chinese chosen the guest page's skip link still read "Skip to main
// content", and a page that broke would have said "Something went wrong / Reload" in English: the
// customer app never gave the shared frame its words.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount(node: () => React.ReactNode, initial: "en" | "zh-Hans") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<CustomerRoot initial={initial}>{node}</CustomerRoot>);
  });
  return { host, root };
}

function Broken(): React.ReactNode {
  throw new Error("synthetic render failure");
}

it("the frame's skip link and navigation name follow the chosen language", () => {
  const { host, root } = mount(
    () => (
      <MemoryRouter initialEntries={["/menu"]}>
        <CustomerPage
          step="menu"
          store={{
            storeName: "Synthetic Noodle Bar",
            brandName: "Synthetic Brand",
            serviceMode: "DineIn",
          }}
        >
          <LanguageSwitch />
        </CustomerPage>
      </MemoryRouter>
    ),
    "zh-Hans",
  );
  const skip = host.querySelector('a[href="#main-content"]');
  expect(skip?.textContent).toBe("跳到主要内容");
  expect(host.textContent).not.toContain("Skip to main content");
  // Switching back to English changes the frame's words too.
  const toEnglish = [...host.querySelectorAll("button")].find((b) => b.textContent === "English");
  expect(toEnglish).toBeDefined();
  act(() => toEnglish?.click());
  expect(host.querySelector('a[href="#main-content"]')?.textContent).toBe("Skip to main content");
  act(() => root.unmount());
});

it("a page that breaks says so in Chinese when Chinese is chosen", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { host, root } = mount(() => <Broken />, "zh-Hans");
  expect(host.querySelector("h1")?.textContent).toBe("出错了");
  expect(host.textContent).toContain("此页面无法显示，请重新加载再试。");
  expect(host.querySelector("button")?.textContent).toBe("重新加载");
  expect(host.textContent).not.toMatch(/Something went wrong|Reload/u);
  act(() => root.unmount());
  const english = mount(() => <Broken />, "en");
  expect(english.host.querySelector("h1")?.textContent).toBe("Something went wrong");
  act(() => english.root.unmount());
});
