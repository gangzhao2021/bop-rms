import { currentLanguage, listSeparator, t } from "./i18n/i18n.js";

/**
 * Owner 2026-11-03: a Chinese-language store reads its system alerts in Chinese. The monitor sends
 * its catalog's English (tooling/environment/pilot-alerts.mjs), already filled in with durations,
 * counts and names; these are matched by that exact English, and the values carried over. Text that
 * matches nothing (an older or newer monitor) is shown as the monitor wrote it, never blank.
 */
const lookup = (words: Readonly<Record<string, string>>, english: string): string =>
  Object.hasOwn(words, english) ? (words[english] as string) : english;

export function alertAction(english: string): string {
  // English is the monitor's own text, word for word.
  if (currentLanguage() === "en") return english;
  const [, left] =
    /^Ordering at this Store stops in (.+) unless BOP support renews it\. Call BOP support now\. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine\.$/u.exec(
      english,
    ) ?? [];
  if (left !== undefined)
    return t(
      "Ordering at this Store stops in {duration} unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
      { duration: duration(left) },
    );
  const words: Readonly<Record<string, string>> = {
    "Follow the store outage procedure (pause online ordering, take paper orders). Ask BOP support to check the store system and restart it.":
      t(
        "Follow the store outage procedure (pause online ordering, take paper orders). Ask BOP support to check the store system and restart it.",
      ),
    "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask BOP support to restart the store system.":
      t(
        "Pause online ordering if staff screens still work, otherwise follow the store outage procedure. Ask BOP support to restart the store system.",
      ),
    "Follow the store outage procedure. Ask BOP support to check the store system and restart it.":
      t(
        "Follow the store outage procedure. Ask BOP support to check the store system and restart it.",
      ),
    "Ask BOP support to check the store system and restart it.": t(
      "Ask BOP support to check the store system and restart it.",
    ),
    "Ask BOP support to find out what failed and restart the part named in this alert. Check Orders and Exceptions for work that may be waiting.":
      t(
        "Ask BOP support to find out what failed and restart the part named in this alert. Check Orders and Exceptions for work that may be waiting.",
      ),
    "Do not take a second payment from guests who say they paid. Check Orders and Exceptions; ask BOP support to review the stuck updates and send them again.":
      t(
        "Do not take a second payment from guests who say they paid. Check Orders and Exceptions; ask BOP support to review the stuck updates and send them again.",
      ),
    'Hand over ready orders in person: check the order number plus the guest\'s name or phone number. Compare the kitchen board with Orders. Ask BOP support to look into this now; if it is not fixed, this becomes "Order or payment updates are stuck".':
      t(
        'Hand over ready orders in person: check the order number plus the guest\'s name or phone number. Compare the kitchen board with Orders. Ask BOP support to look into this now; if it is not fixed, this becomes "Order or payment updates are stuck".',
      ),
    'Open Orders: these orders are listed first with today\'s. Make and hand over one the guest still wants, or cancel it (the guest is refunded and the ingredients go back into stock). For an order that is already finished, choose "Release held ingredients".':
      t(
        'Open Orders: these orders are listed first with today\'s. Make and hand over one the guest still wants, or cancel it (the guest is refunded and the ingredients go back into stock). For an order that is already finished, choose "Release held ingredients".',
      ),
    "Take pickup orders on paper (order sheet, items, name, time) and take payment on the card machine, then enter them once this clears. Ask BOP support to check the pickup times now.":
      t(
        "Take pickup orders on paper (order sheet, items, name, time) and take payment on the card machine, then enter them once this clears. Ask BOP support to check the pickup times now.",
      ),
    "Nothing changes for guests yet. Ask BOP support to check the pickup times today; if it reaches the last hour, take pickup orders on paper.":
      t(
        "Nothing changes for guests yet. Ask BOP support to check the pickup times today; if it reaches the last hour, take pickup orders on paper.",
      ),
    "Tell guests who ask that their receipt will appear on their order page once this is fixed. Owner: in Store setup choose a receipt template that is published (step 5), then send, approve and publish the setup (step 8). Receipts for orders paid meanwhile then follow automatically; if this lasted over 30 minutes, ask BOP support to send stuck updates again.":
      t(
        "Tell guests who ask that their receipt will appear on their order page once this is fixed. Owner: in Store setup choose a receipt template that is published (step 5), then send, approve and publish the setup (step 8). Receipts for orders paid meanwhile then follow automatically; if this lasted over 30 minutes, ask BOP support to send stuck updates again.",
      ),
    "Pause all services in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New orders: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter paper orders, refunded ones too; a slip whose order is open: accept it, mark it ready, don't remake it.":
      t(
        "Pause all services in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New orders: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter paper orders, refunded ones too; a slip whose order is open: accept it, mark it ready, don't remake it.",
      ),
    "Pause pickup in Hours & ordering until closing (can resume early). New pickup orders: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. An unaccepted order refunds itself. Call BOP support now; stay on paper until they say it is fixed. Then enter paper orders, refunded ones too; a slip whose order is open: accept it, mark it ready, don't remake it.":
      t(
        "Pause pickup in Hours & ordering until closing (can resume early). New pickup orders: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. An unaccepted order refunds itself. Call BOP support now; stay on paper until they say it is fixed. Then enter paper orders, refunded ones too; a slip whose order is open: accept it, mark it ready, don't remake it.",
      ),
    "Pause dine-in in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New rounds: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter the paper orders; for a slip with an order number, accept that order, mark it ready, do not remake it.":
      t(
        "Pause dine-in in Hours & ordering until closing (can resume early). Tell seated tables to order with staff. New rounds: paper slip, card machine. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter the paper orders; for a slip with an order number, accept that order, mark it ready, do not remake it.",
      ),
    "Tables that pay before each round order further rounds with staff: paper slip, card machine. Tables that pay at the end carry on as usual. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter the paper orders; for a slip with an order number, accept that order, mark it ready, do not remake it.":
      t(
        "Tables that pay before each round order further rounds with staff: paper slip, card machine. Tables that pay at the end carry on as usual. A guest who paid: no second payment; kitchen slip with order number. Call BOP support now; stay on paper until they say it is fixed. Then enter the paper orders; for a slip with an order number, accept that order, mark it ready, do not remake it.",
      ),
    "Tables that pay before each round: one with an unpaid round cannot be closed and that round cannot be cancelled here, so trying again will not help. Seat the next party at another table and note those tables. Tables that pay at the end carry on and close once they pay. Call BOP support now: they have to fix this. Close the noted tables once they say it is fixed.":
      t(
        "Tables that pay before each round: one with an unpaid round cannot be closed and that round cannot be cancelled here, so trying again will not help. Seat the next party at another table and note those tables. Tables that pay at the end carry on and close once they pay. Call BOP support now: they have to fix this. Close the noted tables once they say it is fixed.",
      ),
    "Nothing to do in the store today. Ask BOP support to fix this before you turn pickup on.": t(
      "Nothing to do in the store today. Ask BOP support to fix this before you turn pickup on.",
    ),
    "Nothing to do in the store today. Ask BOP support to fix this before you turn dine-in on.": t(
      "Nothing to do in the store today. Ask BOP support to fix this before you turn dine-in on.",
    ),
    'Take new orders on paper (items, name, table or pickup time) and take payment on the card machine, then enter them once this clears. Owner: Store setup step 8, choose "Use the live Store\'s settings" for tax, then send, approve and publish. Otherwise ask BOP support.':
      t(
        'Take new orders on paper (items, name, table or pickup time) and take payment on the card machine, then enter them once this clears. Owner: Store setup step 8, choose "Use the live Store\'s settings" for tax, then send, approve and publish. Otherwise ask BOP support.',
      ),
    "Open Exceptions to see each difference. For a business day's totals, open Settlement and choose that day; it explains the difference and what to do.":
      t(
        "Open Exceptions to see each difference. For a business day's totals, open Settlement and choose that day; it explains the difference and what to do.",
      ),
    "Open Settlement, review the listed business day and resolve each item.": t(
      "Open Settlement, review the listed business day and resolve each item.",
    ),
    "Ask BOP support to run the backup by hand and check free disk space. Store operation is not affected.":
      t(
        "Ask BOP support to run the backup by hand and check free disk space. Store operation is not affected.",
      ),
    "Ask BOP support to run a backup now and check that the scheduled backup is running.": t(
      "Ask BOP support to run a backup now and check that the scheduled backup is running.",
    ),
    "Ask BOP support to take a new backup and test that it can be restored. Keep the previous backups.":
      t(
        "Ask BOP support to take a new backup and test that it can be restored. Keep the previous backups.",
      ),
    "Ask BOP support to check the off-site folder or drive is connected and has space.": t(
      "Ask BOP support to check the off-site folder or drive is connected and has space.",
    ),
    "Ask BOP support to renew the secure connection certificate and set up the new one on staff devices.":
      t(
        "Ask BOP support to renew the secure connection certificate and set up the new one on staff devices.",
      ),
    "Approve a new end date and ask BOP support to renew it during a planned update before it expires.":
      t(
        "Approve a new end date and ask BOP support to renew it during a planned update before it expires.",
      ),
    "Ask BOP support to free space (old system files, old backup copies) or add storage.": t(
      "Ask BOP support to free space (old system files, old backup copies) or add storage.",
    ),
    "Ask BOP support to find out why these checks could not run.": t(
      "Ask BOP support to find out why these checks could not run.",
    ),
    "Check the alert account details and send a test alert. Watch this Home screen meanwhile.": t(
      "Check the alert account details and send a test alert. Watch this Home screen meanwhile.",
    ),
    // DEC-PILOT-ALERTS-BACKUP correction 2: on a merchant's own board.
    "Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to check the store system.":
      t(
        "Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to check the store system.",
      ),
    "Pause online ordering if staff screens still work. Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to restart the store system.":
      t(
        "Pause online ordering if staff screens still work. Keep taking orders on your own POS or on paper, and take payment on the card machine. Ask BOP support to restart the store system.",
      ),
    "Some background work has stopped. Check Orders and Exceptions for waiting work; BOP support has to restart it.":
      t(
        "Some background work has stopped. Check Orders and Exceptions for waiting work; BOP support has to restart it.",
      ),
    "Call BOP support now. Keep taking orders on your own POS or on paper, and take payment on the card machine.":
      t(
        "Call BOP support now. Keep taking orders on your own POS or on paper, and take payment on the card machine.",
      ),
    // What only BOP can act on.
    "BOP support: record this Store's first closed business day so its day-end settlement starts.":
      t(
        "BOP support: record this Store's first closed business day so its day-end settlement starts.",
      ),
  };
  return Object.hasOwn(words, english)
    ? (words[english] as string)
    : (storesAttentionAction(english) ?? english);
}

