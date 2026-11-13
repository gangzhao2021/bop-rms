import { readdir, readFile } from "node:fs/promises";
import { URL } from "node:url";
import { expect, it } from "vitest";

/**
 * v15 2026-10-28 (1d070d5f): the merchant BFF called `options.storeReports.tonight(...)` but the
 * pilot composition built `storeReports` as an object without `tonight`, so the route answered 400
 * on the pilot only. This check reads the merchant BFF routes for every `options.<name>.<method>(`
 * they call and, wherever the pilot composition builds that option as an object of its own (a
 * wrapper, not a factory's result), requires every called method to be there.
 */
const api = new URL("../../apps/api/src/", import.meta.url);
const pilot = new URL("./pilot-merchant.mjs", import.meta.url);

/** The source from `open` (an opening brace) to its matching close, strings skipped. */
function block(source, open) {
  let depth = 0,
    quote = null;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error("unbalanced object at " + open);
}

/**
 * The top-level keys of an object literal's source (`key:`, `key,`, `key(`). A `...spread` of
 * another object brings that object's own methods, so the literal then counts as complete.
 */
function keys(literal) {
  const found = new Set();
  let spread = false;
  let depth = 0,
    quote = null,
    start = 1;
  const take = (segment) => {
    if (segment.trim().startsWith("...")) spread = true;
    const match = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|$)/u.exec(segment);
    if (match) found.add(match[1]);
  };
  for (let index = 1; index < literal.length - 1; index++) {
    const char = literal[index];
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      take(literal.slice(start, index));
      start = index + 1;
    }
  }
  take(literal.slice(start, literal.length - 1));
  return { found, spread };
}

