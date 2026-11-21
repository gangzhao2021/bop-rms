import { t } from "./i18n/i18n.js";

/**
 * WP-2423 live minor 6: the Section of a dish or combo in its editor. A dish not on the menu (a
 * save that stopped part-way, or taken off on purpose) starts with no section, never the first
 * one: saving places it on the menu in the section chosen, so staff choose it and are told so.
 */
export function MenuSectionSelect({
  value,
  sections,
  onChange,
}: {
  readonly value: string;
  readonly sections: readonly {
    readonly code: string;
    readonly name: string;
    readonly nameZh?: string;
  }[];
  readonly onChange: (code: string) => void;
}) {
  return (
    <label className="dish-editor__field">
      <span>{t("Section")}</span>
      <select
        value={value}
        aria-invalid={value === ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === "" ? (
          <option value="" disabled>
            {t("Choose a section")}
          </option>
        ) : null}
        {sections.map((section) => (
          <option key={section.code} value={section.code}>
            {section.nameZh ? `${section.name} ${section.nameZh}` : section.name}
          </option>
        ))}
      </select>
      {value === "" ? (
        <span className="dish-editor__note" role="note">
          {t(
            "Not on the menu. Choose its section: saving puts it on the menu there (guests see it once the menu is listed).",
          )}
        </span>
      ) : null}
    </label>
  );
}
