require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 4000;

// ── CORS ─────────────────────────────────────────────────────────────────────
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── ENV ───────────────────────────────────────────────────────────────────────
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Liiga palju päringuid. Proovi uuesti 1 minuti pärast.",
    code: "RATE_LIMITED",
  },
});
app.use("/api/", apiLimiter);

// ── IN-MEMORY CACHE ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 1000; // 60 s
const _cache = new Map();

function getCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getMissingEnv() {
  const missing = [];
  if (!FINNHUB_API_KEY || FINNHUB_API_KEY.includes("your_")) missing.push("FINNHUB_API_KEY");
  if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("your_")) missing.push("GEMINI_API_KEY");
  return missing;
}

function sanitizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "")
    .slice(0, 12);
}

async function fetchJson(url, label, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${label} failed: ${response.status} ${text}`);
    }
    return response.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// ── FINNHUB FUNCTIONS ─────────────────────────────────────────────────────────
async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const quote = await fetchJson(url, "Finnhub quote API");

  if (!quote || typeof quote.c !== "number") {
    throw new Error("Finnhub returned invalid quote data");
  }

  setCache(key, quote);
  return quote;
}

async function getCompanyProfile(symbol) {
  const key = `profile:${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  try {
    const p = await fetchJson(url, "Finnhub profile API");
    const result = {
      name: p.name || symbol,
      exchange: p.exchange || "",
      finnhubIndustry: p.finnhubIndustry || "",
      logo: p.logo || "",
      weburl: p.weburl || "",
      marketCapitalization: p.marketCapitalization || null,
    };
    setCache(key, result);
    return result;
  } catch {
    const fallback = { name: symbol, exchange: "", finnhubIndustry: "", logo: "", weburl: "", marketCapitalization: null };
    setCache(key, fallback);
    return fallback;
  }
}

async function getCompanyNews(symbol) {
  const key = `news:${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setDate(today.getDate() - 7);
  const from = fromDate.toISOString().slice(0, 10);

  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
  const news = await fetchJson(url, "Finnhub company news API");

  if (!Array.isArray(news)) return [];

  const result = news.slice(0, 10).map((item) => ({
    id: item.id,
    datetime: item.datetime,
    headline: item.headline,
    source: item.source,
    summary: item.summary,
    url: item.url,
  }));

  setCache(key, result);
  return result;
}

async function searchSymbols(query) {
  const key = `search:${query}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${FINNHUB_API_KEY}`;
  const data = await fetchJson(url, "Finnhub search API");

  if (!data || !Array.isArray(data.result)) return [];

  const result = data.result
    .filter((item) => item.type === "Common Stock")
    .slice(0, 8)
    .map((item) => ({ symbol: item.symbol, description: item.description }));

  setCache(key, result);
  return result;
}

async function getWeeklyCandles(symbol) {
  const key = `candles:${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;

  const to = Math.floor(Date.now() / 1000);
  const from = to - 10 * 24 * 60 * 60; // 10 days to cover weekends
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;
  try {
    const data = await fetchJson(url, "Finnhub candle API");
    if (!data || data.s !== "ok" || !Array.isArray(data.c)) return null;
    const result = { closes: data.c, highs: data.h, lows: data.l, opens: data.o, volumes: data.v, timestamps: data.t };
    setCache(key, result);
    return result;
  } catch {
    return null;
  }
}

async function getBasicFinancials(symbol) {
  const key = `financials:${symbol}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${FINNHUB_API_KEY}`;
  try {
    const data = await fetchJson(url, "Finnhub financials API");
    const m = data?.metric || {};
    const result = {
      peRatioTTM: m.peBasicExclExtraTTM ?? null,
      epsTTM: m.epsBasicExclExtraTTM ?? null,
      week52High: m["52WeekHigh"] ?? null,
      week52Low: m["52WeekLow"] ?? null,
      week52Return: m["52WeekPriceReturnDaily"] ?? null,
      revenueGrowthTTMYoy: m.revenueGrowthTTMYoy ?? null,
      netProfitMarginTTM: m.netProfitMarginTTM ?? null,
      roeTTM: m.roeTTM ?? null,
      beta: m.beta ?? null,
    };
    setCache(key, result);
    return result;
  } catch {
    return null;
  }
}

// ── GEMINI ────────────────────────────────────────────────────────────────────
async function analyzeWithGemini(symbol, quote, news, profile, candles, financials) {
  // Format candle data
  let candleSummary = "Andmed puuduvad";
  if (candles && Array.isArray(candles.closes) && candles.closes.length > 0) {
    const lines = candles.closes.map((close, i) => {
      const date = new Date(candles.timestamps[i] * 1000).toLocaleDateString("et-EE");
      const open = candles.opens[i];
      const change = (((close - open) / open) * 100).toFixed(2);
      const dir = close >= open ? "↑" : "↓";
      const vol = candles.volumes[i];
      const volStr = vol >= 1e9 ? `${(vol/1e9).toFixed(1)}B` : vol >= 1e6 ? `${(vol/1e6).toFixed(1)}M` : `${(vol/1e3).toFixed(0)}K`;
      return `${date}: O=$${open.toFixed(2)} C=$${close.toFixed(2)} H=$${candles.highs[i].toFixed(2)} L=$${candles.lows[i].toFixed(2)} ${dir}${Math.abs(change)}% Maht:${volStr}`;
    });
    const first = candles.closes[0];
    const last = candles.closes[candles.closes.length - 1];
    const wkChg = (((last - first) / first) * 100).toFixed(2);
    candleSummary = `Nädalane muutus: ${wkChg >= 0 ? "+" : ""}${wkChg}%\n${lines.join("\n")}`;
  }

  // Format financials
  const f = financials || {};
  const finLines = [
    f.week52High != null ? `52n kõrgeim: $${f.week52High.toFixed(2)}` : null,
    f.week52Low  != null ? `52n madalaim: $${f.week52Low.toFixed(2)}`  : null,
    f.week52Return != null ? `52n tootlus: ${f.week52Return.toFixed(1)}%` : null,
    f.peRatioTTM != null ? `P/E: ${f.peRatioTTM.toFixed(1)}` : null,
    f.epsTTM     != null ? `EPS: $${f.epsTTM.toFixed(2)}` : null,
    f.beta       != null ? `Beeta: ${f.beta.toFixed(2)}` : null,
    f.revenueGrowthTTMYoy != null ? `Käibe kasv YoY: ${(f.revenueGrowthTTMYoy*100).toFixed(1)}%` : null,
    f.netProfitMarginTTM  != null ? `Kasummarginaal: ${(f.netProfitMarginTTM*100).toFixed(1)}%`  : null,
    f.roeTTM != null ? `ROE: ${(f.roeTTM*100).toFixed(1)}%` : null,
  ].filter(Boolean).join("\n");

  const mc = profile?.marketCapitalization;
  const mcStr = mc ? (mc >= 1e6 ? `$${(mc/1e6).toFixed(2)}T` : mc >= 1e3 ? `$${(mc/1e3).toFixed(1)}B` : `$${mc.toFixed(0)}M`) : "Teadmata";

  const prompt = `Sa oled eestikeelne kogenud aktsiaturu analüütik. Tee põhjalik NÄDALA analüüs.

Reeglid:
- Ära anna ostu/müügisoovitust
- Selgita lihtsas keeles, lisa konkreetsed numbrid
- Ole aus riskide osas

=== AKTSIA ===
Symbol: ${symbol} | Firma: ${profile?.name || symbol}
Sektor: ${profile?.finnhubIndustry || "Teadmata"} | Börs: ${profile?.exchange || "Teadmata"}
Turukapital: ${mcStr}

=== PRAEGUNE HIND ===
Hind: $${quote.c?.toFixed(2) ?? "N/A"}
Päeva muutus: ${(quote.dp??0)>=0?"+":""}${(quote.dp??0).toFixed(2)}% ($${(quote.d??0)>=0?"+":""}${(quote.d??0).toFixed(2)})
Avamine: $${quote.o?.toFixed(2)??"N/A"} | Eelmine sulg: $${quote.pc?.toFixed(2)??"N/A"}
Päeva kõrgeim: $${quote.h?.toFixed(2)??"N/A"} | Päeva madalaim: $${quote.l?.toFixed(2)??"N/A"}

=== NÄDALA KÜÜNLAD ===
${candleSummary}

=== PÕHINÄITAJAD ===
${finLines || "Andmed puuduvad"}

=== UUDISED (${news.length} artiklit) ===
${news.map((n,i)=>`[${i+1}] ${new Date((n.datetime||0)*1000).toLocaleDateString("et-EE")} — ${n.headline||""} (${n.source||""})`).join("\n")}

Vasta TÄPSELT selle struktuuriga:

## 1. Nädala kokkuvõte
## 2. Hinnaliikumine
## 3. Uudiste mõju
## 4. Tugevused
## 5. Riskid
## 6. Järgmise nädala fookus
## 7. Disclaimer`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });

  const text = typeof response.text === "function" ? response.text() : response.text;
  return text || "AI analüüsi ei saadud luua.";
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, service: "stock-ai-backend", message: "Backend is running" });
});