/** The other Stores' row says one step for each cause it names, whichever apply. */
function storesAttentionAction(english: string): string | null {
  const [, steps] = /^BOP support: (.+)\.$/u.exec(english) ?? [];
  if (steps === undefined) return null;
  const words: Readonly<Record<string, string>> = {
    "run the status check": t("run the status check"),
    "run the status check and find out why the checks named here are not running": t(
      "run the status check and find out why the checks named here are not running",
    ),
    "restart the background work named here": t("restart the background work named here"),
    "record the first closed business day of those with no settlement": t(
      "record the first closed business day of those with no settlement",
    ),
    "renew those named as ending soon, right after the installation itself (their owners hear only in the last day)":
      t(
        "renew those named as ending soon, right after the installation itself (their owners hear only in the last day)",
      ),
    "set the support number in the alert settings, so their owners have someone to call": t(
      "set the support number in the alert settings, so their owners have someone to call",
    ),
  };
  const said = steps.split("; ").map((step) => (Object.hasOwn(words, step) ? words[step] : null));
  return said.every((step) => step !== null)
    ? t("BOP support: {steps}.", { steps: said.join("；") })
    : null;
}

function duration(english: string): string {
  if (english === "a while") return t("a while");
  if (english === "less than a minute") return t("less than a minute");
  const [, count, unit] = /^(\d+) (minute|hour|day)s?$/u.exec(english) ?? [];
  if (count === undefined) return english;
  if (unit === "minute") return t("{count} minutes", { count });
  return unit === "hour" ? t("{count} hours", { count }) : t("{count} days", { count });
}

