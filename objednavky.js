// Nejen Kafe – seznam věcí k objednání, který obsluha píše do skupiny kavárny.
//
// Obsluha napíše do skupiny např.:  "Objednat: skořice, mouka 25 kg, bílá čokoláda"
// (stačí začít slovem objednat / objednávka / obj, položky oddělit čárkou nebo novým řádkem)
// Bot položky zapíše, potvrdí ve skupině a pošle majiteli.
//
// Majitel (kdekoli s botem):  /objednavky  – co je otevřené
//                             /hotovo 2 5   – odškrtnout položky č. 2 a 5
//                             /hotovo vse   – odškrtnout vše
//
// Ukládá se do souboru ${DATA_DIR || ./data}/objednavky.json. Na Railway bez volume se soubor
// při novém nasazení smaže – proto každá položka chodí majiteli i do Telegramu.

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DIR, "objednavky.json");

let items = [];
let nextId = 1;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    items = d.items || [];
    nextId = d.nextId || items.reduce((m, i) => Math.max(m, i.id + 1), 1);
  } catch { /* první spuštění */ }
}
function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ items, nextId }, null, 1));
  } catch (e) { console.error("Objednávky – uložení:", e.message); }
}
load();

const TRIGGER = /^\s*(?:\/obj\w*|objedn[aá]t|objedn[aá]vk[ay]|obj\.?)(?:@\w+)?\s*[:\-–]?\s*/i;

function parse(text) {
  const m = String(text || "").match(TRIGGER);
  if (!m) return null;
  return text.slice(m[0].length)
    .split(/[,;\n]+/)
    .map((s) => s.replace(/^[\s•\-–*]+/, "").trim())
    .filter((s) => s.length > 1);
}

function add(list, { pobocka, kdo, kdy }) {
  const added = [];
  for (const text of list) {
    const dup = items.find((i) => !i.hotovo && i.text.toLowerCase() === text.toLowerCase() && i.pobocka === pobocka);
    if (dup) continue;
    const it = { id: nextId++, text, pobocka, kdo, kdy, hotovo: null };
    items.push(it);
    added.push(it);
  }
  if (added.length) save();
  return added;
}

function open() {
  return items.filter((i) => !i.hotovo);
}

function done(ids, kdy) {
  const all = ids === "vse";
  const out = [];
  for (const i of items) {
    if (i.hotovo) continue;
    if (all || ids.includes(i.id)) { i.hotovo = kdy; out.push(i); }
  }
  // držíme jen 90 dní historie hotových
  const limit = new Date(Date.now() - 90 * 864e5).toISOString();
  items = items.filter((i) => !i.hotovo || i.hotovo > limit);
  if (out.length) save();
  return out;
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function formatOpen() {
  const o = open();
  if (!o.length) return "🛒 K objednání: nic otevřeného.";
  const by = {};
  for (const i of o) (by[i.pobocka || "?"] ??= []).push(i);
  let msg = "🛒 <b>K objednání</b>\n";
  for (const [p, list] of Object.entries(by)) {
    msg += `\n<b>${esc(p)}</b>\n` + list.map((i) => `${i.id}. ${esc(i.text)}  <i>(${i.kdy.slice(8, 10)}.${i.kdy.slice(5, 7)}.)</i>`).join("\n") + "\n";
  }
  return msg + "\nOdškrtnout: /hotovo 3 5  nebo  /hotovo vse";
}

module.exports = { parse, add, open, done, formatOpen, esc, all: () => items };
