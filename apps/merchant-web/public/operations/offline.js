/* global document, window, location, localStorage, fetch, setInterval, navigator */
// Owner 2026-11-03 (operating continuity): see sw.js. Reads what the Tables page last saved on this
// device (src/table-last-bills.ts) and reads nothing else; it returns by itself when the connection
// does. The steps are the same as src/TablesOfflineGuide.tsx.
(function () {
  var words = {
    "zh-Hans": {
      title: "现在连不上系统",
      back: "连上后这一页会自动回到系统。",
      offlineTitle: "这台设备没有联网",
      offlineBack: "请检查无线网络。网络恢复后这一页会自己重新打开。",
      retry: "再试一次",
      guide: "断网期间怎么做",
      steps: [
        "新点的菜写在纸单上（桌号和第几轮），交给后厨。",
        "每道菜上桌后在纸单上打勾。",
        "免单或折让由店长决定：在纸单上写明哪道菜、减多少、原因和店长姓名。",
        "照常用刷卡机或现金收这桌的钱。记下桌号、金额、小费、时间和刷卡单上的单号（现金记实收和找零）。不要记卡号。",
      ],
      bills: "断网前最后看到的账单",
      asOf: "更新于 ",
      none: "这台设备上没有最近的账单。",
      owed: "待收",
      settled: "已付清",
      round: "第 {n} 轮",
      taxRounding: "税额取整",
      table: "桌台 ",
      note: "断网后新点的菜不在这里，要加上纸单。",
    },
    en: {
      title: "Can't reach the system right now",
      back: "This page returns to the system by itself once connected.",
      offlineTitle: "This device is offline",
      offlineBack: "Check the wifi. The page opens again by itself when the network is back.",
      retry: "Try again",
      guide: "While the connection is down",
      steps: [
        "Take new rounds on paper slips (table and round) and pass them to the kitchen.",
        "Tick each dish on the slip when it is served.",
        "A comp or discount is the manager's decision: write the dish, how much and the reason on the slip, with the manager's name.",
        "Take the table's payment on the card machine or in cash as usual. Write the table, amount, tip, time and the slip's reference code (cash: received and change). Never write a card number.",
      ],
      bills: "Last bills seen before the connection dropped",
      asOf: "As of ",
      none: "No recent bills on this device.",
      owed: "To pay",
      settled: "Paid",
      round: "Round {n}",
      taxRounding: "Tax rounding",
      table: "Table ",
      note: "Rounds taken since then aren't here: add the paper slips.",
    },
  };
  // The same choice as the app (src/i18n/i18n.ts): this device's own choice, else Chinese when the
  // device prefers Chinese, else English.
  var stored = null;
  try {
    stored = localStorage.getItem("bop.merchant.language");
  } catch {
    /* Blocked storage: the device's language. */
  }
  var preferred = String((navigator.languages && navigator.languages[0]) || "").toLowerCase();
  var language =
    stored === "en" || stored === "zh-Hans"
      ? stored
      : preferred.indexOf("zh") === 0
        ? "zh-Hans"
        : "en";
  var w = words[language];
  document.documentElement.lang = language;
  var main = document.getElementById("offline");
  var el = function (tag, text, parent, className) {
    var node = document.createElement(tag);
    if (text !== null) node.textContent = text;
    if (className) node.className = className;
    (parent || main).appendChild(node);
    return node;
  };
  var money = function (minor) {
    var value = BigInt(minor);
    var abs = value < 0n ? -value : value;
    var cents = String(abs % 100n).padStart(2, "0");
    return (value < 0n ? "−" : "") + "$" + String(abs / 100n) + "." + cents;
  };
  // Live v15 2026-11-10: a device with no network says so, as the app does; otherwise the system
  // is down (the network is fine but the front page answers 503).
  var heading = el("h1", null);
  var back = el("p", null, null, "quiet");
  // Whether the last try reached the store system's address at all (a 503 does; no network doesn't).
  var unreachable = false;
  var state = function () {
    var offline = navigator.onLine === false || unreachable;
    heading.textContent = offline ? w.offlineTitle : w.title;
    back.textContent = offline ? w.offlineBack : w.back;
  };
  state();
  window.addEventListener("offline", state);
  el("button", w.retry).addEventListener("click", function () {
    location.reload();
  });
  el("h2", w.guide);
  var list = el("ul", null);
  w.steps.forEach(function (step) {
    el("li", step, list);
  });
  var saved;
  try {
    saved = JSON.parse(localStorage.getItem("bop.tables.lastBills.v1") || "null");
    if (saved && !(Date.now() - Date.parse(saved.savedAt) <= 12 * 60 * 60 * 1000)) saved = null;
  } catch {
    saved = null;
  }
  el("h2", w.bills);
  if (!saved || !Array.isArray(saved.tables) || saved.tables.length === 0) el("p", w.none);
  else {
    el(
      "p",
      w.asOf +
        new Date(saved.savedAt).toLocaleTimeString(language) +
        // b13: which Store these bills are from (a table label repeats across Stores).
        (typeof saved.storeLabel === "string" && saved.storeLabel ? " · " + saved.storeLabel : "") +
        " · " +
        w.note,
      null,
      "quiet",
    );
    saved.tables.forEach(function (table) {
      var details = el("details", null);
      var summary = el("summary", null, details);
      el("span", w.table + table.label, summary);
      el("strong", table.settled ? w.settled : w.owed + " " + money(table.owedMinor), summary);
      table.rounds.forEach(function (round) {
        el(
          "h3",
          w.round.replace("{n}", String(round.number)) + " · " + money(round.totalMinor),
          details,
        );
        var lines = el("dl", null, details);
        round.items.forEach(function (item) {
          var row = el("div", null, lines);
          el("dt", item.name, row);
          el("dd", money(item.subtotalMinor), row);
        });
      });
      // DEC-TAX-WHOLE-RECEIPT: each round as ordered, and the bill's one rounding line.
      if (
        !table.settled &&
        typeof table.taxRoundingMinor === "string" &&
        /^-?[1-9][0-9]{0,15}$/.test(table.taxRoundingMinor)
      ) {
        var rounding = el("dl", null, details);
        var row = el("div", null, rounding);
        el("dt", w.taxRounding, row);
        el("dd", money(table.taxRoundingMinor), row);
      }
    });
  }
  window.addEventListener("online", function () {
    location.reload();
  });
  // The browser can say "online" (store Wi-Fi up, internet down) and miss the way back: ask too.
  // The first ask only finds out which message to show (never reloads at once, so a page that keeps
  // failing is not reloaded in a loop); later asks every 5 s go back once the system answers.
  var ask = function (first) {
    fetch("/operations/sw.js", { cache: "no-store" }).then(
      function (response) {
        if (response.ok && first !== true) location.reload();
        else if (unreachable) {
          unreachable = false;
          state();
        }
      },
      function () {
        // Nothing answered: this device has no way to the system (wifi off, or no internet).
        if (!unreachable) {
          unreachable = true;
          state();
        }
      },
    );
  };
  ask(true);
  setInterval(ask, 5000);
})();
