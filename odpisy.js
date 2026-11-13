// Nejen Kafe – hlídání večerního odpisového účtu
// ~10 minut po zavíračce zkontroluje v Dotykačce, jestli pobočka udělala účet na 0 Kč s odpisy.
// Když chybí, pošle připomínku do skupiny kavárny (a kopii majiteli).
//
// Proměnné prostředí (volitelné, výchozí hodnoty jsou níže):
//   ODPISY_VYPNUTO=1               – vypne hlídání
//   ODPISY_ZPOZDENI_MIN            – kolik minut po zavíračce kontrolovat (výchozí 10)
//   ZAVIRACKA_MB / ZAVIRACKA_MELNIK – "všední,víkend", např. "18:00,17:00"
//   POBOCKA_MB / POBOCKA_MELNIK     – ID pobočky v Dotykačce (API)
//   FOTO_SKUPINA_MB / FOTO_SKUPINA_MELNIK – chat ID skupiny kavárny (bez nich jde zpráva majiteli)

const https = require("https");
const { fetchOrders, isCanceled, num } = require("./mcp");
const { isHoliday, isClosed, pragueNow } = require("./fotky")._test;

const DELAY = Number(process.env.ODPISY_ZPOZDENI_MIN || 10);

function parseClose(v, def) {
  const [wd, we] = String(v || def).split(",").map((x) => x.trim());
  return { weekday: wd, weekend: we || wd };
}

const BRANCHES = {
  mb: {
    name: "Mladá Boleslav",
    id: process.env.POBOCKA_MB || "",
    close: parseClose(process.env.ZAVIRACKA_MB, ""),
    chatId: process.env.FOTO_SKUPINA_MB || "",
  },
  melnik: {
    name: "Mělník",
    id: process.env.POBOCKA_MELNIK || "",
    close: parseClose(process.env.ZAVIRACKA_MELNIK, ""),
    chatId: process.env.FOTO_SKUPINA_MELNIK || "",
  },
};

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};
const valid = (hhmm) => /^\d{1,2}:\d{2}$/.test(String(hhmm || ""));

let TOKEN = "";
let OWNER_CHAT = "";
const done = {}; // done[`${day}|${branch}`] = true

function send(chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.telegram.org", path: `/bot${TOKEN}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 20000,
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", (e) => { console.error("Odpisy – Telegram:", e.message); resolve(); });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

async function hasWriteOff(day, branchId) {
  const orders = await fetchOrders(day, day, branchId);
  return orders.some((o) =>
    !isCanceled(o) &&
    num(o.totalValueRounded) === 0 &&
    (o.orderItems || o.items || []).some((it) => !it.canceledDate));
}

async function check(now = pragueNow()) {
  if (now.closed) return;
  const weekend = now.weekend || isHoliday(now.day);
  for (const [key, b] of Object.entries(BRANCHES)) {
    const close = weekend ? b.close.weekend : b.close.weekday;
    if (!b.id || !valid(close)) continue;
    const due = toMin(close) + DELAY;
    if (now.minutes < due || now.minutes > due + 60) continue;
    const k = `${now.day}|${key}`;
    if (done[k]) continue;
    done[k] = true;
    try {
      if (await hasWriteOff(now.day, b.id)) continue;
      const target = b.chatId || OWNER_CHAT;
      await send(target, `⚠️ <b>${b.name}</b>: v pokladně chybí večerní účet s odpisy (0 Kč). Zapište prosím neprodané pečivo – co nezapíšete, počítáme jako vyprodané.`);
      if (OWNER_CHAT && String(OWNER_CHAT) !== String(target)) {
        await send(OWNER_CHAT, `⚠️ ${b.name}: do ${close}+${DELAY} min nebyl v pokladně odpisový účet.`);
      }
    } catch (e) {
      done[k] = false; // zkusí to znovu za minutu
      console.error(`Odpisy ${b.name}:`, e.message);
    }
  }
  for (const k of Object.keys(done)) if (!k.startsWith(now.day)) delete done[k];
}

function start({ token, ownerChatId }) {
  TOKEN = token;
  OWNER_CHAT = ownerChatId;
  setInterval(() => check().catch((e) => console.error("Odpisy:", e.message)), 60 * 1000);
  const active = Object.values(BRANCHES).filter((b) => b.id && valid(b.close.weekday)).map((b) => b.name);
  console.log(`Hlídání odpisů: ${active.length ? active.join(", ") : "nenastaveno (chybí ID pobočky nebo zavíračka)"}`);
}

module.exports = { start, _test: { check, BRANCHES, done, parseClose } };