/** Time left in the chosen language, by the monitor's own rule for the catalog's durations. */
export function timeLeftWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const english =
    minutes < 1
      ? "less than a minute"
      : minutes < 60
        ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
        : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return currentLanguage() === "en" ? english : duration(english);
}

function serviceName(english: string): string {
  const words: Readonly<Record<string, string>> = {
    "A background task": t("A background task"),
    "Staff and ordering service": t("Staff and ordering service"),
    "Customer ordering pages and staff screens": t("Customer ordering pages and staff screens"),
    "Order processing": t("Order processing"),
    "Kitchen board updates": t("Kitchen board updates"),
    "Payment checks": t("Payment checks"),
    "Day-end settlement": t("Day-end settlement"),
    "Table service follow-ups": t("Table service follow-ups"),
    "Background work": t("Background work"),
    "Background work of the other Stores": t("Background work of the other Stores"),
  };
  const parts: Readonly<Record<string, string>> = {
    "order updates": t("order updates"),
    "waiting for payment results": t("waiting for payment results"),
    "stock release": t("stock release"),
    "unpaid pickup expiry": t("unpaid pickup expiry"),
    "table checkout expiry": t("table checkout expiry"),
    "refunds to guests' cards from table payments": t(
      "refunds to guests' cards from table payments",
    ),
    "customer contact deletion": t("customer contact deletion"),
    "old card payment message deletion": t("old card payment message deletion"),
    "pickup times": t("pickup times"),
    cancellations: t("cancellations"),
    "automatic refunds": t("automatic refunds"),
    "kitchen board": t("kitchen board"),
    "payment checks": t("payment checks"),
    "day-end settlement": t("day-end settlement"),
    "table follow-ups": t("table follow-ups"),
    "background work": t("background work"),
  };
  const [, name, part] = /^(.+) \((.+)\)$/u.exec(english) ?? [];
  if (name === undefined || part === undefined) return lookup(words, english);
  return t("{name} ({part})", { name: lookup(words, name), part: lookup(parts, part) });
}

