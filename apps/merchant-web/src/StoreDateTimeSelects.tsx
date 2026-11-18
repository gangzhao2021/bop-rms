import { useEffect, useState } from "react";
import { t } from "./i18n/i18n.js";

/**
 * WP-2423 batch 29 (v15 live28 minor): a Store wall-clock date and time chosen with plain selects
 * labelled in the page's language. A native `datetime-local` box shows the device's own pattern
 * ("yyyy-mm-dd, --:-- --" on an en-CA browser) even on a Chinese page.
 *
 * `value` and `onChange` use the `datetime-local` form ("2026-10-07T14:05", Store time; "" for
 * none), so the caller converts it to an instant exactly as before. A part not chosen yet reads
 * "" until all five are chosen. Minutes go in steps of five; a saved minute between them stays
 * offered.
 */
export function StoreDateTimeSelects({
  label,
  value,
  onChange,
  now = Date.now(),
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (local: string) => void;
  /** The current instant, for the years offered (this year and the next five). */
  readonly now?: number | undefined;
}) {
  const parsed = parse(value);
  const [parts, setParts] = useState<Parts>(parsed);
  // A value the page loads (a saved draft) or clears replaces what is chosen here.
  useEffect(() => {
    setParts((current) => (compose(current) === value ? current : parse(value)));
  }, [value]);
  const thisYear = new Date(now).getUTCFullYear();
  const years = [
    ...new Set([
      ...(parts.year === "" ? [] : [Number(parts.year)]),
      ...Array.from({ length: 6 }, (_, index) => thisYear + index),
    ]),
  ].sort((a, b) => a - b);
  const monthDays =
    parts.year !== "" && parts.month !== ""
      ? new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate()
      : 31;
  const minutes = [
    ...new Set([
      ...Array.from({ length: 12 }, (_, index) => index * 5),
      ...(parts.minute === "" ? [] : [Number(parts.minute)]),
    ]),
  ].sort((a, b) => a - b);
  const change = (key: keyof Parts, next: string) => {
    const updated = { ...parts, [key]: next };
    // A day past the end of a newly chosen month is the month's last day.
    if (updated.year !== "" && updated.month !== "" && updated.day !== "") {
      const last = new Date(Date.UTC(Number(updated.year), Number(updated.month), 0)).getUTCDate();
      if (Number(updated.day) > last) updated.day = String(last);
    }
    setParts(updated);
    onChange(compose(updated));
  };
  const select = (
    key: keyof Parts,
    name: string,
    options: readonly number[],
    text: (option: number) => string = String,
  ) => (
    <label className="store-date-time__part">
      <select
        aria-label={t("{label}: {part}", { label, part: name })}
        value={parts[key] === "" ? "" : String(Number(parts[key]))}
        onChange={(event) => change(key, event.target.value)}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={String(option)}>
            {text(option)}
          </option>
        ))}
      </select>
      <span>{name}</span>
    </label>
  );
  return (
    <fieldset className="store-date-time">
      <legend>{label}</legend>
      {select("year", t("Year"), years)}
      {select(
        "month",
        t("Month"),
        Array.from({ length: 12 }, (_, index) => index + 1),
      )}
      {select(
        "day",
        t("Day"),
        Array.from({ length: monthDays }, (_, index) => index + 1),
      )}
      {select(
        "hour",
        t("Hour of day"),
        Array.from({ length: 24 }, (_, index) => index),
        (hour) => String(hour).padStart(2, "0"),
      )}
      {select("minute", t("Minute"), minutes, (minute) => String(minute).padStart(2, "0"))}
    </fieldset>
  );
}

interface Parts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

const pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u;

function parse(value: string): Parts {
  const found = pattern.exec(value);
  if (found === null) return { year: "", month: "", day: "", hour: "", minute: "" };
  return {
    year: found[1] ?? "",
    month: String(Number(found[2])),
    day: String(Number(found[3])),
    hour: String(Number(found[4])),
    minute: String(Number(found[5])),
  };
}

/** The `datetime-local` form of the chosen parts, or "" while any is not chosen. */
export function compose(parts: Parts): string {
  if (Object.values(parts).some((part) => part === "")) return "";
  const two = (part: string) => part.padStart(2, "0");
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}`;
}
