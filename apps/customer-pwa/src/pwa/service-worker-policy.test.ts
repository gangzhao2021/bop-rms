import { describe, expect, it } from "vitest";
import {
  isPrivatePath,
  isPublicMenuCacheCandidate,
  isPublicShellNavigation,
  isSafeUpdatePath,
} from "./service-worker-policy.js";

const origin = "https://customer.example.test";
const id = (n: number) => `018f7c00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function publicMenu(overrides: Partial<{ method: string; credentials: string; url: string }> = {}) {
  return {
    origin,
    method: "GET",
    credentials: "omit",
    url: `${origin}/api/v1/public/stores/${id(1)}/menu?channel=PICKUP&orderType=PICKUP&locale=en-CA&menuVersion=${id(2)}`,
    ...overrides,
  };
}

describe("WP-1708 deny-by-default Service Worker policy", () => {
  it("allows only fully scoped credential-free versioned public Menu reads", () => {
    expect(isPublicMenuCacheCandidate(publicMenu())).toBe(true);
    for (const candidate of [
      publicMenu({ method: "POST" }),
      publicMenu({ credentials: "same-origin" }),
      publicMenu({ url: publicMenu().url.replace(`menuVersion=${id(2)}`, "") }),
      publicMenu({ url: publicMenu().url.replace(origin, "https://other.example.test") }),
      publicMenu({
        url: `${origin}/api/v1/public/stores/${id(1)}/menu?channel=PICKUP&orderType=PICKUP&locale=en-CA&menuVersion=${id(2)}&orderReference=${id(3)}`,
      }),
      publicMenu({
        url: `${origin}/api/v1/public/stores/${id(1)}/menu?channel=PICKUP&orderType=PICKUP&locale=en-CA&menuVersion=${id(2)}&menuVersion=${id(3)}`,
      }),
    ])
      expect(isPublicMenuCacheCandidate(candidate)).toBe(false);
  });

  it("keeps private and unknown navigation out of shell runtime caching", () => {
    for (const path of [
      "/auth/sign-in",
      "/bff/realtime",
      "/cart",
      "/checkout/payment",
      `/orders/${id(1)}`,
      "/account/profile",
    ])
      expect(isPrivatePath(path)).toBe(true);
    expect(isPublicShellNavigation(`${origin}/menu`, origin)).toBe(true);
    expect(isPublicShellNavigation(`${origin}/menu/items/${id(3)}`, origin)).toBe(true);
    expect(
      isPublicShellNavigation(`${origin}/menu/items/00000000-0000-0000-0000-000000000000`, origin),
    ).toBe(false);
    expect(isPublicShellNavigation(`${origin}/unknown`, origin)).toBe(false);
    expect(isPublicShellNavigation(`${origin}/orders/${id(1)}`, origin)).toBe(false);
  });

  it("permits update activation only at exact stateless route boundaries", () => {
    expect(["/", "/menu", "/menu/search"].every(isSafeUpdatePath)).toBe(true);
    expect(["/menu/items/x", "/cart", "/checkout", `/orders/${id(1)}`].some(isSafeUpdatePath)).toBe(
      false,
    );
  });
});