function serviceList(english: string): string {
  const more = english.endsWith(" and more");
  const names = (more ? english.slice(0, -" and more".length) : english)
    .split(", ")
    .map(serviceName)
    .join(listSeparator());
  return more ? t("{names} and more", { names }) : names;
}

function backupStage(english: string): string {
  const words: Readonly<Record<string, string>> = {
    dump: t("dump"),
    "restore check": t("restore check"),
    "off-site copy": t("off-site copy"),
    retention: t("retention"),
    backup: t("backup"),
  };
  return lookup(words, english);
}

function lowDisk(english: string): string {
  const [, disk, free, percent] = /^(.+) has (.+) free \((\d+)%\)$/u.exec(english) ?? [];
  if (disk === undefined || free === undefined || percent === undefined) return english;
  const disks: Readonly<Record<string, string>> = {
    "the store data folder": t("the store data folder"),
    "the backup folder": t("the backup folder"),
    "the database disk": t("the database disk"),
    "the off-site backup folder": t("the off-site backup folder"),
  };
  return t("{disk} has {free} free ({percent}%)", { disk: lookup(disks, disk), free, percent });
}

function checkSource(english: string): string {
  const words: Readonly<Record<string, string>> = {
    "the service status": t("the service status"),
    "payment and settlement status": t("payment and settlement status"),
    "the backup status": t("the backup status"),
    "the certificate": t("the certificate"),
    "the store setup end date": t("the store setup end date"),
    "disk space": t("disk space"),
    "the receipt template check": t("the receipt template check"),
    "the check for orders holding stock": t("the check for orders holding stock"),
    "the check for pickup times": t("the check for pickup times"),
    "the check that orders can be priced": t("the check that orders can be priced"),
    "the check of the store's order rules": t("the check of the store's order rules"),
    "the check for payment differences": t("the check for payment differences"),
    "the day-end settlement check": t("the day-end settlement check"),
    "the check for closed business days": t("the check for closed business days"),
  };
  return lookup(words, english);
}