app.get("/api/health", (req, res) => {
  const missingEnv = getMissingEnv();
  res.json({
    ok: missingEnv.length === 0,
    service: "stock-ai-backend",
    aiProvider: "google-gemini",
    geminiModel: GEMINI_MODEL,
    cacheSize: _cache.size,
    missingEnv,
  });
});

// Symbol otsing
app.get("/api/search", async (req, res) => {
  try {
    const missingEnv = getMissingEnv();
    if (missingEnv.length > 0) {
      return res.status(500).json({ error: "Missing environment variables", missingEnv });
    }

    const q = String(req.query.q || "").trim().slice(0, 30);
    if (!q) return res.status(400).json({ error: "Query is required", code: "MISSING_QUERY" });

    const results = await searchSymbols(q);
    res.json({ results });
  } catch (error) {
    console.error("Search route error:", error);
    res.status(500).json({ error: "Could not search symbols", details: error.message });
  }
});

// Aktsia hind + uudised + profiil
app.get("/api/stock/:symbol", async (req, res) => {
  try {
    const missingEnv = getMissingEnv();
    if (missingEnv.length > 0) {
      return res.status(500).json({ error: "Missing environment variables", missingEnv });
    }

    const symbol = sanitizeSymbol(req.params.symbol);
    if (!symbol) return res.status(400).json({ error: "Symbol is required", code: "MISSING_SYMBOL" });

    const [quote, news, profile, candles] = await Promise.all([
      getQuote(symbol),
      getCompanyNews(symbol),
      getCompanyProfile(symbol),
      getWeeklyCandles(symbol),
    ]);

    res.json({ symbol, quote, news, profile, candles });
  } catch (error) {
    console.error("Stock route error:", error);
    const isNotFound = error.message?.includes("invalid quote");
    res.status(isNotFound ? 404 : 500).json({
      error: isNotFound ? "Symbol not found" : "Could not fetch stock data",
      code: isNotFound ? "SYMBOL_NOT_FOUND" : "API_ERROR",
      details: error.message,
    });
  }
});

