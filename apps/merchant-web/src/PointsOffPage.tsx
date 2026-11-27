import { t } from "./i18n/i18n.js";
import { Link } from "react-router";
import { WorkspacePage } from "./WorkspacePage.js";

/**
 * WP-2423 M129: the Points page while the workspace loads or switches Store, or at a Store where
 * points are off. Never the internal Phase-3 placeholder: staff read what is true and what to do.
 */
export function PointsOffPage({
  loading,
  storeFeaturesHref,
}: {
  readonly loading: boolean;
  /** Store features, when this person may open it (to turn points on). */
  readonly storeFeaturesHref: string | null;
}) {
  return (
    <WorkspacePage title={t("Points")}>
      {loading ? (
        <p role="status">{t("Loading points…")}</p>
      ) : (
        <section className="settings-section" aria-label={t("Points")}>
          <p>{t("Points are off for this store.")}</p>
          {storeFeaturesHref === null ? (
            <p>{t("Ask the owner to turn on points.")}</p>
          ) : (
            <p>
              <Link className="shell-action" to={storeFeaturesHref}>
                {t("Turn on in Store features")}
              </Link>
            </p>
          )}
        </section>
      )}
    </WorkspacePage>
  );
}
