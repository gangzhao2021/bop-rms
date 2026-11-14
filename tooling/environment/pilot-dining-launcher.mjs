import process from "node:process";
const origin = "https://127.0.0.1:4443";
const selectorPattern = /^[a-z][a-z0-9-]{0,39}$/;
const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export function registerInternalDiningEntry(app, { profile, tables = [] }) {
  if (process.env.NODE_ENV !== "development" || profile.environment !== "InternalTest")
    throw new Error("INTERNAL_TEST_ONLY");
  const entries = new Map();
  for (const table of tables) {
    if (
      !selectorPattern.test(table.selector ?? "") ||
      entries.has(table.selector) ||
      typeof table.label !== "string" ||
      !table.label.trim() ||
      table.label.length > 120 ||
      Array.from(table.label).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      typeof table.loadQr !== "function"
    )
      throw new Error("INTERNAL_DINING_CONFIGURATION_UNAVAILABLE");
    entries.set(table.selector, { label: table.label, loadQr: table.loadQr });
  }
  app.get("/internal-test/dining", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.host !== "127.0.0.1:4443" || Object.keys(req.query).length)
      return res.sendStatus(400);
    const links = [...entries]
      .map(
        ([selector, table]) =>
          `<li><a href="/#internal-dining=${selector}">${escapeHtml(table.label)}</a></li>`,
      )
      .join("");
    res
      .type("html")
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DEMO Dining entry</title><main><h1>DEMO Dining entry</h1><p>Local internal testing only. Select the table assigned by staff, then enter its current joining code.</p><ul>${links}</ul></main></html>`,
      );
  });
  app.get("/bff/internal-test/dining-entry", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const reject = (status) => res.status(status).json({ code: "INTERNAL_ENTRY_UNAVAILABLE" });
    if (
      req.headers.host !== "127.0.0.1:4443" ||
      req.headers["sec-fetch-site"] !== "same-origin" ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      Object.keys(req.query).length !== 1 ||
      typeof req.query.table !== "string"
    )
      return reject(400);
    const table = entries.get(req.query.table);
    if (!table) return reject(404);
    try {
      const qr = await table.loadQr();
      const token = qr.token();
      if (typeof token !== "string" || !token || token.length > 4096) return reject(503);
      return res.json({ schemaVersion: 1, qrToken: token });
    } catch {
      return reject(503);
    }
  });
}
