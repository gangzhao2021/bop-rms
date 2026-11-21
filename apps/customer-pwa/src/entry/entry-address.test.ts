import { describe, expect, it, vi } from "vitest";
import { isEntryCodeAddress } from "./entry-address.js";
import { consumeCustomerQrFragment } from "./entry-client.js";
import { reloadOnEntryCodeChange } from "./entry-code-change.js";
import { loadInternalEntryToken } from "./internal-entry.js";
import { addressCodePlace } from "./start-client.js";

// The boot that reads an address's code, the same-tab reload and the "which Store does this code
// name" comparison read the same patterns: for each address they agree on what it is.
const store = "0190aa21-0000-7000-8000-0000000000d1";
const code =
  "h." +
  btoa(JSON.stringify({ publicStoreReference: store, publicTableReference: null }))
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_") +
  ".s";

/** What the boot does with the address: the code it reads, and the entry it asks the server for. */
async function boot(hash: string) {
  const scanned = consumeCustomerQrFragment({
    hash,
    pathname: "/",
    search: "",
    replaceState: () => undefined,
  });
  const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
  await loadInternalEntryToken({
    enabled: true,
    location: { origin: "https://127.0.0.1:4443", pathname: "/", search: "", hash },
    fetcher: fetcher as unknown as typeof fetch,
  });
  const asked = (fetcher.mock.calls as unknown as [string][]).map(([path]) => path);
  return { scanned, asked: hash === "" ? [] : asked };
}
function reloads(hash: string): boolean {
  const listeners: (() => void)[] = [];
  const reload = vi.fn();
  reloadOnEntryCodeChange({
    events: {
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    hash: () => hash,
    reload,
  });
  for (const listener of listeners) listener();
  return reload.mock.calls.length > 0;
}

describe("entry codes in the address", () => {
  it("a Store's pickup link: asked for at that Store, named as that Store, reloaded in the same tab", async () => {
    const hash = `#pickup=${store}`;
    expect(await boot(hash)).toEqual({
      scanned: null,
      asked: [`/bff/customer/pickup-entry?store=${store}`],
    });
    expect(addressCodePlace(hash, null)).toEqual({ publicStoreReference: store, table: false });
    expect(isEntryCodeAddress(hash) && reloads(hash)).toBe(true);
  });
  it("a scanned QR code: read from the address, named by its own payload, reloaded in the same tab", async () => {
    const hash = `#qr=${code}`;
    const { scanned, asked } = await boot(hash);
    expect(scanned).toBe(code);
    expect(asked).toEqual([]);
    expect(addressCodePlace(hash, scanned)).toEqual({ publicStoreReference: store, table: false });
    expect(reloads(hash)).toBe(true);
  });
  it("the table launcher: asked for as a table, named as a table", async () => {
    const hash = "#internal-dining=t1";
    expect((await boot(hash)).asked).toEqual(["/bff/internal-test/dining-entry?table=t1"]);
    expect(addressCodePlace(hash, null)).toEqual({ publicStoreReference: null, table: true });
    expect(reloads(hash)).toBe(true);
  });
  it("a malformed link is never asked for and never names a place", async () => {
    for (const hash of ["#pickup=not-a-store", "#internal-dining=Bad Table"]) {
      expect(await boot(hash)).toEqual({ scanned: null, asked: [] });
      expect(addressCodePlace(hash, null)).toBeUndefined();
    }
  });
  it("anything else in the address is no code: nothing read, named or reloaded", async () => {
    for (const hash of ["#menu", "#pickup", "#qr"]) {
      expect(isEntryCodeAddress(hash)).toBe(false);
      expect(reloads(hash)).toBe(false);
      expect(addressCodePlace(hash, null)).toBeUndefined();
    }
  });
});
