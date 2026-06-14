// Nejen Kafe – Telegram Bot Server
// Přijímá webhook z Dotykačky po každém prodeji, ukládá denní souhrn
// a jednou denně (v 19:00) pošle report do Telegramu.
// Spustit: node server.js

const http = require("http");

const TELEGRAM_TOKEN = "8926834458:AAHbuFG3kkl9JBqQ-UrJFmItwUY4Y1f3OS0";
const CHAT_ID = "8680493259";
const PORT = process.env.PORT || 8080;

// Hodina (0-23) kdy se posílá denní souhrn, v lokálním čase serveru (UTC).
// Praha je UTC+1/+2, takže 19:00 v Praze = 17:00 nebo 18:00 UTC.
// V létě (CEST, UTC+2) je 19:00 Praha = 17:00 UTC.
const REPORT_HOUR_UTC = 17; // ~19:00 letního času v Praze

// ─── Denní úložiště v paměti ──────────────────────────────────────────────────
// Klíč: datum (YYYY-MM-DD), hodnota: { totalTrzby, pocetDokladu, totalKusy, pokladny: {} }
const dailyData = {};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDayBucket(key) {
  if (!dailyData[key]) {
    dailyData[key] = { totalTrzby: 0, pocetDokladu: 0, totalKusy: 0, pokladny: {} };
  }
  return dailyData[key];
}

