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
export function reportUnexpected(event, error, context = {}) {
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
      // Which step of a multi-step action failed (a fixed name such as "Workspace").
      ...(typeof context.step === "string" && /^[A-Za-z]{1,40}$/.test(context.step)
        ? { step: context.step }
        : {}),
      // Which outbox consumer failed (its registered name, e.g. "kitchen.confirmed-order:v1").
      ...(typeof context.consumer === "string" &&
      /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/.test(context.consumer)
        ? { consumer: context.consumer }
        : {}),
      frames: framesOf(error),
      // Where the wrapped failure itself happened, when something wraps it.
      ...(deepest !== error ? { causeFrames: framesOf(deepest) } : {}),
    }),
  );
}
