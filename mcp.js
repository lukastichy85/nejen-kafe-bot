// Nejen Kafe – MCP konektor pro Claude (jen čtení dat z Dotykačky)
// Bez externích závislostí. Připojuje se do server.js na cestu /mcp/<MCP_SECRET>.
//
// Proměnné prostředí (Railway → Variables):
//   DOTYKACKA_REFRESH_TOKEN  – refresh token z Dotykačky (API v2)
//   DOTYKACKA_CLOUD_ID       – ID cloudu (výchozí 396789971)
//   MCP_SECRET               – dlouhý náhodný řetězec, je součástí URL konektoru
//   DOTYKACKA_API_BASE       – volitelné, výchozí https://api.dotykacka.cz

const API_BASE = (process.env.DOTYKACKA_API_BASE || "https://api.dotykacka.cz").replace(/\/$/, "");
const CLOUD_ID = process.env.DOTYKACKA_CLOUD_ID || "396789971";
const REFRESH_TOKEN = process.env.DOTYKACKA_REFRESH_TOKEN || "";
const TZ = "Europe/Prague";

const BRANCH_NAMES = {
  "129142134": "Mladá Boleslav",
  "156750726": "Mělník",
};

// ─── Dotykačka API klient ─────────────────────────────────────────────────────
let accessToken = null;
let accessTokenExp = 0;

