import { expect, it } from "vitest";
import { parseMerchantWorkspaceSnapshot } from "../../apps/api/dist/merchant-bff-workspace.js";
import { createPilotWorkspaceListing } from "./pilot-merchant-workspace.mjs";

/**
 * v15 2026-10-31: switching to DEMO Store 2 was denied. The switch is answered by the composition
 * of the Store left, and its workspace named that Store; the BFF requires the workspace to name the
 * session's Store, so every switch failed. The listing is for the session's Store.
 */
const store1 = "00000000-0000-7000-8000-000000000003",
  store2 = "01a190a6-6c74-7588-8071-6e3da993bdba";
const scope = (storeReference) => ({
  tenantReference: "0190ed16-0000-7000-8000-00000000005a",
  brandReference: "00000000-0000-7000-8000-000000000002",
  storeReference,
});
const context = (storeReference, displayName) => ({
  brand: { displayName: "DEMO Brand" },
  store: { storeReference, displayName, timeZone: "America/Toronto" },
  resolvedAt: "2026-10-31T16:00:00.000Z",
});
it("lists the workspace of the session's Store, whichever Store's composition answers", () => {
  const listing = createPilotWorkspaceListing({ served: [scope(store1), scope(store2)] });
  for (const [store, name] of [
    [store1, "DEMO Store"],
    [store2, "DEMO Store 2 – not production"],
  ]) {
    const snapshot = parseMerchantWorkspaceSnapshot(listing({ context: context(store, name) }));
    // The BFF's check (persistent-merchant-bff): the workspace names the session's Store.
    expect(snapshot.selectedScope.storeReference).toBe(store);
    const hrefs = snapshot.navigation.map((entry) => entry.href);
    for (const href of hrefs.filter((value) => value.startsWith("/app/organization/stores/")))
      expect(href).toContain("/stores/" + store + "/");
    expect(snapshot.authorizedStores.map((entry) => entry.storeReference)).toEqual([
      store1,
      store2,
    ]);
  }
});
