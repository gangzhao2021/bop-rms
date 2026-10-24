#!/usr/bin/env node
import process from "node:process";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  brandRoleTemplateProfiles,
  storeRoleTemplateProfiles,
} from "../../packages/bop/permission/src/index.ts";

/**
 * WP-2423 Q5: which Store/Brand roles count as Manager, Owner and Finance for ordinary refunds
 * (requester: Manager; independent approver: Owner or Finance). Only role codes of the installed
 * Store/Brand role catalog are accepted, each in one group; a synthetic or unknown role never
 * confers refund authority. The catalog has no finance role yet, so Finance is empty.
 */
export const standardRefundRoleMapping = Object.freeze({
  Manager: Object.freeze([storeRoleTemplateProfiles["store-manager"].roleCode]),
  Owner: Object.freeze([
    storeRoleTemplateProfiles.owner.roleCode,
    brandRoleTemplateProfiles["brand-owner"].roleCode,
  ]),
  Finance: Object.freeze([]),
});
const catalogRoleCodes = new Set([
  ...Object.values(storeRoleTemplateProfiles).map((profile) => profile.roleCode),
  ...Object.values(brandRoleTemplateProfiles).map((profile) => profile.roleCode),
]);
const groups = ["Manager", "Owner", "Finance"];
const invalid = () => {
  throw new Error("PILOT_REFUND_ROLE_MAPPING_INVALID");
};

/** Closed { Manager, Owner, Finance } of catalog role codes, each code in one group only. */
export function validateRefundRoleMapping(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== groups.length ||
    !groups.every((group) => Object.hasOwn(value, group))
  )
    return invalid();
  const seen = new Set();
  const result = {};
  for (const group of groups) {
    const list = value[group];
    if (!Array.isArray(list) || list.length > 100) return invalid();
    for (const code of list) {
      if (typeof code !== "string" || !catalogRoleCodes.has(code) || seen.has(code))
        return invalid();
      seen.add(code);
    }
    result[group] = Object.freeze([...list]);
  }
  return Object.freeze(result);
}

const sameMapping = (a, b) =>
  groups.every(
    (group) => JSON.stringify([...a[group]].sort()) === JSON.stringify([...b[group]].sort()),
  );

/** Rewrites only roleMapping of merchant-runtime.json, atomically and with the same file mode. */
export async function applyStandardRefundRoleMapping({ directory, write }) {
  const path = join(directory, "merchant-runtime.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return invalid();
  const runtime = JSON.parse(await readFile(path, "utf8"));
  if (runtime?.environment !== "InternalTest" || typeof runtime.roleMapping !== "object")
    return invalid();
  const before = runtime.roleMapping;
  const changed = !sameMapping(
    {
      Manager: before.Manager ?? [],
      Owner: before.Owner ?? [],
      Finance: before.Finance ?? [],
    },
    standardRefundRoleMapping,
  );
  if (write && changed) {
    const next = { ...runtime, roleMapping: standardRefundRoleMapping };
    const temporary = path + ".tmp-" + process.pid;
    const handle = await open(temporary, "wx", stat.mode & 0o777);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return Object.freeze({
    before,
    after: standardRefundRoleMapping,
    changed,
    written: write && changed,
  });
}

async function main(argv) {
  let directory = null,
    write = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--directory") directory = argv[++index] ?? null;
    else if (argv[index] === "--write") write = true;
    else throw new Error("Usage: --directory <runtime dir> [--write]");
  }
  if (directory === null) throw new Error("Usage: --directory <runtime dir> [--write]");
  const result = await applyStandardRefundRoleMapping({ directory: resolve(directory), write });
  process.stdout.write(
    JSON.stringify(
      {
        before: result.before,
        after: result.after,
        changed: result.changed,
        written: result.written,
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      (error instanceof Error && /^(Usage|PILOT_)/u.test(error.message)
        ? error.message
        : "PILOT_REFUND_ROLE_MAPPING_UNAVAILABLE") + "\n",
    );
    process.exitCode = 1;
  });