// AI analüüs
app.post("/api/analyze", async (req, res) => {
  try {
    const missingEnv = getMissingEnv();
    if (missingEnv.length > 0) {
      return res.status(500).json({ error: "Missing environment variables", missingEnv });
    }

    const symbol = sanitizeSymbol(req.body.symbol);
    if (!symbol) return res.status(400).json({ error: "Symbol is required", code: "MISSING_SYMBOL" });

    const [quote, news, profile, candles, financials] = await Promise.all([
      getQuote(symbol),
      getCompanyNews(symbol),
      getCompanyProfile(symbol),
      getWeeklyCandles(symbol),
      getBasicFinancials(symbol),
    ]);

    const analysis = await analyzeWithGemini(symbol, quote, news, profile, candles, financials);

    res.json({ symbol, quote, news, profile, candles, financials, analysis });
  } catch (error) {
    console.error("Analyze route error:", error);
    res.status(500).json({
      error: "Could not generate AI analysis",
      code: "ANALYSIS_ERROR",
      details: error.message,
    });
  }
});

// ── MARKET OVERVIEW ───────────────────────────────────────────────────────────────────────
const INDEX_SYMBOLS = [
  { symbol: "SPY",  label: "S&P 500" },
  { symbol: "QQQ",  label: "NASDAQ 100" },
  { symbol: "DIA",  label: "Dow Jones" },
  { symbol: "IWM",  label: "Russell 2000" },
];

