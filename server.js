require("dotenv").config();

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

    const [quote, news, profile] = await Promise.all([
      getQuote(symbol),
      getCompanyNews(symbol),
      getCompanyProfile(symbol),
    ]);

    res.json({ symbol, quote, news, profile });
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

    res.json({ symbol, quote, news, profile, analysis });
  } catch (error) {
    console.error("Analyze route error:", error);
    res.status(500).json({
      error: "Could not generate AI analysis",
      code: "ANALYSIS_ERROR",
      details: error.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});