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
  productPublicationQuery: "product publication v1 (replaced by the one-page menu)",
  productScopeJournals: "product publication journals (replaced by the one-page menu)",
  reconciliationAssigneeQuery: "reconciliation assignment (not offered in the pilot)",
});

/** The top-level entries of an object literal's source (`{ ... }`), strings skipped. */
function segments(literal) {
  const out = [];
  let depth = 0,
    quote = null,
    start = 1;
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
      out.push(literal.slice(start, index));
      start = index + 1;
    }
  }
  out.push(literal.slice(start, literal.length - 1));
  return out.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

/** The object literals a function body returns at its own level (`return {` / `return Object.freeze({`). */
function returnedLiterals(body) {
  const literals = [];
  let depth = 0,
    quote = null;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (depth === 1 && body.startsWith("return ", index)) {
      const at = /^return\s+(?:Object\.freeze\(\s*)?\{/u.exec(body.slice(index));
      if (at) literals.push(block(body, index + at[0].length - 1));
    }
  }
  return literals;
}

/** The body of `function <name>(...) {` in a source (its parameters may hold braces). */
function functionBody(source, name) {
  const at = source.search(new RegExp(`function ${name}\\(`, "u"));
  if (at < 0) throw new Error("no function " + name);
  let depth = 0;
  for (let index = source.indexOf("(", at); index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")" && --depth === 0)
      return block(source, source.indexOf("{", index));
  }
  throw new Error("unbalanced parameters of " + name);
}

/** Whole-line and block comments go (an apostrophe in a comment is not a string). */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

const pilotSources = new Map();
async function pilotSource(name) {
  if (!pilotSources.has(name))
    pilotSources.set(name, withoutComments(await readFile(new URL(name, import.meta.url), "utf8")));
  return pilotSources.get(name);
}

/**
 * Where a spread in the merchant BFF block gets its ports: a bare name or a call whose object the
 * pilot builds in another file. A spread that is neither listed here nor an inline
 * `...(cond ? {} : { ... })` / `...(() => { return { ... } })()` fails the check, so the port set
 * the test reads stays the one the merchant router really gets.
 */
const spreadSources = Object.freeze({
  product: ["pilot-merchant-product.mjs", "createInternalMerchantProduct"],
  counter: ["pilot-counter-order.mjs", "createInternalCounterOrder"],
  createInternalStoreSetupBff: ["pilot-store-setup.mjs", "createInternalStoreSetupBff"],
  createInternalStoreSetupDraftBff: ["pilot-store-setup.mjs", "createInternalStoreSetupDraftBff"],
  // Inside createInternalMerchantProduct: the product publication ports the API itself builds.
  publication: [
    "../../apps/api/src/merchant-product-runtime.ts",
    "createMerchantProductPublicationRuntime",
  ],
});

/** The object literal that starts at the first `{` after `marker` in `source`. */
function literalAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error("not found: " + marker);
  return block(source, source.indexOf("{", at + marker.length - 1));
}

