// Nejen Kafe - Telegram Bot Server
// Přijímá webhook z Dotykačky a posílá denní report do Telegramu
// Spustit: node server.js

const http = require("http");

const TELEGRAM_TOKEN = "8926834458:AAHbuFG3kkl9JBqQ-UrJFmItwUY4Y1f3OS0";
const CHAT_ID = "8680493259";
const PORT = process.env.PORT || 3000;

// ─── Telegram helper ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
  });
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: "api.telegram.org" }, (res) => {
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
  // Dotykačka posílá data o uzavření dne / receipts
  // Formát závisí na typu webhooky - zde zpracujeme orders/receipts
  
  const orders = payload.orders || payload.receipts || payload.data || [];
  
  if (!orders.length) {
    return { totalTrzby: 0, pocetDokladu: 0, kategorie: {}, topProdukty: [] };
  }

  let totalTrzby = 0;
  let pocetDokladu = 0;
  const kategorie = {};
  const produkty = {};

  for (const order of orders) {
    const items = order.items || order.orderItems || [];
    pocetDokladu++;
    
    for (const item of items) {
      const cena = parseFloat(item.totalPrice || item.price || 0);
      const nazev = item.name || item.productName || "Neznámý";
      const kat = item.category || item.categoryName || "Ostatní";
      const mnozstvi = parseFloat(item.quantity || 1);

      totalTrzby += cena;
      kategorie[kat] = (kategorie[kat] || 0) + cena;
      
      if (!produkty[nazev]) produkty[nazev] = { trzby: 0, mnozstvi: 0 };
      produkty[nazev].trzby += cena;
      produkty[nazev].mnozstvi += mnozstvi;
    }
  }

  const topProdukty = Object.entries(produkty)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.trzby - a.trzby)
    .slice(0, 5);

  return { totalTrzby, pocetDokladu, kategorie, topProdukty };
}

// ─── Sestavení zprávy do Telegramu ────────────────────────────────────────────
function buildReportMessage(data, pokladna, datum) {
  const fmt = (n) => Math.round(n).toLocaleString("cs-CZ") + " Kč";
  const date = datum || new Date().toLocaleDateString("cs-CZ");

  let msg = `☕ <b>Nejen Kafe — denní report</b>\n`;
  msg += `📅 ${date}`;
  if (pokladna) msg += ` · ${pokladna}`;
  msg += `\n${"─".repeat(28)}\n\n`;

  msg += `💰 <b>Celkové tržby: ${fmt(data.totalTrzby)}</b>\n`;
  msg += `🧾 Počet dokladů: ${data.pocetDokladu}\n`;
  
  if (data.pocetDokladu > 0) {
    msg += `📊 Průměr/doklad: ${fmt(data.totalTrzby / data.pocetDokladu)}\n`;
  }

  // Kategorie
  const katEntries = Object.entries(data.kategorie).sort((a, b) => b[1] - a[1]);
  if (katEntries.length > 0) {
    msg += `\n<b>Tržby dle kategorií:</b>\n`;
    const katEmoji = {
      "Káva": "☕", "Sladké": "🥐", "Slané": "🥪", "MENU": "🍳",
      "Nealko": "🍋", "Obchod": "🛒", "Teplé nápoje": "🍵", "Zrna": "🫘"
    };
    for (const [kat, trzby] of katEntries) {
      if (trzby > 0) {
        const emoji = katEmoji[kat] || "•";
        const pct = ((trzby / data.totalTrzby) * 100).toFixed(0);
        msg += `${emoji} ${kat}: ${fmt(trzby)} (${pct}%)\n`;
      }
    }
  }

  // Top produkty
  if (data.topProdukty.length > 0) {
    msg += `\n<b>Top produkty:</b>\n`;
    data.topProdukty.forEach((p, i) => {
      msg += `${i + 1}. ${p.name} — ${fmt(p.trzby)} (${p.mnozstvi} ks)\n`;
    });
  }

  // Doporučení
  const kavaTrzby = data.kategorie["Káva"] || 0;
  const kavaPct = data.totalTrzby > 0 ? (kavaTrzby / data.totalTrzby) * 100 : 0;
  
  msg += `\n<b>💡 Poznámky:</b>\n`;
  if (kavaPct > 40) msg += `✅ Silný den na kávě (${kavaPct.toFixed(0)}%)\n`;
  if (kavaPct < 25 && data.totalTrzby > 0) msg += `⚠️ Káva pod 25% tržeb — zkontroluj\n`;
  if (data.totalTrzby > 15000) msg += `🎉 Výborný den — přes 15 000 Kč!\n`;
  if (data.totalTrzby < 5000 && data.totalTrzby > 0) msg += `📉 Slabší den — pod 5 000 Kč\n`;
  if (data.pocetDokladu > 80) msg += `🚀 Hodně zákazníků dnes (${data.pocetDokladu} dokladů)\n`;

  msg += `\n─────────────────────────────`;
  return msg;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Nejen Kafe Bot běží ✓");
    return;
  }

  // Test endpoint - pošle testovací zprávu
  if (req.method === "GET" && req.url === "/test") {
    const testData = {
      totalTrzby: 12450,
      pocetDokladu: 67,
      kategorie: {
        "Káva": 4800, "Sladké": 2100, "MENU": 3200,
        "Nealko": 950, "Obchod": 1400
      },
      topProdukty: [
        { name: "Flat White", trzby: 1760, mnozstvi: 20 },
        { name: "Vajíčka Benedikt", trzby: 2025, mnozstvi: 9 },
        { name: "Avokádový chléb", trzby: 1755, mnozstvi: 9 },
        { name: "Cappuccino", trzby: 1248, mnozstvi: 16 },
        { name: "Špaldový chléb", trzby: 1210, mnozstvi: 11 },
      ]
    };
    const msg = buildReportMessage(testData, "Mladá Boleslav", new Date().toLocaleDateString("cs-CZ"));
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

  // Webhook z Dotykačky
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        console.log("Webhook přijat:", new Date().toISOString());
        
        const pokladna = payload.cloudId || payload.branchName || payload.cashRegisterName || null;
        const datum = payload.date || new Date().toLocaleDateString("cs-CZ");
        const data = processWebhookData(payload);
        
        if (data.totalTrzby > 0 || data.pocetDokladu > 0) {
          const msg = buildReportMessage(data, pokladna, datum);
          await sendTelegram(msg);
          console.log("Report odeslán, tržby:", data.totalTrzby);
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
});
