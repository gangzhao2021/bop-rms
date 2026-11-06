import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceReconnectPanel,
  loadWorkspaceFrame,
  saveWorkspaceFrame,
  workspaceFrameToStore,
} from "./WorkspaceReconnect.js";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

const store = "018f7f9a-ad3e-7a11-8d01-000000000003";
const navigation = [
  { screenId: "OPS-ORDER-QUEUE", label: "Orders", href: "/operations/orders", permission: "x" },
  {
    screenId: "STORE-HOURS-SERVICE",
    label: "Hours & ordering",
    href: "/app/organization/stores/" + store + "/service",
    permission: "store.service.read",
  },
  {
    screenId: "ORG-BRAND-DETAIL",
    label: "Brand",
    href: "/app/organization/brands/018f7f9a-ad3e-7a11-8d01-000000000009",
    permission: "organization.manage",
  },
] as unknown as readonly MerchantNavigationItem[];

afterEach(() => vi.unstubAllGlobals());

describe("merchant-outage-recovery M01: the kept workspace frame", () => {
  it("keeps no Store or Brand reference", () => {
    const kept = workspaceFrameToStore({ storeLabel: "Store", navigation });
    expect(kept.navigation.map((item) => item.screenId)).toEqual(["OPS-ORDER-QUEUE"]);
    expect(JSON.stringify(kept)).not.toMatch(/018f7f9a/u);
  });

  it("round-trips through sessionStorage and refuses a frame carrying a reference", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    saveWorkspaceFrame({ storeLabel: "Store", timeZone: "America/Toronto", navigation });
    expect(loadWorkspaceFrame()?.navigation).toHaveLength(1);
    expect(loadWorkspaceFrame()?.timeZone).toBe("America/Toronto");
    values.set(
      "bop.workspace.frame.v1",
      JSON.stringify({ storeLabel: "Store", navigation: navigation.slice(1) }),
    );
    expect(loadWorkspaceFrame()).toBeNull();
  });

  it("says it is retrying, warns about automatic refunds, and offers Try now", () => {
    const html = renderToStaticMarkup(
      <WorkspaceReconnectPanel
        reconnect={{ gate: "Reconnecting", lastTriedAt: null, retry: () => undefined }}
      />,
    );
    expect(html).toContain("Can&#x27;t connect right now");
    expect(html).toContain("may be refunded automatically");
    expect(html).toContain("Try now");
    expect(html).not.toContain("session and Store are required");
  });
});
