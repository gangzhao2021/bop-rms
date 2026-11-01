import path from "node:path";
import process from "node:process";
import fs from "node:fs/promises";
import {
  admitServedStores,
  loadServedStoreDirectories,
  reportConnectionBudget,
} from "./pilot-served-stores.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { readPilotRoleLimit } from "./pilot-connections.mjs";

/** The api role's usable connections for this installation; null when they can't be read. */
async function configuredRoleLimit(directory) {
  try {
    const { connection } = await loadPilotInstallation(directory);
    const password = (await fs.readFile(connection.passwordFile("api"), "utf8")).trim();
    return await readPilotRoleLimit({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user("api"),
      password,
      ssl: false,
      connectionTimeoutMillis: 2000,
    });
  } catch {
    return null;
  }
}
/** Which Stores to run; unreadable limits admit them all, and the database then says why. */
export async function admitConfiguredStores(runtimeDirectory, relatives) {
  const absolute = path.join(await fs.realpath(process.cwd()), runtimeDirectory);
  const limit = relatives.length === 0 ? null : await configuredRoleLimit(absolute);
  const result = admitServedStores(relatives, limit);
  reportConnectionBudget(result.refused, limit);
  return result;
}
export async function loadAdmittedServedStores(directory) {
  const relatives = await loadServedStoreDirectories(directory);
  if (relatives.length === 0) return relatives;
  const limit = await configuredRoleLimit(directory);
  const result = admitServedStores(relatives, limit);
  reportConnectionBudget(result.refused, limit);
  return result.admitted;
}
