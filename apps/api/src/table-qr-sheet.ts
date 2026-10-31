import { encodeQrMatrix, renderQrSvg } from "./qr-code-matrix.js";

/**
 * WP-2423 Q11: the printable sheet of table QR codes, generated on the server. One card per table:
 * the code (6 cm), the table label and plain instructions for guests; a small line tells staff
 * until when the code works. No internal codes or references are printed.
 */
export interface TableQrSheetCard {
  readonly tableLabel: string;
  readonly url: string;
  readonly validUntil: string;
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const day = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(instant));

export function renderTableQrSheet(input: {
  readonly storeName: string;
  readonly timeZone: string;
  readonly cards: readonly TableQrSheetCard[];
}): string {
  if (input.cards.length < 1 || input.cards.length > 100) throw new Error("TABLE_QR_SHEET_INVALID");
  const cards = input.cards
    .map((card) => {
      const url = new URL(card.url);
      if (url.protocol !== "https:" || !url.hash.startsWith("#qr="))
        throw new Error("TABLE_QR_SHEET_INVALID");
      const label = escape(card.tableLabel);
      const svg = renderQrSvg(encodeQrMatrix(card.url), "QR code for table " + card.tableLabel);
      return (
        `<article class="card"><p class="store">${escape(input.storeName)}</p>` +
        `<h2>Table ${label}</h2><a class="code" href="${escape(card.url)}">${svg}</a>` +
        `<p class="lead">Scan to order and pay from your phone</p>` +
        `<ol><li>Open your phone camera and point it at the code.</li>` +
        `<li>Ask your server for this table's joining code.</li>` +
        `<li>Order and pay at your table. No app or account needed.</li></ol>` +
        `<p class="valid">Code works until ${escape(day(card.validUntil, input.timeZone))}</p></article>`
      );
    })
    .join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Table QR codes · ${escape(input.storeName)}</title><style>` +
    `@page{size:A4;margin:12mm}*{box-sizing:border-box}` +
    `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#111;background:#fff}` +
    `.help{max-width:180mm;margin:12mm auto;padding:4mm 6mm;border:1px solid #111}` +
    `.help h1{font-size:16pt;margin:0 0 2mm}.help p{margin:1mm 0;font-size:10.5pt}` +
    `.sheet{display:grid;grid-template-columns:repeat(2,88mm);gap:6mm;justify-content:center;padding:6mm 0}` +
    `.card{border:1px dashed #888;padding:6mm;text-align:center;break-inside:avoid;page-break-inside:avoid}` +
    `.store{margin:0;font-size:9pt;letter-spacing:.08em;text-transform:uppercase}` +
    `h2{margin:1mm 0 3mm;font-size:20pt}.code{display:block;width:60mm;height:60mm;margin:0 auto}` +
    `.code svg{width:100%;height:100%}.lead{font-weight:600;font-size:11pt;margin:3mm 0 1mm}` +
    `ol{text-align:left;margin:0 auto;padding-left:5mm;font-size:9pt;max-width:70mm}` +
    `.valid{margin:3mm 0 0;font-size:7.5pt;color:#444}` +
    `@media print{.help{display:none}}</style></head><body>` +
    `<section class="help"><h1>Table QR codes</h1>` +
    `<p>Print this page at 100% scale on sticker paper or card, cut along the dashed lines and place each code on its table.</p>` +
    `<p>If a sticker is damaged, print it again: the code stays the same. If a code is lost or copied, replace it on the Table QR codes page; the old one stops working at once.</p>` +
    `<p>Print a new code before the date under each code.</p></section>` +
    `<main class="sheet">${cards}</main></body></html>`
  );
}
