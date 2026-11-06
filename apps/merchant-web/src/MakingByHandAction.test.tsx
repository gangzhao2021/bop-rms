// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { MakingByHandAction } from "./MakingByHandAction.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";

const id = (n: number) => "01a4d700-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const batch = { orderBatchReference: id(2) } as Parameters<typeof MakingByHandAction>[0]["batch"];
const order = { orderReference: id(1), orderType: "Pickup" } as Parameters<
  typeof MakingByHandAction
>[0]["order"];
afterEach(() => document.body.replaceChildren());

/** As on Orders: the page keeps the failure; the order detail (and the button) is made again. */
function Detail({ fetcher }: { readonly fetcher: typeof fetch }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [mounts, setMounts] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setMounts((value) => value + 1)}>
        Read the order again
      </button>
      <MakingByHandAction
        key={mounts}
        order={order}
        batch={batch}
        csrf={"a".repeat(43)}
        fetcher={fetcher}
        onSettled={() => undefined}
        failure={failure}
        onFailed={setFailure}
      />
    </>
  );
}

it("WP-2423 live minor 12: a failed Making it by hand still says why after the order is read again", async () => {
  let status = 503;
  const fetcher = (async () => new Response(null, { status })) as typeof fetch;
  const { container } = await mount(<Detail fetcher={fetcher} />);
  await click(buttonNamed(container, "Making it by hand"));
  await settle();
  const said = "Not saved. Check the connection and try again.";
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(said);
  // The detail read failed and came back: the button is new, the message is still there.
  await click(buttonNamed(container, "Read the order again"));
  await settle();
  expect(buttonNamed(container, "Making it by hand")).toBeDefined();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(said);
  // The next tap clears it; this time it is saved.
  status = 200;
  await click(buttonNamed(container, "Making it by hand"));
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await click(buttonNamed(container, "Read the order again"));
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
