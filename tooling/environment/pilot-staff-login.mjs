import process from "node:process";
import { createRequire } from "node:module";
import { URL } from "node:url";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url)),
  express = require("express"),
  origin = "https://127.0.0.1:4443",
  selectorPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const unavailable = () => {
  throw new Error("INTERNAL_STAFF_LOGIN_UNAVAILABLE");
};
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
/** Development-only identity selector. Membership and business grants are
 * evaluated by the actual Merchant owners; neither this page nor its aliases
 * confer permission. The roster is freshly acquired for every GET and POST. */
export function installInternalStaffLogin(app, merchant) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_TEST_ONLY");
  if (typeof merchant?.staffChoices !== "function" || typeof merchant?.issue !== "function")
    return unavailable();
  const choices = merchant.staffChoices.bind(merchant),
    issue = merchant.issue.bind(merchant);
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
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    if (
      !requestScope(req) ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] !== undefined &&
        !["none", "same-origin"].includes(req.headers["sec-fetch-site"]))
    )
      return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
    try {
      const entries = await currentChoices(),
        forms = entries
          .map(
            (entry) =>
              `<form method="post" action="/merchant/internal-test/login"><input type="hidden" name="confirmation" value="DEMO_STAFF_LOGIN"><button name="staffSelector" value="${escape(entry.selector)}" type="submit">Enter as ${escape(entry.label)}</button></form>`,
          )
          .join("");
      return res
        .type("html")
        .send(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DEMO Staff</title><main><h1>DEMO Store staff</h1><p>Local internal testing only. Choose a configured test identity. Access still depends on current permissions.</p>${forms}</main></html>`,
        );
    } catch {
      return res.status(503).json({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
    }
  });
  app.post(
    "/merchant/internal-test/login",
    express.urlencoded({ extended: false, limit: "1kb" }),
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      let requested;
      try {
        if (
          !requestScope(req) ||
          req.headers.origin !== origin ||
          req.headers["sec-fetch-site"] !== "same-origin"
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        const body = record(
          req.body,
          Object.hasOwn(req.body ?? {}, "staffSelector")
            ? ["confirmation", "staffSelector"]
            : ["confirmation"],
        );
        if (
          body.confirmation !== "DEMO_STAFF_LOGIN" ||
          (Object.hasOwn(body, "staffSelector") &&
            (typeof body.staffSelector !== "string" || !selectorPattern.test(body.staffSelector)))
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        requested = body.staffSelector;
      } catch {
        return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
      }
      try {
        const entries = await currentChoices();
        if (
          (requested === undefined && entries.length !== 1) ||
          (requested !== undefined && !entries.some((entry) => entry.selector === requested))
        )
          return res.status(400).json({ code: "INTERNAL_STAFF_LOGIN_DENIED" });
        const credentials = requested === undefined ? await issue() : await issue(requested);
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
        return res.redirect(303, "/operations/orders");
      } catch {
        return res.status(503).json({ code: "INTERNAL_STAFF_LOGIN_UNAVAILABLE" });
      }
    },
  );
}
