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
