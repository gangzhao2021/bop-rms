import { parseCatalogReference } from "../../contracts/product.js";

/**
 * WP-2423 / DEC-MENU-REVISION: the Brand's Menus for the back office — each Menu's current version and
 * where it stands in review/publication, and the Menu's latest release. Caller authorizes and owns
 * the transaction; reads run in the Brand scope.
 */
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export interface MenuPublicationStatus {
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly state: "Draft" | "InReview" | "Approved" | "Published" | "Archived" | string;
  readonly snapshotDigest: string;
  readonly changedAt: string;
}
export interface MenuReleaseSummary {
  readonly releaseReference: string;
  readonly sequence: number;
  readonly menuVersionReference: string;
  readonly createdAt: string;
}
export interface BrandMenuSummary {
  readonly menuReference: string;
  readonly internalCode: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly placements: number;
  readonly publication: MenuPublicationStatus | null;
  readonly latestRelease: MenuReleaseSummary | null;
}
const statusOf = (value: unknown): MenuPublicationStatus | null => {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return Object.freeze({
    lifecycleReference: String(r.lifecycle),
    lifecycleVersion: Number(r.version),
    state: String(r.state),
    snapshotDigest: String(r.digest),
    changedAt: String(r.changedAt),
  });
};
const releaseOf = (value: unknown): MenuReleaseSummary | null => {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return Object.freeze({
    releaseReference: String(r.release),
    sequence: Number(r.sequence),
    menuVersionReference: String(r.version),
    createdAt: String(r.createdAt),
  });
};

export async function listBrandMenus(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<readonly BrandMenuSummary[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brand,
  ]);
  return (
    await tx.query(
      `SELECT m.menu_id::text menu,m.internal_code,m.aggregate_version,m.current_version_id::text version,
        v.localized_names_json names,
        (SELECT count(*) FROM rms_catalog.sellable_placement p JOIN rms_catalog.menu_section s
          ON s.menu_section_id=p.menu_section_id AND s.menu_id=p.menu_id AND s.brand_id=p.brand_id
          WHERE s.menu_version_id=m.current_version_id)::int placements,
        (SELECT jsonb_build_object('lifecycle',r.lifecycle_id,'version',r.lifecycle_version,'state',r.state,
          'digest',r.snapshot_digest,'changedAt',${iso("r.changed_at")})
          FROM rms_catalog.menu_publication_revision r WHERE r.brand_id=m.brand_id AND r.menu_id=m.menu_id
          AND r.menu_version_id=m.current_version_id ORDER BY r.lifecycle_version DESC LIMIT 1) publication,
        (SELECT jsonb_build_object('release',l.release_id,'sequence',l.release_sequence,'version',l.menu_version_id,
          'createdAt',${iso("l.created_at")})
          FROM rms_catalog.menu_publication_release l WHERE l.brand_id=m.brand_id AND l.menu_id=m.menu_id
          ORDER BY l.release_sequence DESC LIMIT 1) latest_release
       FROM rms_catalog.menu m JOIN rms_catalog.menu_version v ON v.menu_version_id=m.current_version_id
        AND v.menu_id=m.menu_id AND v.brand_id=m.brand_id
       WHERE m.brand_id=$1 ORDER BY m.internal_code`,
      [brand],
    )
  ).rows.map((row) =>
    Object.freeze({
      menuReference: String(row.menu),
      internalCode: String(row.internal_code),
      aggregateVersion: Number(row.aggregate_version),
      currentVersionReference: String(row.version),
      localizedNames: (row.names ?? {}) as Readonly<Record<string, string>>,
      placements: Number(row.placements),
      publication: statusOf(row.publication),
      latestRelease: releaseOf(row.latest_release),
    }),
  );
}