// ─── Telegram helper ────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
  });
  return new Promise((resolve, reject) => {
    const https = require("https");
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Zpracování dat z Dotykačky ────────────────────────────────────────────────
function processWebhookData(payload) {
  // Dotykačka posílá pole objednávek přímo jako array
  const orders = Array.isArray(payload) ? payload : (payload.orders || payload.data || [payload]);

  let totalTrzby = 0;
  let pocetDokladu = 0;
  let totalKusy = 0;
  const pokladny = {};

  for (const order of orders) {
    if (order.status !== "closed") continue;
    const cena = parseFloat(order.totalvaluerounded || 0);
    const kusy = parseInt(order.itemcount || 0);
    const branch = order.branchid != null ? String(order.branchid) : "neznámá";

    totalTrzby += cena;
    totalKusy += kusy;
    pocetDokladu++;

    if (!pokladny[branch]) pokladny[branch] = { trzby: 0, pocet: 0 };
    pokladny[branch].trzby += cena;
    pokladny[branch].pocet++;
  }

  return { totalTrzby, pocetDokladu, totalKusy, pokladny };
}

// ─── Přidání dat do denního souhrnu ────────────────────────────────────────────
function addToDailyData(parsed) {
  const bucket = getDayBucket(todayKey());
  bucket.totalTrzby += parsed.totalTrzby;
  bucket.pocetDokladu += parsed.pocetDokladu;
  bucket.totalKusy += parsed.totalKusy;
  for (const [branch, v] of Object.entries(parsed.pokladny)) {
    if (!bucket.pokladny[branch]) bucket.pokladny[branch] = { trzby: 0, pocet: 0 };
    bucket.pokladny[branch].trzby += v.trzby;
    bucket.pokladny[branch].pocet += v.pocet;
  }
}

// ─── Sestavení zprávy do Telegramu ────────────────────────────────────────────
function buildReportMessage(data, datum) {
  const fmt = (n) => Math.round(n).toLocaleString("cs-CZ") + " Kč";
  const date = datum || new Date().toLocaleDateString("cs-CZ");

  let msg = `☕ <b>Nejen Kafe — denní report</b>\n`;
  msg += `📅 ${date}`;
  msg += `\n${"—".repeat(28)}\n\n`;

  msg += `💰 <b>Celkové tržby: ${fmt(data.totalTrzby)}</b>\n`;
  msg += `🧾 Počet dokladů: ${data.pocetDokladu}\n`;

  if (data.pocetDokladu > 0) {
    msg += `📊 Průměr/doklad: ${fmt(data.totalTrzby / data.pocetDokladu)}\n`;
  }

  if (data.totalKusy > 0) {
    msg += `🛍️ Prodaných kusů: ${data.totalKusy}\n`;
  }

  // Tržby dle pokladen
  const pokladnyEntries = Object.entries(data.pokladny || {});
  if (pokladnyEntries.length > 1) {
    msg += `\n<b>Tržby dle provozovny:</b>\n`;
    for (const [branch, v] of pokladnyEntries) {
      msg += `• ${branch}: ${fmt(v.trzby)} (${v.pocet} dokladů)\n`;
    }
  }

  msg += `\n<b>💡 Poznámky:</b>\n`;
  if (data.totalTrzby > 15000) msg += `🎉 Výborný den — přes 15 000 Kč!\n`;
  if (data.totalTrzby < 5000 && data.totalTrzby > 0) msg += `📉 Slabší den — pod 5 000 Kč\n`;
  if (data.pocetDokladu > 80) msg += `🚀 Hodně zákazníků dnes (${data.pocetDokladu} dokladů)\n`;
  if (data.pocetDokladu === 0) msg += `ℹ️ Dnes žádné uzavřené objednávky.\n`;

  msg += `\n${"—".repeat(28)}`;
  return msg;
}

// ─── Plánovač denního reportu ──────────────────────────────────────────────────
let lastReportDate = null;

function checkAndSendDailyReport() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (now.getUTCHours() === REPORT_HOUR_UTC && lastReportDate !== todayStr) {
    const bucket = dailyData[todayStr] || { totalTrzby: 0, pocetDokladu: 0, totalKusy: 0, pokladny: {} };
    const msg = buildReportMessage(bucket, now.toLocaleDateString("cs-CZ"));
    sendTelegram(msg)
      .then(() => console.log("Denní report odeslán pro", todayStr))
      .catch((e) => console.error("Chyba odeslání reportu:", e.message));
    lastReportDate = todayStr;
  }
}

// Kontrola každých 5 minut
setInterval(checkAndSendDailyReport, 5 * 60 * 1000);

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Nejen Kafe Bot běží ✓");
    return;
  }

  // Test endpoint – posíle aktuální stav dnešních dat
  if (req.method === "GET" && req.url === "/test") {
    const bucket = dailyData[todayKey()] || { totalTrzby: 0, pocetDokladu: 0, totalKusy: 0, pokladny: {} };
    const msg = buildReportMessage(bucket, new Date().toLocaleDateString("cs-CZ"));
    try {
      await sendTelegram(msg);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Testovací zpráva odeslána do Telegramu ✓");
    } catch (e) {
      res.writeHead(500);
      res.end("Chyba: " + e.message);
    }
    return;
  }

  // Endpoint pro manuální odeslání souhrnu (debug)
  if (req.method === "GET" && req.url === "/send-now") {
    const bucket = dailyData[todayKey()] || { totalTrzby: 0, pocetDokladu: 0, totalKusy: 0, pokladny: {} };
    const msg = buildReportMessage(bucket, new Date().toLocaleDateString("cs-CZ"));
    try {
      await sendTelegram(msg);
      lastReportDate = todayKey();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Denní report odeslán ✓");
    } catch (e) {
      res.writeHead(500);
      res.end("Chyba: " + e.message);
    }
    return;
  }

  // Webhook z Dotykačky
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        console.log("Webhook přijat:", new Date().toISOString());

        const parsed = processWebhookData(payload);
        if (parsed.totalTrzby > 0 || parsed.pocetDokladu > 0) {
          addToDailyData(parsed);
          console.log("Přidáno do denních dat:", JSON.stringify(parsed), "Den:", todayKey());
        } else {
          console.log("Webhook bez dat o tržbách, ignoruji.");
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error("Chyba zpracování:", e.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Nejen Kafe Bot spuštěn na portu ${PORT}`);
  console.log(`Test: http://localhost:${PORT}/test`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
  console.log(`Denní report v ${REPORT_HOUR_UTC}:00 UTC`);
});