it("wires every method the merchant BFF routes call on options the pilot builds itself", async () => {
  const files = (await readdir(api)).filter(
    (name) => /^merchant-bff.*\.ts$/u.test(name) && !name.endsWith(".test.ts"),
  );
  const called = new Map();
  for (const name of files) {
    const source = (await readFile(new URL(name, api), "utf8")).replace(/\s+/gu, " ");
    for (const match of source.matchAll(
      /options\.([A-Za-z_$][\w$]*) ?\. ?([A-Za-z_$][\w$]*) ?\(/gu,
    ))
      called.set(match[1], new Set([...(called.get(match[1]) ?? []), match[2]]));
  }
  expect(called.get("storeReports")).toEqual(
    new Set(["read", "tonight", "export", "storeTonight"]),
  );
  // Whole-line comments only (a "//" inside a string, such as a URL, stays).
  const composition = (await readFile(pilot, "utf8")).replace(/^\s*\/\/.*$/gmu, "");
  const missing = [];
  let checked = 0;
  for (const [option, methods] of called) {
    // Built as its own object: `const <option> = {` or passed inline as `<option>: {`.
    const declared = new RegExp(`const ${option} = \\{`, "u").exec(composition);
    const inline = new RegExp(`\\b${option}: \\{`, "u").exec(composition);
    const at = declared ?? inline;
    if (at === null) continue;
    checked++;
    const present = keys(block(composition, at.index + at[0].length - 1));
    if (present.spread) continue;
    for (const method of methods)
      if (!present.found.has(method)) missing.push(`${option}.${method}`);
  }
  expect(checked).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});

it("DEC-PILOT-ALERTS-BACKUP correction 2: the composition's audience reaches the Home's read", async () => {
  const pilot = await readFile(new URL("./pilot-merchant.mjs", import.meta.url), "utf8");
  const read = pilot.slice(pilot.indexOf("createPersistentMerchantOperationsAlerts({"));
  expect(read.slice(0, read.indexOf("})"))).toContain("audience: operationsAlertAudience");
});

it("AGENTS.md \"Warn before timeouts\": any staff member's read comes from this Store's own board", async () => {
  const pilot = await readFile(new URL("./pilot-merchant.mjs", import.meta.url), "utf8");
  const read = pilot.slice(pilot.indexOf("createPersistentMerchantOrderingEnding({"));
  expect(read.slice(0, read.indexOf("})"))).toContain("readBoard: readOperationsAlertBoard");
  expect(pilot).toContain("...(orderingEnding === undefined ? {} : { orderingEnding })");
});

it("WP-2423 M160: a Store's settlement days begin at its own first day, not at the installation's coverage file", async () => {
  // v15 2026-11-06: every dated Settlement of a merchant other than the installation's own Store
  // failed (PILOT_INSTALLATION_UNAVAILABLE): its first day came from daily-settlement-coverage.json,
  // which names the one Store the reconciliation scheduler runs for.
  const pilot = await readFile(new URL("./pilot-merchant.mjs", import.meta.url), "utf8");
  const call = pilot.slice(pilot.indexOf("createPilotMerchantSettlement({"));
  expect(call.slice(0, call.indexOf("})"))).not.toContain("Coverage");
  expect(pilot).not.toContain("loadDailySettlementCoverage");
  const settlement = await readFile(
    new URL("./pilot-merchant-settlement.mjs", import.meta.url),
    "utf8",
  );
  expect(settlement).not.toMatch(/Coverage\b|firstBusinessDate/u);
  // The settlement read takes the first day from the Store's business-day owner, always.
  const read = await readFile(new URL("persistent-merchant-settlement.ts", api), "utf8");
  expect(read).toMatch(
    /firstBusinessDate: async \(tx, scope\) => \{\s*await authorize\(tx\);\s*return days\(tx, scope\)\.firstBusinessDate\(tx\);/u,
  );
});

it("WP-2423 (settlement-coverage): Settlement says BOP was told only from this Store's own board", async () => {
  const pilot = await readFile(new URL("./pilot-merchant.mjs", import.meta.url), "utf8");
  const call = pilot.slice(pilot.indexOf("createPilotMerchantSettlement({"));
  expect(call.slice(0, call.indexOf("refundConfiguration,") + 120)).toContain(
    "...(readOperationsAlertBoard === undefined ? {} : { readOperationsAlertBoard })",
  );
  const settlement = await readFile(
    new URL("./pilot-merchant-settlement.mjs", import.meta.url),
    "utf8",
  );
  expect(settlement).toContain(
    "isOperationsAlertSentToSupport(\n              await readOperationsAlertBoard(),",
  );
  expect(settlement).toContain('"settlement.not_run"');
});

it("WP-2423 (settlement-coverage): Settlement learns where this Store's day-end checks start", async () => {
  const pilot = await readFile(new URL("./pilot-merchant.mjs", import.meta.url), "utf8");
  const call = pilot.slice(pilot.indexOf("createPilotMerchantSettlement({"));
  expect(call.slice(0, call.indexOf("INTERNAL_OPERATIONS_ALERTS_UNAVAILABLE"))).toContain(
    "...(dayEndCheckCoveredFrom === undefined ? {} : { dayEndCheckCoveredFrom })",
  );
  const settlement = await readFile(
    new URL("./pilot-merchant-settlement.mjs", import.meta.url),
    "utf8",
  );
  expect(settlement).toContain(
    "...(dayEndCheckCoveredFrom === undefined ? {} : { dayEndCheckCoveredFrom })",
  );
  const composition = await readFile(
    new URL("./pilot-merchant-composition.mjs", import.meta.url),
    "utf8",
  );
  expect(composition).toContain(
    "dayEndCheckCoveredFrom: createDayEndCheckCoveredFrom({ installation })",
  );
});

/**
 * WP-2423 (rush-reads-and-orders-changes, v15 2026-11-13): GET /merchant/orders/changes answered
 * 503 on every poll because this composition passed `orderQueue` but not `orderChanges` (the API's
 * own merchant-runtime wires both), and the route's "not wired" 503 logged a level-50 fault from
 * every open Orders screen. Every port the merchant routes read must be built here, or be named
 * below with why the pilot does not offer it, so a route added later can't go live unwired.
 */
const notInPilot = Object.freeze({
  // Earlier authoring flows the pilot workspace replaced with the one-page menu (WP-2423 item 8 ⑥)
  // and Store setup; they existed before batch 10 and were never part of this composition.
  brandLifecycle: "brand lifecycle commands (organization setup outside the pilot workspace)",
  brandStoreTopologyClock: "brand Store topology drafts (organization setup)",
  brandStoreTopologyDraft: "brand Store topology drafts (organization setup)",
  categoryTree: "category tree authoring (replaced by the one-page menu)",
  menuDraft: "menu draft authoring (replaced by the one-page menu)",
  menuPublication: "menu publication (replaced by the one-page menu's List it)",
  priceBooks: "price book commands (prices are set on the one-page menu)",
  productCategoryLookup: "product authoring (replaced by the one-page menu)",
  productDraftBaseline: "product authoring (replaced by the one-page menu)",
  productPublication: "product publication v1 (replaced by the one-page menu)",
  productPublicationManagement: "product publication v1 (replaced by the one-page menu)",
  productPublicationManagementV2: "product publication v2 (replaced by the one-page menu)",
  productPublicationQuery: "product publication v1 (replaced by the one-page menu)",
  productPublicationResolution: "product publication v1 (replaced by the one-page menu)",
  productPublicationV2: "product publication v2 (replaced by the one-page menu)",
  productPublicationValidationReportV2: "product publication v2 (replaced by the one-page menu)",
  productPublicationWarningAcknowledgement: "product publication (replaced by the one-page menu)",
  productScopeJournals: "product publication journals (replaced by the one-page menu)",
  reconciliationAssigneeQuery: "reconciliation assignment (not offered in the pilot)",
});

it("builds every port the merchant routes read, or names why the pilot does not offer it", async () => {
  const contract = await readFile(new URL("merchant-bff-contract.ts", api), "utf8");
  const start = contract.indexOf("export interface MerchantBffRouterOptions {");
  expect(start).toBeGreaterThan(0);
  const body = contract.slice(start, contract.indexOf("\n}\n", start));
  const ports = new Set(
    [...body.matchAll(/^ {2}readonly ([A-Za-z_$][\w$]*)\??:/gmu)].map((m) => m[1]),
  );
  const files = (await readdir(api)).filter(
    (name) => /^merchant-bff.*\.ts$/u.test(name) && !name.endsWith(".test.ts"),
  );
  const read = new Set();
  for (const name of files) {
    const source = (await readFile(new URL(name, api), "utf8")).replace(/^\s*\/\/.*$/gmu, "");
    for (const match of source.matchAll(/\boptions\.([A-Za-z_$][\w$]*)/gu))
      if (ports.has(match[1])) read.add(match[1]);
  }
  // The routes read the ports this test is about (the Orders change mark among them).
  expect(read.has("orderQueue")).toBe(true);
  expect(read.has("orderChanges")).toBe(true);
  const here = new URL("./", import.meta.url);
  const compositions = (await readdir(here)).filter(
    (name) => /^pilot-.*\.mjs$/u.test(name) && !name.endsWith(".test.mjs"),
  );
  let composed = "";
  for (const name of compositions)
    composed += (await readFile(new URL(name, here), "utf8")).replace(/^\s*\/\/.*$/gmu, "") + "\n";
  const built = (port) =>
    new RegExp(`(?:^|[\\s{,(])${port.replace("$", "\\$")}\\s*(?::|,|\\}|\\)|$)`, "mu").test(
      composed,
    );
  const unwired = [...read].filter((port) => !built(port) && !(port in notInPilot)).sort();
  expect(unwired).toEqual([]);
  // The list stays true: each named port is still read by a route and still not built here.
  for (const port of Object.keys(notInPilot)) {
    expect(read.has(port), port).toBe(true);
    expect(built(port), port).toBe(false);
  }
  // The Orders change mark is in the BFF the pilot serves, beside the Orders list.
  const pilotSource = (await readFile(pilot, "utf8")).replace(/^\s*\/\/.*$/gmu, "");
  const bff = block(pilotSource, pilotSource.indexOf("bff: {") + 5);
  const present = keys(bff).found;
  expect(present.has("orderQueue")).toBe(true);
  expect(present.has("orderChanges")).toBe(true);
});
