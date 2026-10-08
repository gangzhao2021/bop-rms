import { createContext, useContext } from "react";
import { storeTime } from "./CurrentOrderQueuePage.js";

/** WP-2423: the selected Store's IANA time zone, provided once by the workspace. */
export const StoreTimeZoneContext = createContext<string | undefined>(undefined);

/** A source/record instant as Store-local date and time; the exact UTC instant stays in the title. */
export function SourceTime({ instant }: { readonly instant: string }) {
  const timeZone = useContext(StoreTimeZoneContext);
  if (timeZone === undefined) return <>{instant}</>;
  return (
    <time dateTime={instant} title={instant}>
      {storeTime(instant, timeZone, true)}
    </time>
  );
}
