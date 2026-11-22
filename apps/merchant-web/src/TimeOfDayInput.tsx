import { useId } from "react";
import { guestLocale, t } from "./i18n/i18n.js";

/**
 * Batch 47 (v15 b46: the hours editor's browser time fields read "12:00:00 PM" and "01:00:00 AM",
 * with seconds and the browser's own AM/PM, even on a Chinese screen, beside "12:00 p.m." and
 * "1:00 a.m." on the same page): a Store wall-clock time picked to the minute, written the way the
 * page writes times — "12 : 00 p.m." in English, "12 : 00" (0–23) in Chinese.
 *
 * A browser's time field follows the browser's language, not the page's, and a lang attribute
 * does not change that, so this is a group of ordinary selects: each is reached with Tab, changed
 * with the arrow keys or by typing, and named for screen readers ("Start 1", "Hour").
 */
export interface WallClockParts {
  /** 0–23. */
  readonly hour: number;
  readonly minute: number;
}

/** "17:00:00" → 17 and 0; seconds are not shown. */
export function wallClockParts(value: string): WallClockParts {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
  };
}

/** The saved form, "17:05:00", for a time staff picked to the minute. */
export function wallClockValue(parts: WallClockParts): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(parts.hour)}:${two(parts.minute)}:00`;
}

/** Whether the page's language writes a 12-hour clock, and its words for the two halves. */
export function wallClockStyle(): {
  readonly twelveHour: boolean;
  readonly am: string;
  readonly pm: string;
} {
  const format = new Intl.DateTimeFormat(guestLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const cycle = format.resolvedOptions().hourCycle;
  const period = (hour: number) =>
    format
      .formatToParts(new Date(Date.UTC(2000, 0, 1, hour)))
      .find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM");
  return { twelveHour: cycle === "h12" || cycle === "h11", am: period(1), pm: period(13) };
}

const minutes = Array.from({ length: 60 }, (_, minute) => minute);

export function TimeOfDayInput({
  label,
  value,
  onChange,
}: {
  /** The field's name, "Start 1". */
  readonly label: string;
  /** "HH:MM:SS" as saved. */
  readonly value: string;
  /** Called with "HH:MM:00" when staff pick another hour, minute or half of the day. */
  readonly onChange: (value: string) => void;
}) {
  const labelId = useId();
  const parts = wallClockParts(value);
  const style = wallClockStyle();
  const afternoon = parts.hour >= 12;
  const change = (next: Partial<WallClockParts>) => onChange(wallClockValue({ ...parts, ...next }));
  return (
    <div className="time-of-day" role="group" aria-labelledby={labelId}>
      <span className="time-of-day__label" id={labelId}>
        {label}
      </span>
      <span className="time-of-day__fields">
        <select
          aria-label={t("Hour")}
          value={style.twelveHour ? parts.hour % 12 : parts.hour}
          onChange={(event) => {
            const picked = Number(event.target.value);
            change({ hour: style.twelveHour ? picked + (afternoon ? 12 : 0) : picked });
          }}
        >
          {(style.twelveHour
            ? Array.from({ length: 12 }, (_, n) => n)
            : Array.from({ length: 24 }, (_, n) => n)
          ).map((hour) => (
            <option key={hour} value={hour}>
              {style.twelveHour ? (hour === 0 ? 12 : hour) : hour}
            </option>
          ))}
        </select>
        <span aria-hidden="true">:</span>
        <select
          aria-label={t("Minute")}
          value={parts.minute}
          onChange={(event) => change({ minute: Number(event.target.value) })}
        >
          {minutes.map((minute) => (
            <option key={minute} value={minute}>
              {String(minute).padStart(2, "0")}
            </option>
          ))}
        </select>
        {style.twelveHour && (
          <select
            aria-label={t("a.m. or p.m.")}
            value={afternoon ? "pm" : "am"}
            onChange={(event) =>
              change({ hour: (parts.hour % 12) + (event.target.value === "pm" ? 12 : 0) })
            }
          >
            <option value="am">{style.am}</option>
            <option value="pm">{style.pm}</option>
          </select>
        )}
      </span>
    </div>
  );
}
