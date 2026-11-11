// Nejen Kafe – počítání zboží ve vitríně z fotky (Claude API, vision)
// Fotku z Telegramu stáhne, pošle Claudovi a vrátí počty kusů po výrobcích.
//
// Proměnné prostředí (Railway → Variables):
//   ANTHROPIC_API_KEY – klíč z console.anthropic.com (bez něj se vitrína nepočítá)
//   VITRINA_MODEL     – volitelně, výchozí claude-sonnet-5-5

const https = require("https");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.VITRINA_MODEL || "claude-sonnet-5-5";

const PRODUCTS = [
  ["croissanty", "croissanty všech druhů a náplní (ne mini croissanty)"],
  ["mini_croissanty", "mini croissanty a čokorolky"],
  ["kolacky", "kynuté koláčky (kulaté s náplní)"],
  ["snek", "skořicoví šneci a buchty"],
  ["motance", "motance / danish"],
  ["loupaky", "loupáky"],
  ["bulky", "bulky (brioškové, plněné i prázdné)"],
  ["housky", "housky / houstičky (i obložené)"],
  ["kolac_rezy", "řezy koláče / plechového koláče"],
  ["chlebicek_rezy", "řezy chlebíčku (banánový, pistáciový, makový), bábovky, perníku"],
  ["chleba", "bochníky a půlky chleba (půlka = 0,5)"],
  ["ostatni", "ostatní pečivo a zákusky"],
];

// Historie výsledků (v paměti, posledních 60 dní)
const log = [];

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function downloadTelegramPhoto(token, fileId) {
  const meta = JSON.parse((await getJson(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).toString());
  if (!meta.ok) throw new Error("Telegram getFile: " + meta.description);
  const buf = await getJson(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`);
  const ext = (meta.result.file_path.split(".").pop() || "jpg").toLowerCase();
  const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { data: buf.toString("base64"), mediaType };
}

function callClaude(image, context) {
  const prompt =
    `Jsi pomocník pekárny Nejen Kafe. Na fotce je vitrína kavárny (${context}). ` +
    `Spočítej co nejpřesněji kusy zboží, které jsou ve vitríně vidět, podle těchto skupin:\n` +
    PRODUCTS.map(([k, d]) => `- ${k}: ${d}`).join("\n") +
    `\n\nOdpověz POUZE jedním JSON objektem bez dalšího textu, ve tvaru ` +
    `{"pocty": {${PRODUCTS.map(([k]) => `"${k}": číslo`).join(", ")}}, ` +
    `"jistota": "vysoká|střední|nízká", "poznamka": "krátce, co nešlo spočítat nebo je zakryté"}. ` +
    `Když skupina na fotce není, dej 0. Nepočítej zboží mimo vitrínu.`;
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 600,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: prompt },
      ],
    }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01",
        "content-length": Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode >= 300) return reject(new Error(`Claude API ${res.statusCode}: ${data.slice(0, 300)}`));
          const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
          const m = text.match(/\{[\s\S]*\}/);
          if (!m) return reject(new Error("Claude nevrátil JSON: " + text.slice(0, 200)));
          resolve(JSON.parse(m[0]));
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const LABELS = {
  croissanty: "Croissanty", mini_croissanty: "Mini croissanty / čokorolky", kolacky: "Koláčky", snek: "Šneci",
  motance: "Motance", loupaky: "Loupáky", bulky: "Bulky", housky: "Housky", kolac_rezy: "Koláč (řezy)",
  chlebicek_rezy: "Chlebíček / bábovka (řezy)", chleba: "Chleba (bochníky)", ostatni: "Ostatní",
};

function formatResult(r) {
  let msg = `🧁 <b>Vitrína ${r.pobocka} – ${r.den} ${r.cas}</b> (termín ${r.termin})\n`;
  const lines = Object.entries(r.pocty || {}).filter(([, v]) => Number(v) > 0);
  msg += lines.length ? lines.map(([k, v]) => `• ${LABELS[k] || k}: ${v}`).join("\n") : "Vitrína je prázdná.";
  if (r.jistota) msg += `\n<i>Jistota: ${r.jistota}</i>`;
  if (r.poznamka) msg += `\n<i>${r.poznamka}</i>`;
  return msg;
}

// Hlavní funkce: zpracuje fotku a vrátí výsledek (nebo null, když chybí klíč)
async function analyze({ token, fileId, pobocka, den, cas, termin }) {
  if (!API_KEY) return null;
  const image = await downloadTelegramPhoto(token, fileId);
  const res = await callClaude(image, `pobočka ${pobocka}, ${den} v ${cas}, termín fotky ${termin}`);
  const entry = { pobocka, den, cas, termin, pocty: res.pocty || {}, jistota: res.jistota, poznamka: res.poznamka };
  log.push(entry);
  while (log.length && log[0].den < new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10)) log.shift();
  return entry;
}

function history({ od, do: doDne, pobocka } = {}) {
  return log.filter((e) => (!od || e.den >= od) && (!doDne || e.den <= doDne) && (!pobocka || e.pobocka === pobocka));
}

module.exports = { analyze, formatResult, history, enabled: () => Boolean(API_KEY), _test: { callClaude, PRODUCTS } };