app.get("/api/market/overview", async (req, res) => {
  try {
    const quotes = await Promise.all(
      INDEX_SYMBOLS.map(async ({ symbol, label }) => {
        try {
          const q = await getQuote(symbol);
          return { symbol, label, c: q.c, d: q.d, dp: q.dp, pc: q.pc };
        } catch { return { symbol, label, c: null, d: null, dp: null }; }
      })
    );
    res.json({ indices: quotes });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch market overview", details: error.message });
  }
});

// ── BBC RSS PARSER ────────────────────────────────────────────────────────────────────
function parseBBCRSS(xml) {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  return items.slice(0, 20).map(item => {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
    const link  = (item.match(/<link>(.*?)<\/link>/) || [])[1]?.trim() || "";
    const pub   = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim() || "";
    const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || item.match(/<description>(.*?)<\/description>/))?.[1] || "";
    const img   = (item.match(/url="([^"]*?\.jpg[^"]*?)"/i) || [])[1] || "";
    return {
      id: Math.random(),
      datetime: pub ? Math.floor(new Date(pub).getTime() / 1000) : Math.floor(Date.now() / 1000),
      headline: title, source: "BBC News",
      summary: desc.replace(/<[^>]+>/g, "").slice(0, 200),
      url: link, image: img,
    };
  }).filter(n => n.headline);
}

// ── FINNHUB MARKET NEWS (Reuters filteeritud välja) ───────────────────────────────────
app.get("/api/market/news", async (req, res) => {
  try {
    const source = (req.query.source || "").toLowerCase();
    const key = `mktNews:general:${source}`;
    const cached = getCache(key);
    if (cached) return res.json({ news: cached });
    const url = `https://finnhub.io/api/v1/news?category=general&minId=0&token=${FINNHUB_API_KEY}`;
    const data = await fetchJson(url, "Finnhub market news");
    let items = (Array.isArray(data) ? data : [])
      .filter(n => !((n.source || "").toLowerCase().includes("reuters")));
    if (source) {
      items = items.filter(n => (n.source || "").toLowerCase().includes(source));
    }
    const result = items.slice(0, 20).map(n => ({
      id: n.id, datetime: n.datetime, headline: n.headline,
      source: n.source, summary: n.summary, url: n.url, image: n.image || "",
    }));
    setCache(key, result);
    res.json({ news: result });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch news", details: error.message });
  }
});

// ── BBC BUSINESS NEWS ─────────────────────────────────────────────────────────────────
app.get("/api/news/bbc", async (req, res) => {
  const key = "news:bbc";
  const cached = getCache(key);
  if (cached) return res.json({ news: cached });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const r = await fetch("https://feeds.bbci.co.uk/news/business/rss.xml", { signal: controller.signal });
    clearTimeout(timer);
    const xml = await r.text();
    const result = parseBBCRSS(xml);
    setCache(key, result);
    res.json({ news: result });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch BBC news", details: error.message });
  }
});

