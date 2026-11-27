import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * WP-2423 item 10: keeps it fixed. An unexpected failure must never read as "you have no
 * permission", and a route or service that writes a new catch block is held to that here.
 *
 * Checked over the source, because the wrong answer needs a real fault to show: a route answers
 * 403 only when its service fails in a way a test would have to invent.
 */
const source = dirname(fileURLToPath(import.meta.url));
const names = readdirSync(source).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);
const routes = names.filter(
  (name) => /^merchant-bff-.*-routes\.ts$/u.test(name) || name === "merchant-staff-pin-http.ts",
);
const services = names.filter(
  (name) =>
    /^(?:persistent-)?merchant-.*\.ts$/u.test(name) &&
    !routes.includes(name) &&
    !/^merchant-bff-/u.test(name) &&
    name !== "merchant-failure.ts",
);

const refusalText =
  /"(?:[A-Z0-9_]*_(?:DENIED|FORBIDDEN)|Denied|PermissionDenied|NotOwner|OwnerOnly)"/u;
const refusalHelper = /^(?:denied|deniedScope|refuse|refused|refusal)$/u;
const unavailableText = /"(?:[A-Z0-9_]*_UNAVAILABLE|[A-Za-z]*Unavailable)"/u;
const unavailableHelper = /^unavailable$/u;

function parse(name: string) {
  return ts.createSourceFile(
    name,
    readFileSync(join(source, name), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function at(file: ts.SourceFile, node: ts.Node) {
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}
function called(node: ts.Node, helper: RegExp) {
  let found = false;
  walk(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      helper.test(child.expression.text)
    )
      found = true;
  });
  return found;
}
/** Whether a handler reads the failure it was given, so that it can tell one failure from another. */
function usesBinding(name: ts.BindingName | undefined, body: ts.Node) {
  if (name === undefined || !ts.isIdentifier(name)) return false;
  let used = false;
  walk(body, (child) => {
    if (ts.isIdentifier(child) && child.text === name.text) used = true;
  });
  return used;
}
/** `.catch(handler)` and `.then(ok, handler)`. */
function promiseHandler(node: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression))
    return undefined;
  if (node.expression.name.text === "catch") return node.arguments[0];
  if (node.expression.name.text === "then") return node.arguments[1];
  return undefined;
}

describe("route catch handlers", () => {
  it("no route writes a catch callback that ignores what failed", () => {
    const offenders: string[] = [];
    for (const name of routes) {
      const file = parse(name);
      walk(file, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
        if (node.expression.name.text !== "catch") return;
        const handler = node.arguments[0];
        if (
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
          handler.parameters.length === 0
        )
          offenders.push(at(file, node));
      });
    }
    expect(offenders).toEqual([]);
  });

  it("denied() in a catch handler is an explicit refusal, or a request that could not be parsed", () => {
    const offenders: string[] = [];
    for (const name of routes) {
      const file = parse(name);
      walk(file, (node) => {
        // `try { parse } catch { denied(response) }`: nothing failed but the request.
        if (ts.isCatchClause(node) && called(node.block, /^denied$/u)) {
          const tried = node.parent.tryBlock.getText();
          if (/\bawait\b|\boptions\b|\.then\(/u.test(tried)) offenders.push(at(file, node));
          return;
        }
        const handler = promiseHandler(node);
        if (
          handler === undefined ||
          !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        )
          return;
        walk(handler, (inner) => {
          if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) return;
          if (inner.expression.text !== "denied") return;
          // The handler looked first, or the `if (...)` around it names the refusal it answers.
          if (handler.getText().includes("isMerchantRefusal(")) return;
          let parent: ts.Node | undefined = inner.parent;
          while (parent !== undefined && parent !== handler) {
            if (ts.isIfStatement(parent) && refusalOrTyped(parent)) return;
            parent = parent.parent;
          }
          offenders.push(at(file, inner));
        });
      });
    }
    expect(offenders).toEqual([]);
  });
});

/** The condition names a refusal code or the route's own typed error whose codes it lists. */
function refusalOrTyped(statement: ts.IfStatement) {
  const text = statement.expression.getText();
  return refusalText.test(text) || /Denied|PERMISSION_DENIED/u.test(text);
}

