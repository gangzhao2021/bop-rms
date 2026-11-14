import process from "node:process";
import { createRequire } from "node:module";
import { URL } from "node:url";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url)),
  express = require("express"),
  origin = "https://127.0.0.1:4443",
  selectorPattern = /^[a-z][a-z0-9-]{0,39}$/u,
  storeChoicePattern = /^[1-9][0-9]?$/u;
const unavailable = () => {
  throw new Error("INTERNAL_STAFF_LOGIN_UNAVAILABLE");
};
const deviceCookiePattern = /^[A-Za-z0-9_-]{43}$/u;
/** The registered-tablet cookie (WP-2423 Q18), or undefined; the value is never logged. */
function tabletCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length > 4096) return undefined;
  const found = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-bop-store-device="))
    .map((part) => part.slice("__Host-bop-store-device=".length));
  return found.length === 1 && deviceCookiePattern.test(found[0]) ? found[0] : undefined;
}
const escape = (value) =>
  value.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
function record(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return unavailable();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
    result[key] = descriptor.value;
  }
  return result;
}
const STAFF_PAGE_WORDS = Object.freeze({
  en: {
    title: "Staff sign-in",
    note: "Test environment. Choose a test identity. A live store signs in with each staff member’s own account.",
    enter: "Enter",
    kitchen: "Kitchen display",
    tablet: "On a shared tablet:",
    pin: "Switch staff with a PIN",
    enterAs: (name) => `Enter as ${name}`,
    kitchenAs: (name) => `Start kitchen display as ${name}`,
    kitchenAt: (store, name) => `Start kitchen display at ${store} as ${name}`,
  },
  zh: {
    title: "员工登录",
    note: "测试环境。选一个测试身份进入。正式门店每位员工用自己的账号登录。",
    enter: "进入",
    kitchen: "后厨屏",
    tablet: "共享平板：",
    pin: "用 PIN 换人",
    enterAs: (name) => `进入，身份 ${name}`,
    kitchenAs: (name) => `启动后厨屏，身份 ${name}`,
    kitchenAt: (store, name) => `启动后厨屏 ${store}，身份 ${name}`,
  },
});
// The same look as the staff sign-in page (design brief §2); this page is outside the web app.
const STAFF_PAGE_STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#171717;font:16px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(28rem,100%);margin:0 auto;padding:clamp(24px,10vh,96px) 16px 40px}
.brand{margin:0 0 24px;font-weight:600}
h1{margin:0 0 8px;font-size:28px;font-weight:600;line-height:1.25}
.note,.tablet,.kitchen{color:#666;font-size:14px}
.note{margin:0 0 24px}
ul{margin:0;padding:0;list-style:none}
li{padding:12px 0}
li+li{border-top:1px solid #e5e5e5}
.person{display:flex;align-items:center;justify-content:space-between;gap:16px}
.person strong{font-weight:600;overflow-wrap:anywhere}
.kitchen{display:grid;grid-template-columns:auto 1fr;column-gap:16px}
.kitchen span{grid-row:1/9;line-height:44px}
.kitchen form{grid-column:2}
button{min-height:44px;padding:0;border:0;background:none;color:#1f63e0;font:inherit;font-weight:600;text-align:start;cursor:pointer}
.kitchen button{font-weight:400}
.person button{padding:0 20px;border-radius:6px;background:#1f63e0;color:#fff;white-space:nowrap}
a{color:#1f63e0;text-decoration:none}
button:hover,a:hover{text-decoration:underline}
button:focus-visible,a:focus-visible{outline:2px solid #1f63e0;outline-offset:2px}
.tablet{margin:24px 0 0}
`;

/** Development-only identity selector. Membership and business grants are
 * evaluated by the actual Merchant owners; neither this page nor its aliases
 * confer permission. The roster is freshly acquired for every GET and POST. */
export function installInternalStaffLogin(app, merchant) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
  if (typeof merchant?.staffChoices !== "function" || typeof merchant?.issue !== "function")
    return unavailable();
  const choices = merchant.staffChoices.bind(merchant),
    issue = merchant.issue.bind(merchant),
    kitchenChoices =
      typeof merchant.kitchenDisplayChoices === "function"
        ? merchant.kitchenDisplayChoices.bind(merchant)
        : async () => [];
  /** v15 2026-11-01: with several Stores, one kitchen display start per Store a person works at. */
  async function currentKitchenChoices(entries) {
    const raw = await kitchenChoices();
    if (!Array.isArray(raw) || raw.length > 64) return unavailable();
    return raw.map((value) => {
      const entry = record(value, ["selector", "label", "store", "storeLabel"]);
      if (
        !entries.some((known) => known.selector === entry.selector) ||
        typeof entry.store !== "string" ||
        !storeChoicePattern.test(entry.store) ||
        typeof entry.storeLabel !== "string" ||
        !entry.storeLabel.trim() ||
        entry.storeLabel.length > 120
      )
        return unavailable();
      return entry;
    });
  }
  async function currentChoices() {
    const raw = await choices();
    if (
      !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length < 1 ||
      raw.length > 16 ||
      Reflect.ownKeys(raw).length !== raw.length + 1
    )
      return unavailable();
    const selectors = new Set(),
      result = [];
    for (let index = 0; index < raw.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) return unavailable();
      const entry = record(descriptor.value, ["selector", "label"]);
      if (
        typeof entry.selector !== "string" ||
        !selectorPattern.test(entry.selector) ||
        selectors.has(entry.selector) ||
        typeof entry.label !== "string" ||
        !entry.label.trim() ||
        entry.label.length > 120 ||
        Array.from(entry.label).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return unavailable();
      selectors.add(entry.selector);
      result.push(Object.freeze(entry));
    }
    return Object.freeze(result);
  }
  const requestScope = (req) =>
    process.env.NODE_ENV === "development" &&
    req.headers.host === "127.0.0.1:4443" &&
    Object.keys(req.query).length === 0;
  app.get("/internal-test/staff", async (req, res) => {
    // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on this
    // page's same-origin form POST, which the exact-origin check below must reject.
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "same-origin");
    if (
      !requestScope(req) ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] !== undefined &&
        !["none", "same-origin"].includes(req.headers["sec-fetch-site"]))
    )
      return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
    try {
      const zh = /\bzh\b/i.test(String(req.headers["accept-language"] ?? "")),
        words = zh ? STAFF_PAGE_WORDS.zh : STAFF_PAGE_WORDS.en,
        entries = await currentChoices(),
        kitchen = await currentKitchenChoices(entries),
        hidden = `<input type="hidden" name="confirmation" value="DEMO_STAFF_LOGIN">`,
        kitchenForm = (entry, store) =>
          `<form method="post" action="/merchant/internal-test/login">${hidden}<input type="hidden" name="purpose" value="KitchenDisplay">` +
          (store === undefined
            ? `<button name="staffSelector" value="${escape(entry.selector)}" type="submit" aria-label="${words.kitchenAs(escape(entry.label))}">${words.kitchen}</button></form>`
            : `<input type="hidden" name="store" value="${escape(store.store)}"><button name="staffSelector" value="${escape(entry.selector)}" type="submit" aria-label="${words.kitchenAt(escape(store.storeLabel), escape(entry.label))}">${escape(store.storeLabel)}</button></form>`),
        forms = entries
          .map((entry) => {
            // One Store: one start, as before. Several: one per Store this person works at; a
            // kitchen display then belongs to that Store.
            const starts =
              kitchen.length === 0
                ? [kitchenForm(entry)]
                : kitchen
                    .filter((store) => store.selector === entry.selector)
                    .map((store) => kitchenForm(entry, store));
            return (
              `<li><div class="person"><strong>${escape(entry.label)}</strong><form method="post" action="/merchant/internal-test/login">${hidden}<button name="staffSelector" value="${escape(entry.selector)}" type="submit" aria-label="${words.enterAs(escape(entry.label))}">${words.enter}</button></form></div>` +
              (starts.length === 0
                ? ""
                : `<div class="kitchen"><span>${words.kitchen}</span>${starts.join("")}</div>`) +
              `</li>`
            );
          })
          .join("");
      return res
        .type("html")
        .send(
          `<!doctype html><html lang="${zh ? "zh-Hans" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${words.title}</title><style>${STAFF_PAGE_STYLE}</style><main><p class="brand">BOP</p><h1>${words.title}</h1><p class="note">${words.note}</p><ul>${forms}</ul><p class="tablet">${words.tablet} <a href="/operations/switch-staff">${words.pin}</a></p></main></html>`,
        );
    } catch {
      return res.status(503).json({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
    }
  });
  // WP-2423 取舍 15, TEST-ONLY: platform support's sign-in until the formal one (Cognito gate).
  app.get("/internal-test/support", (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "same-origin");
    if (!requestScope(req)) return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
    return res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST platform support sign-in</title><body><h1>TEST ONLY: platform support sign-in</h1><p>For internal testing. Real support staff will sign in another way.</p><form method="post" action="/merchant/internal-test/login"><input type="hidden" name="confirmation" value="DEMO_STAFF_LOGIN"><button name="staffSelector" value="support-1" type="submit">Sign in as TEST support</button></form></body></html>`,
      );
  });
  app.post(
    "/merchant/internal-test/login",
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      let requested, kitchenDisplay, store;
      try {
        if (
          !requestScope(req) ||
          req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] !== "same-origin"
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        const body = record(req.body, [
          "confirmation",
          ...(Object.hasOwn(req.body ?? {}, "staffSelector") ? ["staffSelector"] : []),
          ...(Object.hasOwn(req.body ?? {}, "purpose") ? ["purpose"] : []),
          ...(Object.hasOwn(req.body ?? {}, "store") ? ["store"] : []),
        ]);
        if (
          body.confirmation !== "DEMO_STAFF_LOGIN" ||
          (Object.hasOwn(body, "purpose") && body.purpose !== "KitchenDisplay") ||
          (Object.hasOwn(body, "staffSelector") &&
            (typeof body.staffSelector !== "string" ||
              !selectorPattern.test(body.staffSelector))) ||
          (Object.hasOwn(body, "store") &&
            (body.purpose !== "KitchenDisplay" ||
              typeof body.store !== "string" ||
              !storeChoicePattern.test(body.store)))
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        requested = body.staffSelector;
        kitchenDisplay = body.purpose === "KitchenDisplay";
        store = body.store;
      } catch {
        return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
      }
      try {
        const entries = await currentChoices();
        if (
          (requested === undefined && entries.length !== 1) ||
          (requested !== undefined &&
            !requested.startsWith("support") &&
            !entries.some((entry) => entry.selector === requested))
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        const purpose = kitchenDisplay ? "KitchenDisplay" : "Workforce";
        // On a registered tablet the full sign-in also ends the PIN session left on it.
        const tablet = tabletCookie(req);
        // The Store a kitchen display was started for (the session checks the person works there).
        const credentials =
          store !== undefined
            ? await issue(requested, purpose, tablet, store)
            : tablet === undefined
              ? await issue(requested, purpose)
              : await issue(requested, purpose, tablet);
        if (
          typeof credentials?.sessionCookie !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(credentials.sessionCookie)
        )
          return unavailable();
        res.set(
          "Set-Cookie",
          "__Host-bop-merchant=" +
            credentials.sessionCookie +
            "; Path=/; Secure; HttpOnly; SameSite=Strict",
        );
        return res.redirect(
          303,
          kitchenDisplay
            ? "/operations/kitchen"
            : requested?.startsWith("support")
              ? "/platform/support-cases"
              : "/operations/orders",
        );
      } catch {
        return res.status(503).json({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
      }
    },
  );
}
