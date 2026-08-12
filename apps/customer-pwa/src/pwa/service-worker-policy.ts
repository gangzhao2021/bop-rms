const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const locale = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;

const privatePrefixes = [
  "/auth",
  "/bff",
  "/account",
  "/cart",
  "/checkout",
  "/orders",
  "/payment",
  "/receipt",
  "/refund",
  "/support",
] as const;

export function isPrivatePath(pathname: string): boolean {
  return privatePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isSafeUpdatePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/menu" || pathname === "/menu/search";
}

export function isPublicShellNavigation(urlValue: string, origin: string): boolean {
  try {
    const url = new URL(urlValue);
    if (url.origin !== origin || isPrivatePath(url.pathname)) return false;
    const itemMatch = /^\/menu\/items\/([^/]+)$/u.exec(url.pathname);
    return isSafeUpdatePath(url.pathname) || uuidV7.test(itemMatch?.[1] ?? "");
  } catch {
    return false;
  }
}

export function isPublicMenuCacheCandidate(input: {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly credentials: string;
}): boolean {
  try {
    const url = new URL(input.url);
    if (
      input.method !== "GET" ||
      input.credentials !== "omit" ||
      url.origin !== input.origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    )
      return false;
    const match = /^\/api\/v1\/public\/stores\/([^/]+)\/menu$/u.exec(url.pathname);
    if (!match || !uuidV7.test(match[1] ?? "")) return false;
    const allowed = new Set(["channel", "orderType", "locale", "menuVersion", "q", "section"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return false;
    if ([...allowed].some((key) => url.searchParams.getAll(key).length > 1)) return false;
    const channel = url.searchParams.get("channel");
    const orderType = url.searchParams.get("orderType");
    const localeValue = url.searchParams.get("locale") ?? "";
    const menuVersion = url.searchParams.get("menuVersion") ?? "";
    const search = url.searchParams.get("q");
    const section = url.searchParams.get("section");
    return (
      (channel === "DINE_IN" || channel === "PICKUP") &&
      (orderType === "TABLE_SERVICE" || orderType === "PICKUP") &&
      ((channel === "DINE_IN" && orderType === "TABLE_SERVICE") ||
        (channel === "PICKUP" && orderType === "PICKUP")) &&
      locale.test(localeValue) &&
      uuidV7.test(menuVersion) &&
      (search === null || (search.normalize("NFC").trim() === search && search.length <= 120)) &&
      (section === null || uuidV7.test(section))
    );
  } catch {
    return false;
  }
}
