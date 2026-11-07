import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * WP-2423 item 10: a server failure covers a lost COMMIT, so the action may be on record. An action
 * that drops its operation on a 5xx mints a new one when staff press again: the guest gets the cash
 * twice (TablePaymentPanel, found by the critique), or the menu gets a second dish.
 *
 * Checked over the source: a catch block must look at the failure before it clears the operation, and
 * a branch reached by any answer but success must have dealt with a 5xx first.
 */
const source = dirname(fileURLToPath(import.meta.url));
const pages = readdirSync(source).filter(
  (name) => /\.tsx$/u.test(name) && !name.endsWith(".test.tsx"),
);
const clearsOperation = (statement: ts.Statement) =>
  ts.isExpressionStatement(statement) &&
  (/^\w*[oO]peration\w*\.current = null$/u.test(statement.expression.getText()) ||
    /^setOperation\(null\)$/u.test(statement.expression.getText()));

it("no catch block clears an operation without looking at what failed", () => {
  const offenders: string[] = [];
  for (const name of pages) {
    const file = ts.createSourceFile(
      name,
      readFileSync(join(source, name), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCatchClause(node))
        for (const statement of node.block.statements)
          if (clearsOperation(statement))
            offenders.push(
              `${name}:${file.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`,
            );
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(offenders).toEqual([]);
});

it("an action that reads the answer's status deals with a 5xx before it clears the operation", () => {
  const offenders: string[] = [];
  for (const name of pages) {
    const file = ts.createSourceFile(
      name,
      readFileSync(join(source, name), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isBlock(node)) {
        let successBranch = false;
        let serverBranch = false;
        for (const statement of node.statements) {
          if (ts.isIfStatement(statement)) {
            const test = statement.expression.getText();
            if (/\bstatus === 2\d\d\b/u.test(test)) successBranch = true;
            if (/\bstatus >= 500\b/u.test(test)) serverBranch = true;
          }
          if (successBranch && !serverBranch && clearsOperation(statement))
            offenders.push(
              `${name}:${file.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`,
            );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(offenders).toEqual([]);
});