// ── ALPHA VANTAGE NEWS ────────────────────────────────────────────────────────────────
const AV_API_KEY = process.env.ALPHA_VANTAGE_KEY || "";
app.get("/api/news/alphavantage", async (req, res) => {
  if (!AV_API_KEY || AV_API_KEY.includes("your_")) {
    return res.status(400).json({ error: "Alpha Vantage API võti puudub", code: "MISSING_AV_KEY" });
  }
  const key = "news:av";
  const cached = getCache(key);
  if (cached) return res.json({ news: cached });
  try {
    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=financial_markets&limit=20&apikey=${AV_API_KEY}`;
    const data = await fetchJson(url, "Alpha Vantage news");
    const result = (data.feed || []).slice(0, 20).map(n => ({
      id: Math.random(),
      datetime: n.time_published
        ? Math.floor(new Date(n.time_published.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6")).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      headline: n.title || "", source: n.source || "Alpha Vantage",
      summary: n.summary || "", url: n.url || "", image: n.banner_image || "",
    }));
    setCache(key, result);
    res.json({ news: result });
  } catch (error) {
    res.status(500).json({ error: "Could not fetch Alpha Vantage news", details: error.message });
  }
});

// ── AI CHAT ─────────────────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const missingEnv = getMissingEnv();
    if (missingEnv.length > 0) return res.status(500).json({ error: "Missing env", missingEnv });
    const question = String(req.body.question || "").trim().slice(0, 500);
    const lang = req.body.lang === "en" ? "en" : "et";
    if (!question) return res.status(400).json({ error: "question required" });

    let stockContext = "";
    const sym = sanitizeSymbol(req.body.symbol || "");
    if (sym) {
      try {
        const [q, news, profile, fin] = await Promise.all([
          getQuote(sym), getCompanyNews(sym), getCompanyProfile(sym), getBasicFinancials(sym)
        ]);
        stockContext = `\nStock context for ${sym} (${profile.name}):\nPrice: $${q.c?.toFixed(2)} | Change: ${q.dp?.toFixed(2)}%\nP/E: ${fin?.peRatioTTM ?? 'N/A'} | 52w High: $${fin?.week52High ?? 'N/A'} | Low: $${fin?.week52Low ?? 'N/A'}\nRecent news: ${news.slice(0,3).map(n=>n.headline).join(' | ')}`;
      } catch { /* ignore */ }
    }

    const langInstr = lang === "en"
      ? "Answer in English. Be concise and clear."
      : "Vasta eesti keeles. Ole lühike ja selge.";

    const prompt = `You are a professional stock market analyst assistant. ${langInstr}\n\nUser question: ${question}${stockContext}\n\nProvide a structured JSON response with these exact fields:\n{\n  "answer": "detailed answer in 2-4 paragraphs",\n  "sentiment": "bullish" | "neutral" | "bearish",\n  "trend": "up" | "down" | "sideways",\n  "riskLevel": "low" | "medium" | "high",\n  "keyPoints": ["point1", "point2", "point3"],\n  "disclaimer": "short disclaimer"\n}\n\nIMPORTANT: Return ONLY valid JSON, no markdown.`;

    const response = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
    const text = typeof response.text === "function" ? response.text() : response.text;
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { parsed = { answer: text, sentiment: "neutral", trend: "sideways", riskLevel: "medium", keyPoints: [], disclaimer: "" }; }
    res.json(parsed);
  } catch (error) {
    console.error("Chat route error:", error);
    res.status(500).json({ error: "Chat failed", details: error.message });
  }
});

// ── SCREENER ─────────────────────────────────────────────────────────────────────────────
const SCREENER_UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK.B","JPM","V","UNH","XOM","JNJ","MA","PG","HD","MRK","AVGO","CVX","LLY","ABBV","COST","PEP","KO","ADBE","WMT","MCD","CRM","AMD","INTC","NFLX","QCOM","TXN","NEE","PM","HON","UPS","BA","CAT","GS","MS","SBUX","AMGN","GILD","DE","LOW","BLK","SPGI","AXP","PYPL"];

app.get("/api/screener", async (req, res) => {
  try {
    const cKey = `screener:all`;
    let results = getCache(cKey);
    if (!results) {
      const batch = await Promise.all(
        SCREENER_UNIVERSE.map(async (sym) => {
          try {
            const [q, p, f] = await Promise.all([getQuote(sym), getCompanyProfile(sym), getBasicFinancials(sym)]);
            return { symbol: sym, name: p.name || sym, industry: p.finnhubIndustry || "",
              c: q.c, d: q.d, dp: q.dp, marketCap: p.marketCapitalization,
              pe: f?.peRatioTTM ?? null, week52High: f?.week52High ?? null, week52Low: f?.week52Low ?? null };
          } catch { return null; }
        })
      );
      results = batch.filter(Boolean);
      setCache(cKey, results);
    }
    const sector = req.query.sector || "";
    const sortBy = req.query.sortBy || "marketCap";
    let filtered = sector ? results.filter(r => r.industry.toLowerCase().includes(sector.toLowerCase())) : results;
    filtered.sort((a, b) => (b[sortBy] ?? -Infinity) - (a[sortBy] ?? -Infinity));
    res.json({ results: filtered.slice(0, 50) });
  } catch (error) {
    res.status(500).json({ error: "Screener failed", details: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});