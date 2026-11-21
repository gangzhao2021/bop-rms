// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { buttonNamed, mount } from "./dom-test-kit.fixture.js";
import { PageDidNotLoad } from "./PageDidNotLoad.js";
import { PageChunkBoundary, PageChunkError } from "./route-chunks.js";

/**
 * b24 (live23 store-setup probe): a page whose opening the connection cut off said "This page
 * didn't load… Check the Wi-Fi, then try again" and kept saying it after the Wi-Fi was back, until
 * staff pressed Try again. It now tries again by itself once the browser is back online; Try again
 * still works.
 */
afterEach(() => {
  document.body.replaceChildren();
});

const backOnline = async () => {
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
};

function MissingCode(): never {
  throw new PageChunkError(new Error("network"));
}

it("a screen whose code didn't arrive loads again by itself when the Wi-Fi is back", async () => {
  let reloads = 0;
  const { container } = await mount(
    <PageChunkBoundary resetKey="/store/setup" reload={() => (reloads += 1)}>
      <MissingCode />
    </PageChunkBoundary>,
  );
  expect(container.textContent).toContain("This page didn't load");
  expect(reloads).toBe(0);
  await backOnline();
  expect(reloads).toBe(1);
  // Try again is still there and still works.
  await act(async () => {
    buttonNamed(container, "Try again")?.click();
  });
  expect(reloads).toBe(2);
});

it("a page read that the connection cut off reads again by itself when the Wi-Fi is back", async () => {
  let reads = 0;
  await mount(<PageDidNotLoad code="Offline" onRetry={() => (reads += 1)} />);
  await backOnline();
  expect(reads).toBe(1);
});

it("a page that failed on the server's side is not read again just because the device is online", async () => {
  let reads = 0;
  await mount(<PageDidNotLoad code="Unavailable" onRetry={() => (reads += 1)} />);
  await backOnline();
  expect(reads).toBe(0);
});