/** Every key an object literal gives, following its spreads to what they spread. */
async function provided(literal, out = new Set()) {
  for (const key of keys(literal).found) out.add(key);
  for (const segment of segments(literal)) {
    if (!segment.startsWith("...")) continue;
    const named = /^\.\.\.\s*(?:\(\s*(?:await\s+)?)?([A-Za-z_$][\w$]*)\s*(?:\(|\)|$)/u.exec(
      segment,
    );
    if (named && named[1] in spreadSources) {
      const [file, name] = spreadSources[named[1]];
      for (const returned of returnedLiterals(functionBody(await pilotSource(file), name)))
        await provided(returned, out);
      continue;
    }
    // `...(cond ? {} : <else>)` or `...(() => { ... return { ... } })()`.
    const inner = segment.slice(3).trim().replace(/^\(/u, "");
    const otherwise = /^[^?{]*\?\s*\{\s*\}\s*:\s*/u.exec(inner);
    const rest = otherwise ? inner.slice(otherwise[0].length) : inner;
    if (rest.startsWith("{")) {
      await provided(block(rest, 0), out);
      continue;
    }
    const iife = /^\(?\s*(?:async\s*)?\(\)\s*=>\s*\{/u.exec(rest);
    if (iife) {
      for (const returned of returnedLiterals(block(rest, iife[0].length - 1)))
        await provided(returned, out);
      continue;
    }
    throw new Error("a spread this check can't follow: " + segment.slice(0, 80));
  }
  return out;
}

it("builds every port the merchant routes read into the BFF the router gets, or names why the pilot does not offer it", async () => {
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
  // The pilot serves `createMerchantBffRouter(merchant.bff)` (pilot-customer-server.mjs): only
  // what the `bff: { ... }` block gives (its own keys and what its spreads bring) reaches it.
  const server = await pilotSource("pilot-customer-server.mjs");
  expect(server).toContain("createMerchantBffRouter(merchant.bff)");
  expect(server).toContain("createMerchantBffRouter(storeMerchant.bff)");
  const merchant = await pilotSource("pilot-merchant.mjs");
  const bff = literalAfter(merchant, "bff: {");
  const built = await provided(bff);
  // The ports the review named: present in the block itself, not only somewhere in a file.
  for (const port of ["orderQueue", "orderChanges", "storeReports", "counterOrder"])
    expect(built.has(port), port).toBe(true);
  const unwired = [...read].filter((port) => !built.has(port) && !(port in notInPilot)).sort();
  expect(unwired).toEqual([]);
  // The list stays true: each named port is still read by a route and still not built here.
  // (The product publication v2 ports come in through `...product`: the earlier text check,
  // which looked only in the pilot files, listed them here by mistake.)
  expect(Object.keys(notInPilot).filter((port) => !read.has(port) || built.has(port))).toEqual([]);
});

it("the check above follows spreads and fails a port that exists but is not passed to the router", async () => {
  const literal = `{
    orderQueue,
    ...(flag === undefined ? {} : { orderChanges }),
    ...(() => { const control = make({ service, persistence }); return { serviceControl: control }; })(),
  }`;
  const found = await provided(literal);
  expect([...found].sort()).toEqual(["orderChanges", "orderQueue", "serviceControl"]);
  // A factory argument (service, persistence) is not a port the router gets.
  expect(found.has("service")).toBe(false);
  await expect(provided("{ ...unknownSpread }")).rejects.toThrow(/can't follow/u);
});

/**
 * WP-2423 (rush-reads-and-orders-changes review): the ports batches 10-12 added on the guest side
 * reach the pilot's API: pilot-api.mjs → createLocalCustomerRuntime → createApiServerRuntime.
 * Each link is read from the source that builds it.
 */
it("wires the guest-side ports of batches 10-12 into the pilot API composition", async () => {
  const read = async (name) => withoutComments(await readFile(new URL(name, api), "utf8"));
  const [server, runtime, entry, orderStatus, pickupCode, bootstrap] = await Promise.all([
    read("server.ts"),
    read("local-customer-runtime.ts"),
    read("persistent-customer-entry.ts"),
    read("customer-order-status-read.ts"),
    read("customer-pickup-code-read.ts"),
    read("customer-session-bootstrap.ts"),
  ]);
  const pilotApi = await pilotSource("pilot-api.mjs");
  const options = literalAfter(pilotApi, "createLocalCustomerRuntime({");
  const given = keys(options).found;
  for (const port of ["pickupCode", "orderStatus", "entry", "scope", "allowedOrigin"])
    expect(given.has(port), port).toBe(true);
  // b11: "Remove my contact details" and the order and pickup pages under an earlier visit this
  // phone keeps. Contact removal is offered with contactPrivacy, and its handler gets the
  // earlier-visit reader; the order and pickup reads carry it on the port the handler gets.
  const status = literalAfter(options, "orderStatus: {");
  expect(status).toMatch(/\bcontactPrivacy: true\b/u);
  expect(runtime).toMatch(
    /options\.orderStatus\.contactPrivacy === true\s*\?\s*\{\s*customerContactRemoval: \{/u,
  );
  const removal = literalAfter(server, "createCustomerContactRemovalHandler({");
  expect(keys(removal).found.has("forEarlierVisit")).toBe(true);
  expect(removal).toContain("customerContactRemovalForEarlierVisit(customerContactRemoval)");
  expect(server).toContain("port: createCustomerOrderStatusRead(customerOrderStatus)");
  expect(server).toContain("port: createCustomerPickupCodeRead(customerPickupCode)");
  for (const [source, name] of [
    [orderStatus, "createCustomerOrderStatusRead"],
    [pickupCode, "createCustomerPickupCodeRead"],
  ]) {
    const returned = returnedLiterals(functionBody(source, name));
    expect(
      returned.some((literal) => keys(literal).found.has("forEarlierVisit")),
      name,
    ).toBe(true);
  }
  expect(runtime).toMatch(
    /options\.pickupCode === undefined \|\| options\.orderStatus === undefined/u,
  );
  // b10: the table that is not open is named, read in the entry's own transaction.
  const table = literalAfter(entry, "table: {");
  expect(keys(table).found.has("label")).toBe(true);
  // b12: phones asking for the same menu at once share one read, detached from each request.
  expect(runtime).toMatch(
    /createSharedCustomerMenuPort\(customerMenu, \{ detached: runDetachedRead \}\)/u,
  );
  // b13: the visit restore reads the moved, settled and ended visit through the same port.
  expect(server).toContain("port: createCustomerSessionBootstrapRead(customerSessionBootstrap)");
  const restore = returnedLiterals(functionBody(bootstrap, "createCustomerSessionBootstrapRead"));
  const restoreKeys = new Set(restore.flatMap((literal) => [...keys(literal).found]));
  for (const port of ["read", "readMovedTable", "readSettledTable", "readEndedVisit"])
    expect(restoreKeys.has(port), port).toBe(true);
  expect(runtime).toMatch(/customerSessionBootstrap: \{\s*\.\.\.options\.orderStatus,/u);
  // b12/b13: every request at the entry has its answer time (reads answer busy in time).
  const front = await pilotSource("pilot-customer-server.mjs");
  expect(front).toMatch(/withRequestAcquireBudget\(next, \{/u);
});
