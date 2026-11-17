import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

/**
 * b18: the staff pages' offline worker never leaves a blank page. A failed navigation shows the
 * cached offline page; without it, the store system's own answer, and with no answer at all a short
 * built-in page in both staff languages.
 */
const source = readFileSync(join(import.meta.dirname, "../public/operations/sw.js"), "utf8");

type Listener = (event: { request: Request; respondWith(answer: Promise<Response>): void }) => void;

function worker(input: {
  readonly cached: Response | undefined;
  readonly network: () => Promise<Response>;
}) {
  const listeners = new Map<string, Listener>();
  runInNewContext(source, {
    self: {
      location: { origin: "https://store.test" },
      addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    },
    caches: { match: async () => input.cached },
    fetch: input.network,
    URL,
    Response,
  });
  return async (request: Request) => {
    let answer: Promise<Response> | undefined;
    const navigation = Object.defineProperty(request, "mode", { value: "navigate" });
    listeners.get("fetch")?.({ request: navigation, respondWith: (value) => (answer = value) });
    if (answer === undefined) throw new Error("the worker did not answer");
    return answer;
  };
}

const page = () => new Request("https://store.test/operations/dining");

// b25: the offline page's words changed ("Check the Wi-Fi"), so a tablet must fetch it again.
it("names a new cache, so a tablet holding the old worker takes this one", () => {
  expect(source).toContain('const CACHE = "bop-merchant-offline-v6";');
});

it("shows the cached offline page when the connection is down", async () => {
  const answer = await worker({
    cached: new Response("cached offline page"),
    network: () => Promise.reject(new TypeError("offline")),
  })(page());
  expect(await answer.text()).toBe("cached offline page");
});

it("shows a built-in page, never a blank one, when the offline page is not cached", async () => {
  const answer = await worker({
    cached: undefined,
    network: () => Promise.reject(new TypeError("offline")),
  })(page());
  expect(answer.status).toBe(503);
  expect(answer.headers.get("content-type")).toContain("text/html");
  const text = await answer.text();
  expect(text).toContain("无法连接门店系统");
  expect(text).toContain("The store system can't be reached");
});

it("shows the store system's own 503 page when the offline page is not cached", async () => {
  const answer = await worker({
    cached: undefined,
    network: async () => new Response("store system is down", { status: 503 }),
  })(page());
  expect(answer.status).toBe(503);
  expect(await answer.text()).toBe("store system is down");
});

it("serves a page that loads straight from the network", async () => {
  const answer = await worker({
    cached: new Response("cached offline page"),
    network: async () => new Response("the real page"),
  })(page());
  expect(await answer.text()).toBe("the real page");
});