describe("service catch handlers", () => {
  /**
   * A service may turn a failure into its refusal only by looking at it first: `onlyRefusal`, or a
   * handler that reads the error. Each exception says why it may not hide an outage.
   */
  const refusalAllowed: Readonly<Record<string, string>> = {
    "merchant-brand-administration-http.ts":
      "Brand administration router, not this BFF; every catch reads a request it has just parsed",
  };
  it("no service turns any failure of a read into a refusal", () => {
    const offenders: string[] = [];
    for (const name of services) {
      if (refusalAllowed[name] !== undefined) continue;
      const file = parse(name);
      walk(file, (node) => {
        if (ts.isCatchClause(node)) {
          if (usesBinding(node.variableDeclaration?.name, node.block)) return;
          const text = node.block.getText();
          if (!refusalText.test(text) && !called(node.block, refusalHelper)) return;
          // Nothing awaited in the try: only the request could have failed to parse.
          if (!/\bawait\b|\.then\(|\.catch\(/u.test(node.parent.tryBlock.getText())) return;
          offenders.push(at(file, node));
          return;
        }
        const handler = promiseHandler(node);
        if (handler === undefined) return;
        if (ts.isIdentifier(handler) && refusalHelper.test(handler.text)) {
          const helper = declaredFunction(file, handler.text);
          if (helper !== undefined && helper.parameters.length > 0) return;
          offenders.push(at(file, node));
          return;
        }
        if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
        if (usesBinding(handler.parameters[0]?.name, handler.body)) return;
        if (!refusalText.test(handler.body.getText()) && !called(handler.body, refusalHelper))
          return;
        offenders.push(at(file, node));
      });
    }
    expect(offenders).toEqual([]);
  });

  it("a handler that reads the error does not then refuse whatever else it was", () => {
    const offenders: string[] = [];
    for (const name of services) {
      if (refusalAllowed[name] !== undefined) continue;
      const file = parse(name);
      const check = (node: ts.Node, body: ts.Node) => {
        if (body.getText().includes("isMerchantRefusal(")) return;
        const statements = ts.isBlock(body) ? body.statements : [body];
        const last = statements[statements.length - 1];
        if (last === undefined || !refusesUnconditionally(last)) return;
        offenders.push(at(file, node));
      };
      walk(file, (node) => {
        if (ts.isCatchClause(node) && node.variableDeclaration !== undefined)
          check(node, node.block);
        const handler = promiseHandler(node);
        if (
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
          handler.parameters.length > 0
        )
          check(node, handler.body);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A race answers 409 and reads again with nothing logged: a catch that calls whatever failed a
   * race (a missing grant, a TypeError, a lost table) tells staff "it changed, try again" for ever.
   */
  const changedText =
    /"(?:[A-Z0-9_]*_(?:CONFLICT|NOT_FOUND|CHANGED|EXPIRED)|Conflict|VersionConflict|NotFound|Stale|Changed)"/u;
  it("no service turns any failure into a race", () => {
    const offenders: string[] = [];
    for (const name of services) {
      if (refusalAllowed[name] !== undefined) continue;
      const file = parse(name);
      walk(file, (node) => {
        if (ts.isCatchClause(node)) {
          if (usesBinding(node.variableDeclaration?.name, node.block)) return;
          if (!changedText.test(node.block.getText())) return;
          if (!/\bawait\b|\.then\(|\.catch\(/u.test(node.parent.tryBlock.getText())) return;
          offenders.push(at(file, node));
          return;
        }
        const handler = promiseHandler(node);
        if (handler === undefined) return;
        if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
        if (usesBinding(handler.parameters[0]?.name, handler.body)) return;
        if (!changedText.test(handler.body.getText())) return;
        offenders.push(at(file, node));
      });
    }
    expect(offenders).toEqual([]);
  });

  /** Sites whose rewrite has no failure worth keeping, or that answer on another surface. */
  const causeAllowed: Readonly<Record<string, string>> = {
    "merchant-catalog.ts":
      "The public Menu router, not this BFF: it answers 503 Unavailable itself",
    "merchant-dining-table-close-plan.ts":
      "A close check that could not run is a reason on the plan, shown to staff; nothing failed",
    "merchant-brand-administration-http.ts": "Brand administration router, not this BFF",
  };
  it("a rewrite to an unavailable code keeps what really failed", () => {
    const offenders: string[] = [];
    for (const name of services) {
      if (causeAllowed[name] !== undefined) continue;
      const file = parse(name);
      const rewrites = (body: ts.Node) =>
        unavailableText.test(body.getText()) ||
        called(body, unavailableHelper) ||
        callsUnavailableHelper(file, body);
      walk(file, (node) => {
        if (ts.isCatchClause(node)) {
          if (usesBinding(node.variableDeclaration?.name, node.block)) return;
          if (!rewrites(node.block)) return;
          if (!/\bawait\b|\.then\(|\.catch\(/u.test(node.parent.tryBlock.getText())) return;
          offenders.push(at(file, node));
          return;
        }
        const handler = promiseHandler(node);
        if (handler === undefined) return;
        if (ts.isIdentifier(handler)) {
          const helper = declaredFunction(file, handler.text);
          if (helper !== undefined && helper.parameters.length === 0 && mentionsUnavailable(helper))
            offenders.push(at(file, node));
          return;
        }
        if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
        if (usesBinding(handler.parameters[0]?.name, handler.body)) return;
        if (!rewrites(handler.body)) return;
        offenders.push(at(file, node));
      });
    }
    expect(offenders).toEqual([]);
  });

  it("a handler that looks first and then says unavailable keeps what really failed too", () => {
    const offenders: string[] = [];
    for (const name of services) {
      const file = parse(name);
      const check = (node: ts.Node, binding: ts.BindingName | undefined, body: ts.Node) => {
        const statements = ts.isBlock(body) ? body.statements : [body];
        const last = statements[statements.length - 1];
        if (last === undefined || binding === undefined || !ts.isIdentifier(binding)) return;
        if (!ts.isReturnStatement(last) && !ts.isThrowStatement(last)) {
          if (ts.isBlock(body) || !ts.isCallExpression(last)) return;
        }
        const rewrites = unavailableText.test(last.getText()) || callsUnavailableHelper(file, last);
        if (!rewrites) return;
        // The caught failure goes along, whichever way it is written.
        if (usesBinding(binding, last)) return;
        offenders.push(at(file, node));
      };
      walk(file, (node) => {
        if (ts.isCatchClause(node)) check(node, node.variableDeclaration?.name, node.block);
        const handler = promiseHandler(node);
        if (
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
          handler.parameters.length > 0
        )
          check(node, handler.parameters[0]?.name, handler.body);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A permission decision must not read as an outage: staff without the permission would be told
   * "try again" for ever, and the log would fill with them.
   */
  const permissionAllowed: Readonly<Record<string, string>> = {
    "merchant-paid-order-acceptance.ts":
      "authorizeActor is the run's no-query guard: the permission was decided when the run began",
    "merchant-paid-additional-order-acceptance.ts":
      "authorizeActor is the run's no-query guard: the permission was decided when the run began",
  };
  it("a permission branch never answers with an unavailable code", () => {
    const offenders: string[] = [];
    const permission =
      /\.allowed\(\)|\.authorize\w*\(|\.effect !== "Allow"|\.guard\(\)|\bauthorize\(\)|\bguard\(\)|^!scope$|^scope === null$|\b[aA]llowed\(\)\)$/u;
    for (const name of services) {
      if (permissionAllowed[name] !== undefined) continue;
      const file = parse(name);
      const answersUnavailable = (node: ts.Node) => {
        let found = false;
        walk(node, (child) => {
          if (ts.isStringLiteral(child) && /(?:_UNAVAILABLE|^Unavailable)$/u.test(child.text))
            found = true;
          if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
            const helper = declaredFunction(file, child.expression.text);
            if (
              helper !== undefined &&
              /"[A-Z0-9_]*_UNAVAILABLE"/u.test(helper.body?.getText() ?? "")
            )
              found = true;
          }
        });
        return found;
      };
      walk(file, (node) => {
        if (ts.isIfStatement(node) && permission.test(node.expression.getText())) {
          const then = node.thenStatement;
          const terminal = ts.isBlock(then) ? then.statements[then.statements.length - 1] : then;
          if (
            terminal !== undefined &&
            (ts.isReturnStatement(terminal) || ts.isThrowStatement(terminal)) &&
            answersUnavailable(terminal)
          )
            offenders.push(at(file, node));
        }
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "denied" &&
          ts.isIdentifier(node.initializer)
        ) {
          const helper = declaredFunction(file, node.initializer.text);
          if (
            helper !== undefined &&
            /"[A-Z0-9_]*_UNAVAILABLE"/u.test(helper.body?.getText() ?? "")
          )
            offenders.push(at(file, node));
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/** A `throw`, `return` or expression that names a refusal with no condition on the code it names. */
function refusesUnconditionally(statement: ts.Node) {
  if (
    !ts.isThrowStatement(statement) &&
    !ts.isReturnStatement(statement) &&
    !ts.isExpressionStatement(statement) &&
    !ts.isCallExpression(statement)
  )
    return false;
  let refuses = false;
  walk(statement, (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      refusalHelper.test(child.expression.text) &&
      !(child.arguments[0] !== undefined && ts.isStringLiteral(child.arguments[0]))
    )
      refuses = true;
    if (ts.isStringLiteral(child) && refusalText.test(`"${child.text}"`)) {
      let parent: ts.Node | undefined = child.parent;
      let conditional = false;
      while (parent !== undefined && parent !== statement) {
        if (ts.isConditionalExpression(parent)) conditional = true;
        parent = parent.parent;
      }
      if (!conditional) refuses = true;
    }
  });
  return refuses;
}

/** The helper throws an unavailable code, by default or for good. */
function mentionsUnavailable(helper: ts.Node) {
  return /"[A-Z0-9_]*_UNAVAILABLE"|"Unavailable"|\bnew \w*Unavailable\w*\(/u.test(helper.getText());
}
/** `fail()` or `poison()`, called with no code of their own, where that ends up unavailable. */
function callsUnavailableHelper(file: ts.SourceFile, body: ts.Node, depth = 0): boolean {
  let found = false;
  walk(body, (child) => {
    if (!ts.isCallExpression(child) || !ts.isIdentifier(child.expression)) return;
    if (child.arguments.length > 0) return;
    const helper = declaredFunction(file, child.expression.text);
    if (helper === undefined) return;
    if (mentionsUnavailable(helper)) found = true;
    else if (depth < 2 && callsUnavailableHelper(file, helper, depth + 1)) found = true;
  });
  return found;
}

/** `const name = (...) => ...` or `function name(...)` anywhere in the file. */
function declaredFunction(file: ts.SourceFile, name: string) {
  let found: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined;
  walk(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      found = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
  });
  return found;
}
