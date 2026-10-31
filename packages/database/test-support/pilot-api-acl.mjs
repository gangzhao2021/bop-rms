import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";

/**
 * WP-2423: give one restricted NOBYPASSRLS test role exactly the rendered pilot API grants (the
 * exported matrix plus the Owner-approved additions, api principal only), so a read composed of
 * several owners' sources (e.g. the guest order status phase merge) cannot drift from the deployed
 * ACL. Grants only add privileges; earlier step-by-step fixture grants stay as they are.
 */
export async function grantPilotApiAcl(admin, role) {
  const root = new URL("../../../docs/spec/", import.meta.url);
  const matrices = await Promise.all(
    ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) => {
      const matrix = JSON.parse(await readFile(new URL(file, root), "utf8"));
      return { ...matrix, entries: matrix.entries.filter((entry) => entry.principal === "api") };
    }),
  );
  // No worker entries remain; the distinct worker name only satisfies the renderer's invariant.
  await admin.query(renderPilotAclSql(matrices, { api: role, worker: "pilot_acl_worker_unused" }));
}
