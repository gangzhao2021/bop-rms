import console from "node:console";

/**
 * Logs an unexpected failure as its event, error code and source frames only: never the message
 * text of a non-code error, the request, credentials or any order content.
 */
const codeOf = (error) => {
  // A plain Error whose message is an error code (UPPER_SNAKE) carries that code.
  const codeMessage = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? "") ? error.message : null;
  const code = error?.code ?? codeMessage ?? error?.name;
  return { code: /^[A-Za-z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE", codeMessage };
};
/** Set by the database transaction runner on an error thrown after one of its queries failed. */
const databaseFailure = Symbol.for("bop.database.failure");
const sqlStatePattern = /^[0-9A-Z]{5}$/;
const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;
/**
 * WP-2423 item 10: which statement failed, from the safe identifiers the database error carries
 * (packages/database tenant-context), its own or those of what it wraps. Never message text.
 */
const diagnosticOf = (error) => {
  const found = {};
  let at = error;
  for (let depth = 0; depth < 4 && at !== null && typeof at === "object"; depth += 1) {
    // The first statement that failed comes first: what follows it in an aborted transaction
    // (a scope restored in a finally block) only ever says 25P02.
    for (const holder of [at[databaseFailure], at.diagnostic]) {
      if (holder === null || typeof holder !== "object") continue;
      if (found.sqlState === undefined && sqlStatePattern.test(holder.sqlState ?? ""))
        found.sqlState = holder.sqlState;
      if (found.table === undefined && identifierPattern.test(holder.table ?? ""))
        found.table = holder.table;
      if (found.constraint === undefined && identifierPattern.test(holder.constraint ?? ""))
        found.constraint = holder.constraint;
    }
    at = at.cause;
  }
  return found;
};
const framesOf = (error) =>
  String(error?.stack ?? "")
    .match(
      /(?:apps\/(?:api|worker)\/(?:dist|src)|packages\/[a-z]+\/[a-z-]+\/src|tooling\/environment)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
    )
    ?.slice(0, 5) ?? [];
/**
 * Which rule refused, anywhere in the wrapped chain (a fixed word such as TwoBrandVersions; a domain
 * error carries it so the domain stays free of logging). Never any other text.
 */
const ruleOf = (error) => {
  let at = error;
  for (let depth = 0; depth < 8 && at !== undefined && at !== null; depth++) {
    if (typeof at.rule === "string" && /^[A-Za-z]{1,40}$/.test(at.rule)) return at.rule;
    at = at.cause;
  }
  return null;
};
/** The errors already logged, so a request's own report does not say the same failure twice. */
const alreadyLogged = new WeakSet();
export function reportUnexpected(event, error, context = {}) {
  if (error !== null && typeof error === "object") alreadyLogged.add(error);
  const { code, codeMessage } = codeOf(error);
  const rule = ruleOf(error);
  // v15 2026-11-01: a wrapped error names the code of what it wraps (owner services rewrite
  // their own failures generically), up to three levels; codes only.
  const causes = [];
  let deepest = error;
  for (let at = error?.cause; at !== undefined && at !== null && causes.length < 3; at = at.cause) {
    causes.push(codeOf(at).code);
    deepest = at;
  }
  console.error(
    JSON.stringify({
      event,
      code,
      ...(causes.length > 0 ? { causes } : {}),
      ...(rule !== null ? { rule } : {}),
      // A database error raised with a code as its message (e.g. SQLSTATE 55000 with
      // STORE_REFERENCE_SOURCE_INVALID) names that code too; never other message text.
      ...(codeMessage !== null && codeMessage !== code ? { reason: codeMessage } : {}),
      // Which served Store's runtime directory (`stores/<name>`), never a path or reference.
      ...(typeof context.store === "string" &&
      /^stores\/[a-z0-9][a-z0-9-]{0,62}$/.test(context.store)
        ? { store: context.store }
        : {}),
      // Which merchant route failed: the route's own template, which never holds an id.
      ...(typeof context.route === "string" && /^\/[A-Za-z0-9/_:-]{1,120}$/.test(context.route)
        ? { route: context.route }
        : {}),
      // How many identical failures were not logged since the last line (see below).
      ...(Number.isSafeInteger(context.suppressed) && context.suppressed > 0
        ? { suppressed: context.suppressed }
        : {}),
      // Which step of a multi-step action failed (a fixed name such as "Workspace").
      ...(typeof context.step === "string" && /^[A-Za-z]{1,40}$/.test(context.step)
        ? { step: context.step }
        : {}),
      // Why a menu listing review stopped, as raised (a short code, never a reference).
      ...(typeof context.stopReason === "string" &&
      /^[A-Za-z0-9:_.@-]{1,120}$/.test(context.stopReason)
        ? { stopReason: context.stopReason }
        : {}),
      // Which outbox consumer failed (its registered name, e.g. "kitchen.confirmed-order:v1").
      ...(typeof context.consumer === "string" &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/.test(context.consumer)
        ? { consumer: context.consumer }
        : {}),
      ...diagnosticOf(error),
      frames: framesOf(error),
      // Where the wrapped failure itself happened, when something wraps it.
      ...(deepest !== error ? { causeFrames: framesOf(deepest) } : {}),
    }),
  );
}

/**
 * WP-2423 item 10: the line for a merchant request that failed for a reason that is not a refusal.
 * The merchant BFF answers "try again"; this is how the operator learns why. One broken read would
 * otherwise write a line per poll per tablet, and some inputs fail before a session is checked, so
 * each route and code gets its first line at once and then one a minute with how many it stood for.
 * A failure a wrapper around the service already logged is not logged again.
 */
const reportingWindowMs = 60_000;
const reportingKeysMaximum = 512;
export function createMerchantRequestReporter({
  store,
  now = Date.now,
  event = "MERCHANT_REQUEST_UNEXPECTED",
} = {}) {
  const windows = new Map();
  return (route, error) => {
    if (error !== null && typeof error === "object" && alreadyLogged.has(error)) return;
    const { sqlState, table, constraint } = diagnosticOf(error);
    const key = `${route} ${codeOf(error).code} ${sqlState} ${table} ${constraint}`;
    const at = now();
    const window = windows.get(key);
    if (window !== undefined && at - window.since < reportingWindowMs) {
      window.suppressed += 1;
      return;
    }
    if (windows.size >= reportingKeysMaximum) windows.clear();
    windows.set(key, { since: at, suppressed: 0 });
    reportUnexpected(event, error, {
      route,
      ...(store === undefined ? {} : { store }),
      suppressed: window?.suppressed ?? 0,
    });
  };
}
/** The served Store's runtime directory name (`stores/<name>`), when this is one. */
export function storeOfDirectory(directory) {
  return /(?:^|\/)(stores\/[a-z0-9][a-z0-9-]{0,62})\/?$/.exec(String(directory))?.[1];
}
