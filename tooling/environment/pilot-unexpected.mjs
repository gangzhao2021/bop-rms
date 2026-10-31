import console from "node:console";

/**
 * Logs an unexpected failure as its event, error code and source frames only: never the message
 * text of a non-code error, the request, credentials or any order content.
 */
export function reportUnexpected(event, error, context = {}) {
  // A plain Error whose message is an error code (UPPER_SNAKE) carries that code.
  const codeMessage = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? "") ? error.message : null;
  const code = error?.code ?? codeMessage ?? error?.name;
  console.error(
    JSON.stringify({
      event,
      code: /^[A-Za-z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE",
      // A database error raised with a code as its message (e.g. SQLSTATE 55000 with
      // STORE_REFERENCE_SOURCE_INVALID) names that code too; never other message text.
      ...(codeMessage !== null && codeMessage !== code ? { reason: codeMessage } : {}),
      // Which served Store's runtime directory (`stores/<name>`), never a path or reference.
      ...(typeof context.store === "string" &&
      /^stores\/[a-z0-9][a-z0-9-]{0,62}$/.test(context.store)
        ? { store: context.store }
        : {}),
      frames:
        String(error?.stack ?? "")
          .match(
            /(?:apps\/api\/(?:dist|src)|packages\/[a-z]+\/[a-z-]+\/src|tooling\/environment)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
          )
          ?.slice(0, 5) ?? [],
    }),
  );
}