function alertChannels(english: string): string {
  const words: Readonly<Record<string, string>> = {
    Email: t("Email alerts"),
    "Phone/webhook": t("Phone alerts"),
    "An alert channel": t("Another alert channel"),
  };
  return english
    .split(" and ")
    .map((name) => lookup(words, name))
    .join(listSeparator());
}

type Match = readonly (string | undefined)[];
/** The summaries that carry a value, one rule per wording of the catalog. */
const SUMMARY_RULES: readonly (readonly [RegExp, (match: Match) => string])[] = [
  [
    /^The ordering service has failed its health check for (.+)\. Staff screens and online ordering are probably not working\.$/u,
    (m) =>
      t(
        "The ordering service has failed its health check for {duration}. Staff screens and online ordering are probably not working.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^The secure customer ordering page has not loaded for (.+)\. Guests cannot scan, order or pay online\.$/u,
    (m) =>
      t(
        "The secure customer ordering page has not loaded for {duration}. Guests cannot scan, order or pay online.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^The staff app \(Orders, Kitchen, Pickup\) has not loaded for (.+)\.$/u,
    (m) =>
      t("The staff app (Orders, Kitchen, Pickup) has not loaded for {duration}.", {
        duration: duration(m[1] as string),
      }),
  ],
  [
    /^The part of the system that watches background work last reported (.+) ago\. Background work \(kitchen updates, payment checks, refunds\) may have stopped\.$/u,
    (m) =>
      t(
        "The part of the system that watches background work last reported {duration} ago. Background work (kitchen updates, payment checks, refunds) may have stopped.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^(.+) has kept failing and will not fix itself\.$/u,
    (m) =>
      t("{names} has kept failing and will not fix itself.", {
        names: serviceList(m[1] as string),
      }),
  ],
  [
    /^(.+) have kept failing and will not fix themselves\.$/u,
    (m) =>
      t("{names} have kept failing and will not fix themselves.", {
        names: serviceList(m[1] as string),
      }),
  ],
  [
    /^(\d+) updates? \(such as a payment result or an order change\) could not be processed after automatic retries \(oldest (.+) ago\)\. Paid orders may look unpaid, not reach the kitchen, or not show as ready for pickup after the kitchen finished them\.$/u,
    (m) =>
      t(
        "{count} updates (such as a payment result or an order change) could not be processed after automatic retries (oldest {duration} ago). Paid orders may look unpaid, not reach the kitchen, or not show as ready for pickup after the kitchen finished them.",
        { count: m[1] as string, duration: duration(m[2] as string) },
      ),
  ],
  [
    /^(\d+) order updates? (?:is|are) being retried \(failing for (.+)\)\. Ready orders may not show for pickup yet, and kitchen or payment changes may be late\.$/u,
    (m) =>
      t(
        "{count} order updates are being retried (failing for {duration}). Ready orders may not show for pickup yet, and kitchen or payment changes may be late.",
        { count: m[1] as string, duration: duration(m[2] as string) },
      ),
  ],
  [
    /^(\d+) orders? from (?:an )?earlier days? still (?:has|have) ingredients set aside \(the oldest for (.+)\)\. Items made from them can show as sold out to guests although the stock is on the shelf\.$/u,
    (m) =>
      t(
        "{count} orders from earlier days still have ingredients set aside (the oldest for {duration}). Items made from them can show as sold out to guests although the stock is on the shelf.",
        { count: m[1] as string, duration: duration(m[2] as string) },
      ),
  ],
  [
    /^Pickup times are set up only for the next (.+)\. After that, guests cannot place pickup orders online and staff cannot take them at the counter\.$/u,
    (m) =>
      t(
        "Pickup times are set up only for the next {duration}. After that, guests cannot place pickup orders online and staff cannot take them at the counter.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^(\d+) differences? between the store's records and the payment provider (?:is|are) still open \(oldest (.+) ago\)\. A difference can be one payment or a business day's totals\.$/u,
    (m) =>
      t(
        "{count} differences between the store's records and the payment provider are still open (oldest {duration} ago). A difference can be one payment or a business day's totals.",
        { count: m[1] as string, duration: duration(m[2] as string) },
      ),
  ],
  [
    /^(\d+) settlement problems? (?:is|are) still open \(oldest (.+) ago\)\.$/u,
    (m) =>
      t("{count} settlement problems are still open (oldest {duration} ago).", {
        count: m[1] as string,
        duration: duration(m[2] as string),
      }),
  ],
  [
    /^The scheduled backup failed at the (.+) step\. It will retry automatically \((\d+) tr(?:y|ies) left today\)\.$/u,
    (m) =>
      t(
        "The scheduled backup failed at the {stage} step. It will retry automatically ({count} tries left today).",
        { stage: backupStage(m[1] as string), count: m[2] as string },
      ),
  ],
  [
    /^The scheduled backup failed at the (.+) step\. No more automatic tries today\.$/u,
    (m) =>
      t("The scheduled backup failed at the {stage} step. No more automatic tries today.", {
        stage: backupStage(m[1] as string),
      }),
  ],
  [
    /^The newest successful backup is (.+) old\. If the server failed now, recent orders and payments could be lost\.$/u,
    (m) =>
      t(
        "The newest successful backup is {duration} old. If the server failed now, recent orders and payments could be lost.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^It expires in (.+)\. After that, guests and staff devices will refuse to open the store pages\.$/u,
    (m) =>
      t(
        "It expires in {duration}. After that, guests and staff devices will refuse to open the store pages.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^It expires in (.+)\. After that, guests cannot order and staff cannot use the store screens\.$/u,
    (m) =>
      t(
        "It expires in {duration}. After that, guests cannot order and staff cannot use the store screens.",
        { duration: duration(m[1] as string) },
      ),
  ],
  [
    /^(.+)\. When it fills, orders and backups stop\.$/u,
    (m) =>
      t("{disks}. When it fills, orders and backups stop.", {
        disks: (m[1] as string).split("; ").map(lowDisk).join(listSeparator()),
      }),
  ],
  [
    /^The system could not read (.+)\. Problems there would not be reported\.$/u,
    (m) =>
      t("The system could not read {sources}. Problems there would not be reported.", {
        sources: (m[1] as string).split(", ").map(checkSource).join(listSeparator()),
      }),
  ],
  [
    /^(.+) alerts have failed for (.+)\. The Owner may not be told about problems\.$/u,
    (m) =>
      t("{channels} alerts have failed for {duration}. The Owner may not be told about problems.", {
        channels: alertChannels(m[1] as string),
        duration: duration(m[2] as string),
      }),
  ],
];

function storeNames(english: string): string {
  const names = (value: string) => value.split(", ").join(listSeparator());
  const [, shown, more] = /^(.+) and (\d+) more$/u.exec(english) ?? [];
  return shown === undefined || more === undefined
    ? names(english)
    : t("{names} and {count} more", { names: names(shown), count: more });
}
/** The other Stores' summary is a sentence for each thing they need, whichever apply. */
const STORES_ATTENTION_RULES: readonly (readonly [RegExp, (names: string) => string])[] = [
  [/^Not being checked: (.+)\.$/u, (names) => t("Not being checked: {names}.", { names })],
  [
    /^Some checks could not run: (.+)\.$/u,
    (names) => t("Some checks could not run: {names}.", { names }),
  ],
  [
    /^Background work needs a person: (.+)\.$/u,
    (names) => t("Background work needs a person: {names}.", { names }),
  ],
  [
    /^Closed business days with no day-end settlement: (.+)\.$/u,
    (names) => t("Closed business days with no day-end settlement: {names}.", { names }),
  ],
  [
    /^Ordering setup ending soon: (.+)\.$/u,
    (names) => t("Ordering setup ending soon: {names}.", { names }),
  ],
  [
    /^No support number to call: (.+)\.$/u,
    (names) => t("No support number to call: {names}.", { names }),
  ],
];
function storesAttentionSummary(english: string): string | null {
  const sentences = english.split(/(?<=\.) (?=[A-Z])/u).map((sentence) => {
    for (const [pattern, say] of STORES_ATTENTION_RULES) {
      const match = pattern.exec(sentence);
      if (match !== null) return say(storeNames(match[1] as string));
    }
    return null;
  });
  return sentences.every((sentence) => sentence !== null) ? sentences.join("") : null;
}

/** "More about this": the monitor's summary in the chosen language. */
export function alertSummary(english: string): string {
  // English is the monitor's own text, word for word.
  if (currentLanguage() === "en") return english;
  const words: Readonly<Record<string, string>> = {
    "The part of the system that watches background work has not reported since the checks started. Background work (kitchen updates, payment checks, refunds) may have stopped.":
      t(
        "The part of the system that watches background work has not reported since the checks started. Background work (kitchen updates, payment checks, refunds) may have stopped.",
      ),
    "No pickup times are set up for now, so guests cannot place pickup orders online and staff cannot take them at the counter. Dine-in is not affected.":
      t(
        "No pickup times are set up for now, so guests cannot place pickup orders online and staff cannot take them at the counter. Dine-in is not affected.",
      ),
    "The Store's published settings could not be read, so guests who pay now do not get a receipt yet.":
      t(
        "The Store's published settings could not be read, so guests who pay now do not get a receipt yet.",
      ),
    "The receipt template chosen in Store setup cannot be used, so guests who pay now do not get a receipt. Orders, payments and the kitchen are not affected.":
      t(
        "The receipt template chosen in Store setup cannot be used, so guests who pay now do not get a receipt. Orders, payments and the kitchen are not affected.",
      ),
    "The Store's published settings could not be read, so no new order can be priced, online or at the counter. Orders already paid are not affected.":
      t(
        "The Store's published settings could not be read, so no new order can be priced, online or at the counter. Orders already paid are not affected.",
      ),
    "The tax settings published in Store setup are not the ones this store is set up to charge, so no new order can be priced, online or at the counter. Orders already paid are not affected.":
      t(
        "The tax settings published in Store setup are not the ones this store is set up to charge, so no new order can be priced, online or at the counter. Orders already paid are not affected.",
      ),
    "Guests cannot order or pay on their phones, and staff may not be able to enter, accept or finish orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.":
      t(
        "Guests cannot order or pay on their phones, and staff may not be able to enter, accept or finish orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.",
      ),
    "Guests cannot order or pay for pickup on their phones, and staff may not be able to enter, accept or finish pickup orders here. A pause tells guests to order with staff. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed. Dine-in is not affected.":
      t(
        "Guests cannot order or pay for pickup on their phones, and staff may not be able to enter, accept or finish pickup orders here. A pause tells guests to order with staff. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed. Dine-in is not affected.",
      ),
    "Guests at tables cannot order or pay on their phones, and staff may not be able to enter, accept or finish table orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end. Pickup is not affected.":
      t(
        "Guests at tables cannot order or pay on their phones, and staff may not be able to enter, accept or finish table orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end. Pickup is not affected.",
      ),
    "Some guests can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end, rounds may not send at all. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.":
      t(
        "Some guests can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end, rounds may not send at all. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.",
      ),
    "Guests can still order pickup and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed. Dine-in is not affected.":
      t(
        "Guests can still order pickup and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed. Dine-in is not affected.",
      ),
    "Guests at tables can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end nobody pays per round: its rounds may not send at all, and it still pays at the end. Pickup is not affected.":
      t(
        "Guests at tables can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end nobody pays per round: its rounds may not send at all, and it still pays at the end. Pickup is not affected.",
      ),
    "Guests cannot order or pay for pickup on their phones, and staff may not be able to enter, accept or finish pickup orders here. A pause tells guests to order with staff. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.":
      t(
        "Guests cannot order or pay for pickup on their phones, and staff may not be able to enter, accept or finish pickup orders here. A pause tells guests to order with staff. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.",
      ),
    "Guests at tables cannot order or pay on their phones, and staff may not be able to enter, accept or finish table orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end.":
      t(
        "Guests at tables cannot order or pay on their phones, and staff may not be able to enter, accept or finish table orders here. A pause tells new guests to order with staff; it does not reach seated tables. A table that pays at the end still pays at the end.",
      ),
    "Guests can still order pickup and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.":
      t(
        "Guests can still order pickup and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. A paid pickup order nobody can accept is refunded automatically about 30 minutes after payment (Orders shows the time), even if the guest has it. With their agreement take payment on the card machine and note it on the incident sheet now (a loss if they decline). Enter it as a Counter order recorded after an outage only once BOP support says it is fixed.",
      ),
    "Guests at tables can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end nobody pays per round: its rounds may not send at all, and it still pays at the end.":
      t(
        "Guests at tables can still order and pay on their phones, but staff may not be able to accept or finish those orders, so they may not reach the kitchen. At a table that pays at the end nobody pays per round: its rounds may not send at all, and it still pays at the end.",
      ),
    "At tables that pay before each round, unpaid rounds are not cancelled automatically and a manager cannot cancel them. They stay open and keep their ingredients set aside, so dishes can show as sold out to other guests, and the table cannot be closed for the next party. At a table that pays at the end, only a round waiting for staff is affected: it can be sent to the kitchen but not cancelled.":
      t(
        "At tables that pay before each round, unpaid rounds are not cancelled automatically and a manager cannot cancel them. They stay open and keep their ingredients set aside, so dishes can show as sold out to other guests, and the table cannot be closed for the next party. At a table that pays at the end, only a round waiting for staff is affected: it can be sent to the kitchen but not cancelled.",
      ),
    "Guests at a table who pay round by round can still pay for another round on their phones, but that round may not reach the kitchen. First rounds, and tables that pay at the end, are not affected.":
      t(
        "Guests at a table who pay round by round can still pay for another round on their phones, but that round may not reach the kitchen. First rounds, and tables that pay at the end, are not affected.",
      ),
    "This store does not offer pickup now, so guests and staff are not affected. If pickup were turned on, pickup orders would not go through.":
      t(
        "This store does not offer pickup now, so guests and staff are not affected. If pickup were turned on, pickup orders would not go through.",
      ),
    "This store does not offer dine-in now, so guests and staff are not affected. If dine-in were turned on, table orders would not go through.":
      t(
        "This store does not offer dine-in now, so guests and staff are not affected. If dine-in were turned on, table orders would not go through.",
      ),
    "No successful backup has been recorded for this store yet.": t(
      "No successful backup has been recorded for this store yet.",
    ),
    "The automatic restore check of the newest backup failed, so it may not be usable.": t(
      "The automatic restore check of the newest backup failed, so it may not be usable.",
    ),
    "The encrypted copy of the newest backup could not be written to the off-site location. The local backup is fine.":
      t(
        "The encrypted copy of the newest backup could not be written to the off-site location. The local backup is fine.",
      ),
    "Guests and staff devices will refuse to open the store pages.": t(
      "Guests and staff devices will refuse to open the store pages.",
    ),
    "Guests cannot order and staff cannot use the store screens until it is renewed.": t(
      "Guests cannot order and staff cannot use the store screens until it is renewed.",
    ),
    "Guests cannot order and staff cannot use the store screens until BOP support renews it.": t(
      "Guests cannot order and staff cannot use the store screens until BOP support renews it.",
    ),
    "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.":
      t(
        "When it stops, guests cannot order and staff cannot use the store screens. Only BOP support can renew it.",
      ),
    "This Store has a closed business day but no day-end settlement, so its payments are not being compared with the payment provider.":
      t(
        "This Store has a closed business day but no day-end settlement, so its payments are not being compared with the payment provider.",
      ),
  };
  if (Object.hasOwn(words, english)) return words[english] as string;
  for (const [pattern, say] of SUMMARY_RULES) {
    const match = pattern.exec(english);
    if (match !== null) return say(match);
  }
  return storesAttentionSummary(english) ?? english;
}
