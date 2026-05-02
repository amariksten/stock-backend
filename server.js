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

  const result = news.slice(0, 6).map((item) => ({
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

// ── GEMINI ────────────────────────────────────────────────────────────────────
async function analyzeWithGemini(symbol, quote, news, profile) {
  const prompt = `Sa oled eestikeelne ettevaatlik aktsiaturu analüütik.

Tähtsad reeglid:
- Ära anna otsest ostu- või müügisoovitust.
- Selgita lihtsas keeles.
- Maini ebakindlust.
- Lisa disclaimer, et see ei ole finantsnõuanne.

Analüüsi seda aktsiat.

Symbol: ${symbol}
Firma: ${profile?.name || symbol}
Sektor: ${profile?.finnhubIndustry || "Teadmata"}
Börs: ${profile?.exchange || "Teadmata"}

Quote data:
${JSON.stringify(quote, null, 2)}

Recent news (viimased 7 päeva):
${JSON.stringify(news, null, 2)}

Vasta täpselt selle struktuuriga:

1. Lühikokkuvõte
2. Mis võib hinda liigutada
3. Positiivsed tegurid
4. Riskid
5. Mida järgmisena jälgida
6. Disclaimer`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });

  // Handle both property and method variants across SDK versions
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

    const [quote, news, profile] = await Promise.all([
      getQuote(symbol),
      getCompanyNews(symbol),
      getCompanyProfile(symbol),
    ]);

    const analysis = await analyzeWithGemini(symbol, quote, news, profile);

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