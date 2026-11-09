// Nejen Kafe – hlídání fotek vitríny v Telegramu
// Bot čte zprávy ze skupin (long polling), eviduje fotky podle pobočky a času
// a když fotka do 15 minut po termínu nepřijde, napíše upozornění.
//
// Proměnné prostředí (Railway → Variables):
//   FOTO_SKUPINA_MELNIK – chat ID skupiny Mělník (zjistíš příkazem /id ve skupině)
//   FOTO_SKUPINA_MB     – chat ID skupiny Mladá Boleslav
//   (když je obě pobočky ve stejné skupině, bot pozná pobočku podle popisku fotky: "MB" / "Mělník")
//   FOTO_TOLERANCE_MIN  – kolik minut po termínu se čeká, výchozí 15
//   FOTO_SOUHRN         – čas denního souhrnu majiteli, výchozí 14:30

const https = require("https");

const TZ = "Europe/Prague";
const TOLERANCE = Number(process.env.FOTO_TOLERANCE_MIN || 15);
const EARLY = 30; // fotka se počítá už 30 min před termínem
const SUMMARY_AT = process.env.FOTO_SOUHRN || "14:30";

const BRANCHES = {
  melnik: { name: "Mělník", chatId: process.env.FOTO_SKUPINA_MELNIK || "" },
  mb: { name: "Mladá Boleslav", chatId: process.env.FOTO_SKUPINA_MB || "" },
};

// Termíny: všední dny / víkend
const SCHEDULE = {
  weekday: { melnik: ["07:00", "14:00"], mb: ["07:30", "14:00"] },
  weekend: { melnik: ["09:00", "14:00"], mb: ["09:00", "14:00"] },
};

// ─── Čas v Praze ──────────────────────────────────────────────────────────────
function pragueNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return {
    day: `${g("year")}-${g("month")}-${g("day")}`,
    minutes: Number(g("hour")) * 60 + Number(g("minute")),
    weekend: ["Sat", "Sun"].includes(g("weekday")),
  };
}

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function slotsFor(weekend) {
  const s = weekend ? SCHEDULE.weekend : SCHEDULE.weekday;
  const out = [];
  for (const [branch, times] of Object.entries(s)) for (const t of times) out.push({ branch, time: t });
  return out;
}

// ─── Stav (v paměti, jen aktuální den) ────────────────────────────────────────
// state[day][`${branch}|${time}`] = { photoAt: "07:04", late: bool, reminded: bool }
const state = {};
let summarySentFor = null;

function dayState(day) {
  for (const d of Object.keys(state)) if (d !== day) delete state[d];
  return (state[day] ??= {});
}

const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Ke kterému termínu fotka patří (nejbližší otevřený termín dané pobočky)
function matchSlot(branch, now) {
  const slots = slotsFor(now.weekend).filter((s) => s.branch === branch);
  const ds = dayState(now.day);
  let best = null;
  for (const s of slots) {
    const t = toMin(s.time);
    const key = `${s.branch}|${s.time}`;
    if (ds[key]?.photoAt) continue;
    if (now.minutes >= t - EARLY && (!best || Math.abs(now.minutes - t) < Math.abs(now.minutes - toMin(best.time)))) best = s;
  }
  return best;
}

// ─── Telegram ────────────────────────────────────────────────────────────────
let TOKEN = "";
let OWNER_CHAT = "";

function tg(method, params = {}, timeoutMs = 40000) {
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org", path: `/bot${TOKEN}/${method}`, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const send = (chat_id, text, extra = {}) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", ...extra }).catch((e) => console.error("Telegram:", e.message));

function branchForMessage(msg) {
  const chatId = String(msg.chat.id);
  const byChat = Object.entries(BRANCHES).filter(([, b]) => b.chatId && b.chatId === chatId).map(([k]) => k);
  if (byChat.length === 1) return byChat[0];
  // Společná skupina → podle popisku fotky
  const text = String(msg.caption || msg.text || "").toLowerCase();
  if (/\bmb\b|boleslav/.test(text)) return "mb";
  if (/m[eě]ln[ií]k/.test(text)) return "melnik";
  return null;
}

