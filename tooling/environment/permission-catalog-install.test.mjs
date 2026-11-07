import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { it } from "vitest";
import { parseArguments, uuidV7 } from "./permission-catalog-install.mjs";

it("generates time-ordered UUIDv7 references", () => {
  const value = uuidV7(Date.parse("2026-10-07T12:00:00.000Z"), Buffer.alloc(10, 0xff));
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.ok(uuidV7(1) < uuidV7(2));
});

it("requires every release flag exactly once", () => {
  const args = [
    "--env-file",
    "a.env",
    "--confirm-target",
    "local:db",
    "--operator",
    "o",
    "--approved-by",
    "p",
    "--approval-evidence",
    "e",
  ];
  assert.equal(parseArguments(args).approvedByReference, "p");
  assert.throws(() => parseArguments(args.slice(0, 8)), /usage/u);
  assert.throws(() => parseArguments([...args.slice(0, 8), "--operator", "x"]), /usage/u);
  assert.throws(() => parseArguments([...args.slice(0, 9), "--force"]), /usage/u);
});