async function getAccessToken(force = false) {
  if (!REFRESH_TOKEN) throw new Error("Chybí DOTYKACKA_REFRESH_TOKEN v proměnných prostředí.");
  if (!force && accessToken && Date.now() < accessTokenExp) return accessToken;
  const res = await fetch(`${API_BASE}/v2/signin/token`, {
    method: "POST",
    headers: { Authorization: `User ${REFRESH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ _cloudId: String(CLOUD_ID) }),
  });
  if (!res.ok) throw new Error(`Přihlášení do Dotykačky selhalo (${res.status}): ${await res.text()}`);
  const data = await res.json();
  accessToken = data.accessToken;
  accessTokenExp = Date.now() + 50 * 60 * 1000; // token platí ~1 h
  return accessToken;
}

async function apiGet(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = `${API_BASE}/v2/clouds/${CLOUD_ID}/${path.replace(/^\//, "")}${qs.toString() ? "?" + qs : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt > 0);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 404 || res.status === 204) return { data: [] }; // prázdná stránka
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Dotykačka API ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : { data: [] };
  }
}

async function apiGetAll(path, params = {}, maxPages = 300) {
  const out = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await apiGet(path, { ...params, page, limit: 100 });
    const rows = Array.isArray(res) ? res : res.data || [];
    out.push(...rows);
    const last = res.lastPage != null ? Number(res.lastPage) : null;
    if (rows.length < 100 || (last != null && page >= last)) break;
    page++;
  }
  return out;
}

// ─── Datum a čas (Praha) ──────────────────────────────────────────────────────
function pragueOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-10-01" → okamžik půlnoci v Praze
function pragueMidnight(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`Neplatné datum "${ymd}", použij formát RRRR-MM-DD.`);
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const off = pragueOffsetMinutes(guess);
  const t = new Date(guess.getTime() - off * 60000);
  const off2 = pragueOffsetMinutes(t); // korekce kolem přechodu na letní čas
  return new Date(guess.getTime() - off2 * 60000);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function pragueParts(ts) {
  const date = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")), weekday: g("weekday") };
}

const WEEKDAY_CS = { Mon: "Po", Tue: "Út", Wed: "St", Thu: "Čt", Fri: "Pá", Sat: "So", Sun: "Ne" };

// ─── Načtení účtenek za období ────────────────────────────────────────────────
// Formát časového filtru v API není v dokumentaci jednoznačný – zkusíme ms, pak ISO.
let filterTimeFormat = null; // "ms" | "iso"

function fmtTime(d, kind) {
  return kind === "ms" ? String(d.getTime()) : d.toISOString();
}

async function fetchOrders(od, doDne, pobocka) {
  const from = pragueMidnight(od);
  const to = pragueMidnight(addDays(doDne, 1)); // do je včetně
  const branchFilter = pobocka ? `;_branchId|eq|${pobocka}` : "";
  const kinds = filterTimeFormat ? [filterTimeFormat] : ["ms", "iso"];
  let lastErr;
  for (const kind of kinds) {
    try {
      const filter = `created|gteq|${fmtTime(from, kind)};created|lt|${fmtTime(to, kind)}${branchFilter}`;
      const orders = await apiGetAll("orders", { filter, include: "orderItems", sort: "created" });
      filterTimeFormat = kind;
      return orders;
    } catch (e) {
      lastErr = e;
      if (e.status !== 400) throw e;
    }
  }
  throw lastErr;
}

function num(v) {
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isCanceled(o) {
  const flags = num(o.flags);
  return Boolean(o.canceledDate) || (flags & 2) !== 0 || String(o.status || "").toUpperCase().includes("CANCEL");
}

function itemTotal(it) {
  if (it.totalPriceWithVat != null) return num(it.totalPriceWithVat);
  if (it.billedUnitPriceWithVat != null) return num(it.billedUnitPriceWithVat) * num(it.quantity);
  return num(it.unitPriceWithVat) * num(it.quantity) - num(it.discountValue);
}

function branchName(id) {
  return BRANCH_NAMES[String(id)] || `pobočka ${id}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

async function salesReport({ od, do: doDne, pobocka, top = 20 }) {
  const raw = await fetchOrders(od, doDne, pobocka);
  const valid = raw.filter((o) => {
    const type = String(o.documentType || "RECEIPT").toUpperCase();
    return !isCanceled(o) && !["CASH_IN", "CASH_OUT"].includes(type);
  });
  // Večerní účet na 0 Kč s položkami = odpisy (neprodané zbytky), ne prodej
  const isWriteOff = (o) => num(o.totalValueRounded) === 0 && (o.orderItems || o.items || []).length > 0;
  const orders = valid.filter((o) => !isWriteOff(o));
  const writeOffs = {};
  for (const o of valid.filter(isWriteOff)) {
    const p = pragueParts(o.completed || o.created);
    for (const it of o.orderItems || o.items || []) {
      if (it.canceledDate) continue;
      const key = it._productId != null ? String(it._productId) : it.name;
      writeOffs[key] ??= { nazev: it.name || key, kusy: 0, dny: {} };
      writeOffs[key].kusy += num(it.quantity);
      writeOffs[key].dny[p.day] = (writeOffs[key].dny[p.day] || 0) + num(it.quantity);
    }
  }

  const branches = {};
  const products = {};
  const byDay = {};
  const byWeekday = {};
  const byHour = {};
  let total = 0;

  for (const o of orders) {
    const value = num(o.totalValueRounded);
    const b = String(o._branchId ?? "neznámá");
    const p = pragueParts(o.completed || o.created);
    total += value;

    branches[b] ??= { pobocka: branchName(b), trzby: 0, uctenek: 0 };
    branches[b].trzby += value;
    branches[b].uctenek++;

    byDay[p.day] ??= { trzby: 0, uctenek: 0 };
    byDay[p.day].trzby += value;
    byDay[p.day].uctenek++;

    const wd = WEEKDAY_CS[p.weekday] || p.weekday;
    byWeekday[wd] ??= { trzby: 0, uctenek: 0, dnu: new Set() };
    byWeekday[wd].trzby += value;
    byWeekday[wd].uctenek++;
    byWeekday[wd].dnu.add(p.day);

    byHour[p.hour] ??= { trzby: 0, uctenek: 0 };
    byHour[p.hour].trzby += value;
    byHour[p.hour].uctenek++;

    for (const it of o.orderItems || o.items || []) {
      if (it.canceledDate) continue;
      const key = it._productId != null ? String(it._productId) : it.name;
      products[key] ??= { nazev: it.name || key, kusy: 0, trzby: 0 };
      products[key].kusy += num(it.quantity);
      products[key].trzby += itemTotal(it);
    }
  }

  const productList = Object.values(products).map((p) => ({ ...p, kusy: round(p.kusy), trzby: round(p.trzby) }));
  const sortedByRevenue = [...productList].sort((a, b) => b.trzby - a.trzby);
  const sortedByQty = [...productList].sort((a, b) => b.kusy - a.kusy);

  return {
    obdobi: { od, do: doDne, pobocka: pobocka ? branchName(pobocka) : "všechny" },
    celkem: {
      trzby_kc: round(total),
      uctenek: orders.length,
      prumerna_uctenka_kc: orders.length ? round(total / orders.length) : 0,
      stornovanych_vyrazeno: raw.length - valid.length,
      odpisovych_uctu: valid.length - orders.length,
    },
    pobocky: Object.values(branches).map((b) => ({
      ...b, trzby: round(b.trzby), prumerna_uctenka: b.uctenek ? round(b.trzby / b.uctenek) : 0,
    })),
    po_dnech: Object.entries(byDay).sort().map(([den, v]) => ({ den, trzby: round(v.trzby), uctenek: v.uctenek })),
    po_dnech_v_tydnu: ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"].filter((d) => byWeekday[d]).map((d) => ({
      den: d, trzby: round(byWeekday[d].trzby), uctenek: byWeekday[d].uctenek,
      prumer_na_den: round(byWeekday[d].trzby / byWeekday[d].dnu.size),
    })),
    po_hodinach: Object.entries(byHour).sort((a, b) => a[0] - b[0]).map(([h, v]) => ({
      hodina: `${String(h).padStart(2, "0")}:00`, trzby: round(v.trzby), uctenek: v.uctenek,
    })),
    produkty_pocet: productList.length,
    top_produkty_dle_trzeb: sortedByRevenue.slice(0, top),
    top_produkty_dle_kusu: sortedByQty.slice(0, top),
    nejslabsi_produkty: sortedByRevenue.filter((p) => p.trzby > 0).slice(-top).reverse(),
    odpisy: Object.values(writeOffs)
      .map((w) => ({ ...w, kusy: round(w.kusy) }))
      .sort((a, b) => b.kusy - a.kusy),
  };
}

async function productSales({ od, do: doDne, pobocka, hledat }) {
  const report = await salesReport({ od, do: doDne, pobocka, top: 100000 });
  let list = report.top_produkty_dle_trzeb;
  if (hledat) {
    const q = hledat.toLowerCase();
    list = list.filter((p) => String(p.nazev).toLowerCase().includes(q));
  }
  return { obdobi: report.obdobi, produktu: list.length, produkty: list };
}

// Po dnech a produktech: prodané kusy, čas posledního prodeje, odpis.
// Produkt bez odpisu s posledním prodejem dlouho před zavírací dobou = pravděpodobně vyprodáno.
async function dailyProducts({ od, do: doDne, pobocka, hledat }) {
  const raw = await fetchOrders(od, doDne, pobocka);
  const q = hledat ? hledat.toLowerCase() : null;
  const rows = {};
  for (const o of raw) {
    const type = String(o.documentType || "RECEIPT").toUpperCase();
    if (isCanceled(o) || ["CASH_IN", "CASH_OUT"].includes(type)) continue;
    const items = o.orderItems || o.items || [];
    const writeOff = num(o.totalValueRounded) === 0 && items.length > 0;
    const ts = o.completed || o.created;
    const p = pragueParts(ts);
    const time = new Intl.DateTimeFormat("cs-CZ", { timeZone: TZ, hour: "2-digit", minute: "2-digit" })
      .format(new Date(typeof ts === "number" ? ts : Date.parse(ts)));
    for (const it of items) {
      if (it.canceledDate) continue;
      if (q && !String(it.name || "").toLowerCase().includes(q)) continue;
      const key = `${p.day}|${o._branchId}|${it._productId ?? it.name}`;
      rows[key] ??= {
        den: p.day, den_v_tydnu: WEEKDAY_CS[p.weekday], pobocka: branchName(o._branchId),
        produkt: it.name, prodano: 0, odpis: 0, prvni_prodej: null, posledni_prodej: null,
      };
      const r = rows[key];
      if (writeOff) {
        r.odpis += num(it.quantity);
      } else {
        r.prodano += num(it.quantity);
        if (!r.prvni_prodej || time < r.prvni_prodej) r.prvni_prodej = time;
        if (!r.posledni_prodej || time > r.posledni_prodej) r.posledni_prodej = time;
      }
    }
  }
  const list = Object.values(rows)
    .map((r) => ({ ...r, prodano: round(r.prodano), odpis: round(r.odpis) }))
    .sort((a, b) => (a.den + a.pobocka + a.produkt).localeCompare(b.den + b.pobocka + b.produkt, "cs"));
  return { obdobi: { od, do: doDne }, radku: list.length, data: list };
}

// ─── Definice nástrojů ────────────────────────────────────────────────────────
const DATE_PROPS = {
  od: { type: "string", description: "Začátek období včetně, RRRR-MM-DD (pražský čas)" },
  do: { type: "string", description: "Konec období včetně, RRRR-MM-DD (pražský čas)" },
  pobocka: {
    type: "string",
    description: "Volitelně ID pobočky: 129142134 = Mladá Boleslav, 156750726 = Mělník. Bez vyplnění obě.",
  },
};

const TOOLS = [
  {
    name: "trzby_prehled",
    description:
      "Přehled tržeb Nejen Kafe z pokladny Dotykačka za období: celkové tržby, počet účtenek, průměrná účtenka, " +
      "rozpad po pobočkách, po dnech, po dnech v týdnu, po hodinách, top a nejslabší produkty. Stornované účtenky a vklady/výběry jsou vyřazeny.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_PROPS, top: { type: "number", description: "Kolik produktů v žebříčcích (výchozí 20)" } },
      required: ["od", "do"],
    },
    annotations: { readOnlyHint: true },
    handler: salesReport,
  },
  {
    name: "prodane_produkty",
    description: "Kompletní seznam prodaných produktů za období (kusy a tržby), volitelně filtrovaný podle názvu.",
    inputSchema: {
      type: "object",
      properties: { ...DATE_PROPS, hledat: { type: "string", description: "Část názvu produktu, např. croissant" } },
      required: ["od", "do"],
    },
    annotations: { readOnlyHint: true },
    handler: productSales,
  },
  {
    name: "prodeje_po_dnech",
    description:
      "Pro plánování výroby: po dnech, pobočkách a produktech vrací prodané kusy, čas prvního a posledního prodeje " +
      "a odpis (z večerního účtu na 0 Kč). Nulový odpis + poslední prodej dlouho před zavírací dobou znamená pravděpodobné vyprodání, " +
      "skutečná poptávka pak byla vyšší než prodej. Pro delší období použij filtr 'hledat' (např. croissant, chléb).",
    inputSchema: {
      type: "object",
      properties: { ...DATE_PROPS, hledat: { type: "string", description: "Část názvu produktu" } },
      required: ["od", "do"],
    },
    annotations: { readOnlyHint: true },
    handler: dailyProducts,
  },
  {
    name: "dotykacka_cteni",
    description:
      "Přímé čtení libovolné entity z Dotykačka API v2 (jen GET) v cloudu Nejen Kafe, např. 'branches', 'products', " +
      "'categories', 'orders', 'order-items', 'money-logs', 'attendances'. Filtr ve formátu atribut|operace|hodnota;... " +
      "(operace eq, ne, gt, gteq, lt, lteq, like, in). Vrací jednu stránku (max 100 záznamů).",
    inputSchema: {
      type: "object",
      properties: {
        entita: { type: "string", description: "Např. branches, products, orders, order-items" },
        filter: { type: "string" },
        sort: { type: "string", description: "Např. -created" },
        include: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: ["entita"],
    },
    annotations: { readOnlyHint: true },
    handler: async ({ entita, filter, sort, include, page = 1, limit = 100 }) => {
      if (!/^[a-z0-9-]+(\/[0-9]+)?$/i.test(entita)) throw new Error("Neplatný název entity.");
      return apiGet(entita, { filter, sort, include, page, limit: Math.min(Number(limit) || 100, 100) });
    },
  },
];

// ─── MCP (Streamable HTTP, JSON odpovědi) ─────────────────────────────────────
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function handleRpc(msg) {
  const { id, method, params = {} } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (id === undefined || id === null) return null; // notifikace – bez odpovědi

  switch (method) {
    case "initialize": {
      const v = SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      return reply({
        protocolVersion: v,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nejen-kafe-dotykacka", version: "1.0.0" },
        instructions:
          "Data z pokladny Dotykačka pro kavárny Nejen Kafe (Mladá Boleslav, Mělník). Jen čtení. " +
          "Částky jsou v Kč s DPH. Datumy zadávej jako RRRR-MM-DD v pražském čase.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ handler, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Neznámý nástroj: ${params.name}`);
      try {
        const result = await tool.handler(params.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `Chyba: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Metoda není podporována: ${method}`);
  }
}

async function handleMcpRequest(req, res, body) {
  if (req.method === "GET") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  const batch = Array.isArray(payload);
  const results = (await Promise.all((batch ? payload : [payload]).map(handleRpc))).filter(Boolean);
  if (results.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(batch ? results : results[0]));
}

module.exports = { handleMcpRequest, salesReport, _test: { pragueMidnight, pragueParts, addDays } };