async function handleMessage(msg) {
  const text = String(msg.text || "").trim();

  if (text.startsWith("/id")) {
    await send(msg.chat.id, `Chat ID této konverzace: <code>${msg.chat.id}</code>`);
    return;
  }
  if (text.startsWith("/fotky")) {
    await send(msg.chat.id, summaryText(pragueNow()));
    return;
  }

  const hasPhoto = Boolean(msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || "")));
  if (!hasPhoto) return;

  const now = pragueNow(new Date(msg.date * 1000));
  const branch = branchForMessage(msg);
  if (!branch) {
    if (BRANCHES.mb.chatId === BRANCHES.melnik.chatId)
      await send(msg.chat.id, "📷 Napište prosím k fotce pobočku: <b>MB</b> nebo <b>Mělník</b>.", { reply_to_message_id: msg.message_id });
    return;
  }
  const slot = matchSlot(branch, now);
  if (!slot) return; // fotka mimo termíny – ignorujeme
  const key = `${slot.branch}|${slot.time}`;
  const ds = dayState(now.day);
  const late = now.minutes > toMin(slot.time) + TOLERANCE;
  ds[key] = { ...(ds[key] || {}), photoAt: fmt(now.minutes), late };
  await tg("setMessageReaction", {
    chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: "emoji", emoji: late ? "👌" : "👍" }],
  }).catch(() => {});
  console.log(`Foto ${BRANCHES[branch].name} ${slot.time} přijato v ${fmt(now.minutes)}${late ? " (pozdě)" : ""}`);
}

// ─── Kontrola termínů ─────────────────────────────────────────────────────────
async function checkSlots() {
  const now = pragueNow();
  const ds = dayState(now.day);
  for (const s of slotsFor(now.weekend)) {
    const key = `${s.branch}|${s.time}`;
    const due = toMin(s.time) + TOLERANCE;
    if (now.minutes < due || now.minutes > due + 60) continue; // připomínáme jen v hodině po termínu
    const st = (ds[key] ??= {});
    if (st.photoAt || st.reminded) continue;
    st.reminded = true;
    const b = BRANCHES[s.branch];
    const target = b.chatId || OWNER_CHAT;
    await send(target, `⚠️ <b>${b.name}</b>: chybí foto vitríny (${s.time}). Pošlete ho prosím sem.`);
    if (OWNER_CHAT && String(OWNER_CHAT) !== String(target)) {
      await send(OWNER_CHAT, `⚠️ ${b.name}: foto vitríny ${s.time} nepřišlo.`);
    }
  }
  if (now.minutes >= toMin(SUMMARY_AT) && summarySentFor !== now.day && OWNER_CHAT) {
    summarySentFor = now.day;
    await send(OWNER_CHAT, summaryText(now));
  }
}

function summaryText(now) {
  const ds = dayState(now.day);
  let msg = `📷 <b>Fotky vitríny – ${now.day}</b>\n`;
  for (const branch of Object.keys(BRANCHES)) {
    msg += `\n<b>${BRANCHES[branch].name}</b>\n`;
    for (const s of slotsFor(now.weekend).filter((x) => x.branch === branch)) {
      const st = ds[`${branch}|${s.time}`] || {};
      const pending = now.minutes < toMin(s.time) + TOLERANCE;
      msg += st.photoAt
        ? `${st.late ? "🟡" : "✅"} ${s.time} – přišlo ${st.photoAt}${st.late ? " (pozdě)" : ""}\n`
        : pending ? `⏳ ${s.time} – zatím nečekáme\n` : `❌ ${s.time} – nepřišlo\n`;
    }
  }
  return msg;
}

// ─── Long polling ─────────────────────────────────────────────────────────────
let offset = 0;
async function poll() {
  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 40000);
      if (!res.ok) {
        console.error("getUpdates:", res.description);
        await new Promise((r) => setTimeout(r, 10000));
        continue;
      }
      for (const u of res.result) {
        offset = u.update_id + 1;
        if (u.message) await handleMessage(u.message).catch((e) => console.error("Zpráva:", e.message));
      }
    } catch (e) {
      console.error("Polling:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function start({ token, ownerChatId }) {
  TOKEN = token;
  OWNER_CHAT = ownerChatId;
  setInterval(() => checkSlots().catch((e) => console.error("Kontrola fotek:", e.message)), 60 * 1000);
  poll();
  console.log("Hlídání fotek vitríny spuštěno");
}

module.exports = { start, _test: { pragueNow, matchSlot, slotsFor, summaryText, handleMessage, checkSlots, state } };
