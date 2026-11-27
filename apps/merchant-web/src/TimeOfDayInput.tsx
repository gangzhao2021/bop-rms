import { useId } from "react";
import { t } from "./i18n/i18n.js";

/**
 * Batch 47 (v15 b46: the hours editor's browser time fields read "12:00:00 PM" and "01:00:00 AM",
 * with seconds and the browser's own AM/PM, even on a Chinese screen, beside "12:00 p.m." and
 * "1:00 a.m." on the same page): a Store wall-clock time picked to the minute, written the way the
 * page writes times. Batch 64: the staff clock, "09 : 00" (00–23), in English and Chinese.
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

const hours = Array.from({ length: 24 }, (_, hour) => hour);
const minutes = Array.from({ length: 60 }, (_, minute) => minute);

/**
 * Batch 47 review: the end of the day, as the hours model writes a whole day (00:00–23:59:59). A
 * period can't end at the time it starts, so a day open from midnight can't end at 12:00 a.m.;
 * picked to the minute it would end at 11:59 p.m. and turn guests away in the day's last minute.
 */
export const endOfDayLocalTime = "23:59:59";

export function TimeOfDayInput({
  label,
  value,
  onChange,
  endOfDay = false,
}: {
  /** The field's name, "Start 1". */
  readonly label: string;
  /** "HH:MM:SS" as saved. */
  readonly value: string;
  /** Called with "HH:MM:00" when staff pick another hour, minute or half of the day. */
  readonly onChange: (value: string) => void;
  /** An end field: also offers the end of the day ("Midnight (end of day)", "24:00（当天结束）"). */
  readonly endOfDay?: boolean;
}) {
  const labelId = useId();
  const parts = wallClockParts(value);
  const atEndOfDay = endOfDay && value === endOfDayLocalTime;
  const change = (next: Partial<WallClockParts>) => onChange(wallClockValue({ ...parts, ...next }));
  return (
    <div className="time-of-day" role="group" aria-labelledby={labelId}>
      <span className="time-of-day__label" id={labelId}>
        {label}
      </span>
      <span className="time-of-day__fields">
        {/* Batch 48 (v15 b47: the end Hour select took the width of its end-of-day choice, 168 px
            against 36 px, so "1 : 00 a.m." stood in a long empty field): hours and minutes keep
            one compact width, and the end-of-day choice widens its field only while it is shown. */}
        <select
          aria-label={t("Hour")}
          className={
            atEndOfDay ? "time-of-day__hour time-of-day__hour--end-of-day" : "time-of-day__hour"
          }
          value={atEndOfDay ? "end" : parts.hour}
          onChange={(event) => {
            if (event.target.value === "end") {
              onChange(endOfDayLocalTime);
              return;
            }
            const picked = Number(event.target.value);
            // From the end of the day, an hour picked is that evening's, on the hour.
            change({ hour: picked, ...(atEndOfDay ? { minute: 0 } : {}) });
          }}
        >
          {hours.map((hour) => (
            <option key={hour} value={hour}>
              {String(hour).padStart(2, "0")}
            </option>
          ))}
          {endOfDay && <option value="end">{t("Midnight (end of day)")}</option>}
        </select>
        {atEndOfDay ? null : (
          <>
            <span aria-hidden="true">:</span>
            <select
              aria-label={t("Minute")}
              className="time-of-day__minute"
              value={parts.minute}
              onChange={(event) => change({ minute: Number(event.target.value) })}
            >
              {minutes.map((minute) => (
                <option key={minute} value={minute}>
                  {String(minute).padStart(2, "0")}
                </option>
              ))}
            </select>
          </>
        )}
      </span>
    </div>
  );
}
