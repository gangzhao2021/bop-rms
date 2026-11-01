import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * WP-2423 取舍 15, TEST-ONLY: a labelled internal-test platform support person, until the formal
 * support sign-in exists (behind the Cognito external gate). It records the person with their own
 * permissions and lists them in the installation's internal-test sign-in as `support-<n>`; they
 * sign in at /internal-test/support. InternalTest only. Prints the reference, never a credential.
 *
 *   node --import ./tooling/environment/register-workspace-typescript.mjs \
 *     tooling/environment/pilot-internal-test-support.mjs add <runtime directory> \
 *     --database <name> --migration-env <file> --name "TEST Support Sam" --reason "<why>"
 *
 * Ending someone's access is `end` with --actor <reference> and --reason.
 */
const fail = (reason) => {
  throw Object.assign(new Error("PILOT_INTERNAL_TEST_SUPPORT_UNAVAILABLE"), { reason });
};
export function parseSupportArguments(args) {
  const [command, directory, ...rest] = args;
  if (!["add", "end"].includes(command) || typeof directory !== "string") fail("arguments-invalid");
  const options = { command, directory };
  const known = { "--database": "database", "--migration-env": "envFile", "--reason": "reason" };
  if (command === "add") known["--name"] = "name";
  else known["--actor"] = "actor";
  for (let i = 0; i < rest.length; i += 2) {
    const name = known[rest[i]];
    if (!name || typeof rest[i + 1] !== "string" || Object.hasOwn(options, name))
      fail("arguments-invalid");
    options[name] = rest[i + 1];
  }
  for (const name of Object.values(known)) if (!options[name]) fail("arguments-invalid");
  if (options.name !== undefined && !/^TEST /u.test(options.name)) fail("name-must-say-test");
  return Object.freeze(options);
}
/** v7-shaped reference, as every other identity here. */
const uuidV7 = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rest = randomUUID().replace(/-/gu, "");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${rest.slice(0, 3)}-8${rest.slice(3, 6)}-${rest.slice(6, 18)}`;
};
async function run(options) {
  const staffFile = path.join(options.directory, "internal-test-merchant.json");
  const database = await import("./pilot-internal-test-renew-database.mjs");
  const installation = JSON.parse(
    await readFile(path.join(options.directory, "installation.json"), "utf8"),
  );
  if (installation.environment !== "InternalTest") fail("not-internal-test");
  if (installation.database !== options.database) fail("database-mismatch");
  const client = await database.connectRenewalDatabase(options.envFile, options.database);
  try {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 90 * 86_400_000).toISOString();
    if (options.command === "end") {
      const latest = (
        await client.query(
          "SELECT version,display_name,effective_until FROM bop_permission.platform_support_person WHERE actor_id=$1 ORDER BY version DESC LIMIT 1",
          [options.actor],
        )
      ).rows[0];
      if (latest === undefined) fail("not-support");
      await client.query(
        "INSERT INTO bop_permission.platform_support_person (actor_id,version,display_name,lifecycle,actions,effective_until,recorded_by_reason,recorded_at) VALUES ($1,$2,$3,'Ended','{}',$4,$5,$6)",
        [
          options.actor,
          Number(latest.version) + 1,
          latest.display_name,
          latest.effective_until,
          options.reason,
          at,
        ],
      );
      return { status: "Ended", actorReference: options.actor };
    }
    const saved = JSON.parse(await readFile(staffFile, "utf8"));
    if (saved.schemaVersion !== 2) fail("session-file-not-multiple");
    const count = saved.actors.filter((entry) => entry.selector.startsWith("support")).length;
    const actorReference = uuidV7();
    await client.query(
      "INSERT INTO bop_permission.platform_support_person (actor_id,version,display_name,lifecycle,actions,effective_until,recorded_by_reason,recorded_at) VALUES ($1,1,$2,'Active',ARRAY['platform.support.view','platform.support.change'],$3,$4,$5)",
      [actorReference, options.name, until, options.reason, at],
    );
    const next = {
      ...saved,
      actors: [
        ...saved.actors,
        { selector: "support-" + (count + 1), actorReference, validUntil: until },
      ],
    };
    await writeFile(staffFile + ".next", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(staffFile + ".next", staffFile);
    return {
      status: "Added",
      actorReference,
      selector: "support-" + (count + 1),
      validUntil: until,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.NODE_ENV !== "development") fail("not-development-mode");
    console.log(JSON.stringify(await run(parseSupportArguments(process.argv.slice(2)))));
  } catch (error) {
    console.error(
      "PILOT_INTERNAL_TEST_SUPPORT_UNAVAILABLE (" + (error?.reason ?? "unexpected-error") + ")",
    );
    process.exitCode = 1;
  }
}
