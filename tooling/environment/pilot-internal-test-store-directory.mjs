import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 3d — InternalTest only, a
 * test-environment-only shortcut. The runtime directory of another TEST Store this InternalTest
 * installation serves (`stores/<name>/`, listed in `stores.json`), derived from the installation's
 * own directory: the same database, roles, keys and staff sign-in; the new Store's scope wherever
 * the installation's Store appears; its own identities where a Store must have its own (public
 * Store, task queue and exception policy, payment admission control, pickup counter, receipt
 * template, provider account); no dining tables yet (staff add them in the product). Secrets are
 * copied byte for byte (owner-only); nothing is read from or sent anywhere else.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export class InternalTestStoreDirectoryError extends Error {
  constructor(reason) {
    super("INTERNAL_TEST_STORE_DIRECTORY_UNAVAILABLE");
    this.reason = reason;
    this.name = "InternalTestStoreDirectoryError";
  }
}
const refuse = (reason) => {
  throw new InternalTestStoreDirectoryError(reason);
};
/** Per file, the fields whose value is a Store's own identity: the new Store gets its own. */
export const storeOwnReferenceFields = Object.freeze({
  "internal-test-profile.json": [
    "publicStoreReference",
    "lookupEvidenceReference",
    "profileReference",
  ],
  "internal-test-task-queue.json": [
    "queueReference",
    "managerQueueReference",
    "policyReference",
    "escalationPolicyReference",
  ],
  "customer-runtime.json": ["controlReference", "providerAccountReference"],
  "merchant-runtime.json": [
    "deviceReference",
    "pickupLocationReference",
    "providerAccountReference",
  ],
  "business-worker.json": ["providerAccountReference"],
  "internal-test-receipt-template.json": ["familyReference", "versionReference"],
});
/** Files that name one Store's dining tables; the new Store has none until staff add them. */
const isTableFile = (name) => /^internal-test-dining-table.*\.json$/u.test(name);
/** Historical copies and records the new Store never had. */
const isHistory = (name) =>
  /\.v\d+-backup\.json$/u.test(name) ||
  /^internal-test-renewal-log\.jsonl$/u.test(name) ||
  name === "stores.json";

/** A stable UUIDv7-shaped reference of the new Store from the setup operation and a label. */
export function storeDirectoryReference(operationReference, label) {
  const digest = createHash("sha256")
    .update("bop-rms/internal-test-store-directory/v1:" + operationReference + ":" + label)
    .digest("hex");
  return (
    operationReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}

/** Pure: the new Store's JSON files from the installation's (parsed). */
export function deriveInternalTestStoreFiles(files, { storeReference, operationReference }) {
  const profile = files["internal-test-profile.json"];
  const installation = files["installation.json"];
  if (
    installation?.environment !== "InternalTest" ||
    profile?.environment !== "InternalTest" ||
    typeof profile?.binding?.storeReference !== "string" ||
    !UUID_V7.test(storeReference) ||
    !UUID_V7.test(operationReference) ||
    storeReference === profile.binding.storeReference
  )
    return refuse("not-internal-test");
  const primary = profile.binding.storeReference;
  const derived = new Map();
  const own = (field, value) => {
    const key = field + ":" + value;
    if (!derived.has(key)) derived.set(key, storeDirectoryReference(operationReference, key));
    return derived.get(key);
  };
  const rewrite = (value, field, fields) => {
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry, field, fields));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, rewrite(entry, key, fields)]),
      );
    if (value === primary) return storeReference;
    if (typeof value === "string" && UUID_V7.test(value) && fields.includes(field))
      return own(field, value);
    return value;
  };
  const result = {};
  for (const [name, value] of Object.entries(files)) {
    if (isTableFile(name) || isHistory(name)) continue;
    const next = rewrite(value, "", storeOwnReferenceFields[name] ?? []);
    if (name === "customer-runtime.json" && Array.isArray(next.diningTableFiles))
      next.diningTableFiles = [];
    result[name] = next;
  }
  // The same queue named twice stays one queue.
  const queue = result["internal-test-task-queue.json"];
  if (queue?.exceptionTaskPolicy && queue.queueReference)
    queue.exceptionTaskPolicy.managerQueueReference = queue.queueReference;
  return Object.freeze(result);
}

/**
 * Writes `stores/<name>/` below the installation directory and lists it in `stores.json`. Refuses
 * outside InternalTest, an existing directory, a name or Store already listed.
 */
export async function issueInternalTestStoreDirectory({
  directory,
  name,
  storeReference,
  operationReference,
}) {
  if (!NAME.test(name)) return refuse("name-invalid");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {},
    copies = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return refuse("symbolic-link");
    if (entry.name.endsWith(".json")) files[entry.name] = JSON.parse(await readFile(path, "utf8"));
    else if (!isHistory(entry.name)) copies.push(entry.name);
  }
  const derived = deriveInternalTestStoreFiles(files, { storeReference, operationReference });
  const listPath = join(directory, "stores.json");
  let list = { schemaVersion: 1, stores: [] };
  try {
    list = JSON.parse(await readFile(listPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") return refuse("stores-list-invalid");
  }
  const relative = "stores/" + name;
  if (
    list?.schemaVersion !== 1 ||
    !Array.isArray(list.stores) ||
    list.stores.includes(relative) ||
    list.stores.length >= 99
  )
    return refuse("stores-list-invalid");
  for (const other of list.stores) {
    const profile = JSON.parse(
      await readFile(join(directory, other, "internal-test-profile.json"), "utf8"),
    );
    if (profile?.binding?.storeReference === storeReference) return refuse("store-already-served");
  }
  await mkdir(join(directory, "stores"), { recursive: true, mode: 0o700 });
  const target = join(directory, relative);
  try {
    await mkdir(target, { mode: 0o700 });
  } catch {
    return refuse("directory-exists");
  }
  for (const file of copies) {
    await writeFile(join(target, file), await readFile(join(directory, file)), { mode: 0o600 });
    await chmod(join(target, file), 0o600);
  }
  // The profile last: services refuse to start until it exists.
  const names = Object.keys(derived).sort((a, b) =>
    a === "internal-test-profile.json"
      ? 1
      : b === "internal-test-profile.json"
        ? -1
        : a < b
          ? -1
          : 1,
  );
  for (const file of names)
    await writeFile(join(target, file), JSON.stringify(derived[file], null, 2) + "\n", {
      mode: 0o600,
    });
  const next = { schemaVersion: 1, stores: [...list.stores, relative] };
  await writeFile(listPath + ".next", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(listPath + ".next", listPath);
  return Object.freeze({ directory: relative, files: names.length + copies.length });
}
