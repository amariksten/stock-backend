// ── CONFIG ────────────────────────────────────────────────────────────────────
const API = "";
let currentLang = localStorage.getItem("lang") || "et";
let currentSymbol = null;
let watchlist = JSON.parse(localStorage.getItem("watchlist") || "[]");
let searchTimer = null;
let chartInstance = null;

// ── I18N ──────────────────────────────────────────────────────────────────────
const T = {
  et: {
    tagline:"Turu Intelligentsus", nav_dashboard:"Ülevaade", nav_watchlist:"Jälgimisloend",
    nav_screener:"Sõelur", nav_ai:"AI Analüütik", nav_news:"Uudised",
    dashboard_title:"Turu Ülevaade", watchlist_title:"Jälgimisloend",
    screener_title:"Aktsiate Sõelur", ai_title:"AI Analüütik", news_title:"Turuuudised",
    search_placeholder:"Otsi sümbolit või ettevõtet…", welcome_title:"Otsi aktsiaid alustamiseks",
    welcome_sub:"Sisesta tikker või ettevõtte nimi ülalpool, et näha hinnaandmeid, graafikuid ja AI analüüsi.",
    btn_ai_analyze:"AI Analüüs", btn_add_watch:"+ Jälgi", btn_watching:"✓ Jälgin", btn_send:"Saada",
    chart_weekly:"Nädalased küünlad", ai_placeholder:"Küsi midagi turu kohta…",
    filter_all_sectors:"Kõik sektorid", sort_mktcap:"Turuväärtus ↓", sort_change:"Muutus % ↓", sort_price:"Hind ↓",
    cat_general:"Üldine", loading:"Laadin…", error_load:"Andmete laadimine ebaõnnestus",
    wl_empty:"Jälgimisloend on tühi. Otsi aktsiaid ja lisa neid siia.",
    stat_open:"Avamine", stat_prev:"Eelm. sulg", stat_high:"Päeva kõrgeim", stat_low:"Päeva madalaim",
    stat_52h:"52n kõrgeim", stat_52l:"52n madalaim", stat_pe:"P/E suhe", stat_beta:"Beeta",
    stat_eps:"EPS", stat_mktcap:"Turuväärtus", stat_roe:"ROE", stat_margin:"Kasummarginaal",
    quick1:"Mis on S&P 500?", quick2:"Parimad dividendiaktsiad?", quick3:"Mis on P/E suhe?", quick4:"Kuidas inflatsiooni mõjutab aktsiaid?",
    analyzing:"Analüüsin…", sending:"Saadan…"
  },
  en: {
    tagline:"Market Intelligence", nav_dashboard:"Dashboard", nav_watchlist:"Watchlist",
    nav_screener:"Screener", nav_ai:"AI Analyst", nav_news:"News",
    dashboard_title:"Market Overview", watchlist_title:"Watchlist",
    screener_title:"Stock Screener", ai_title:"AI Analyst", news_title:"Market News",
    search_placeholder:"Search symbol or company…", welcome_title:"Search for a stock to get started",
    welcome_sub:"Enter a ticker or company name above to view price data, charts, and AI analysis.",
    btn_ai_analyze:"AI Analysis", btn_add_watch:"+ Watchlist", btn_watching:"✓ Watching", btn_send:"Send",
    chart_weekly:"Weekly Candles", ai_placeholder:"Ask anything about the market…",
    filter_all_sectors:"All Sectors", sort_mktcap:"Market Cap ↓", sort_change:"Change % ↓", sort_price:"Price ↓",
    cat_general:"General", loading:"Loading…", error_load:"Failed to load data",
    wl_empty:"Your watchlist is empty. Search for stocks and add them here.",
    stat_open:"Open", stat_prev:"Prev. Close", stat_high:"Day High", stat_low:"Day Low",
    stat_52h:"52w High", stat_52l:"52w Low", stat_pe:"P/E Ratio", stat_beta:"Beta",
    stat_eps:"EPS", stat_mktcap:"Market Cap", stat_roe:"ROE", stat_margin:"Profit Margin",
    quick1:"What is the S&P 500?", quick2:"Best dividend stocks?", quick3:"What is P/E ratio?", quick4:"How does inflation affect stocks?",
    analyzing:"Analyzing…", sending:"Sending…"
  }
};
const t = k => (T[currentLang]?.[k] ?? T.en[k] ?? k);

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const k = el.getAttribute("data-i18n");
    el.textContent = t(k);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  const lb = document.getElementById("langBtn");
  const lbm = document.getElementById("langBtnMobile");
  if (lb) lb.textContent = currentLang === "et" ? "🌐 EN" : "🌐 ET";
  if (lbm) lbm.textContent = currentLang === "et" ? "🌐 EN" : "🌐 ET";
}

function toggleLang() {
  currentLang = currentLang === "et" ? "en" : "et";
  localStorage.setItem("lang", currentLang);
  applyI18n();
  renderQuickBtns();
}

// ── TABS ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".tab-section").forEach(s => s.classList.remove("active"));
  document.getElementById("tab-"+tab)?.classList.add("active");
  document.querySelectorAll(".nav-btn,.mob-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  if (tab === "watchlist") renderWatchlist();
  if (tab === "screener") loadScreener();
  if (tab === "news") loadNews("general", document.querySelector(".filter-btn.active") || document.querySelector(".filter-btn"));
}

// ── MARKET OVERVIEW ───────────────────────────────────────────────────────────
async function loadMarketOverview() {
  try {
    const data = await apiFetch("/api/market/overview");
    const row = document.getElementById("indicesRow");
    row.innerHTML = data.indices.map(idx => {
      const up = (idx.dp ?? 0) >= 0;
      return `<div class="index-card">
        <div class="idx-label">${idx.label}</div>
        <div class="idx-price">$${fmt(idx.c)}</div>
        <div class="idx-change ${up?"up":"down"}">${up?"+":""}${(idx.dp??0).toFixed(2)}% (${up?"+":""}${fmt(idx.d)})</div>
      </div>`;
    }).join("");
  } catch(e) {
    document.getElementById("indicesRow").innerHTML = `<div class="error-state" style="grid-column:1/-1"><div class="error-state-icon">⚠️</div>${t("error_load")}</div>`;
  }
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
function onSearchInput(q) {
  clearTimeout(searchTimer);
  const dd = document.getElementById("searchDropdown");
  if (!q.trim()) { dd.classList.add("hidden"); return; }
  searchTimer = setTimeout(() => doSearch(q, dd, s => loadStock(s)), 350);
}

function onWlSearchInput(q) {
  clearTimeout(searchTimer);
  const dd = document.getElementById("wlDropdown");
  if (!q.trim()) { dd.classList.add("hidden"); return; }
  searchTimer = setTimeout(() => doSearch(q, dd, s => { addToWatchlist(s); dd.classList.add("hidden"); document.getElementById("wlSearchInput").value=""; }), 350);
}

async function doSearch(q, dd, onSelect) {
  dd.innerHTML = `<div class="sd-item"><span class="sd-sym">…</span></div>`;
  dd.classList.remove("hidden");
  try {
    const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!data.results?.length) { dd.innerHTML = `<div class="sd-item"><span style="color:var(--text3);font-size:.8rem">Tulemused puuduvad</span></div>`; return; }
    dd.innerHTML = data.results.map(r => `
      <div class="sd-item" onclick="(${onSelect.toString()})('${r.symbol}')">
        <span class="sd-sym">${r.symbol}</span>
        <span class="sd-desc">${r.description}</span>
      </div>`).join("");
  } catch { dd.innerHTML = `<div class="sd-item"><span style="color:var(--red);font-size:.8rem">Viga</span></div>`; }
}

// Close dropdowns on outside click
document.addEventListener("click", e => {
  if (!e.target.closest(".search-wrap")) {
    document.querySelectorAll(".search-dropdown").forEach(d => d.classList.add("hidden"));
  }
});

// ── STOCK DETAIL ──────────────────────────────────────────────────────────────
async function loadStock(symbol) {
  currentSymbol = symbol;
  document.getElementById("welcomeCard")?.classList.add("hidden") || (document.getElementById("welcomeCard").style.display="none");
  document.getElementById("welcomeCard").style.display = "none";
  const panel = document.getElementById("stockPanel");
  panel.classList.remove("hidden");
  document.querySelectorAll(".search-dropdown").forEach(d => d.classList.add("hidden"));
  document.getElementById("searchInput").value = symbol;

  // Reset
  document.getElementById("spSymbol").textContent = symbol;
  document.getElementById("spName").textContent = "…";
  document.getElementById("spBadge").textContent = "…";
  document.getElementById("spPrice").textContent = "…";
  document.getElementById("spChange").textContent = "…";
  document.getElementById("statsGrid").innerHTML = `<div class="loading-spinner" style="grid-column:1/-1"><div class="spinner"></div></div>`;
  document.getElementById("stockNews").innerHTML = "";
  document.getElementById("aiResult").classList.add("hidden");
  updateWatchBtn();

  try {
    const data = await apiFetch(`/api/stock/${symbol}`);
    const { quote: q, profile: p, news, candles } = data;

    document.getElementById("spSymbol").textContent = symbol;
    document.getElementById("spName").textContent = p.name || symbol;
    document.getElementById("spBadge").textContent = (p.finnhubIndustry || p.exchange || "—");
    document.getElementById("spPrice").textContent = `$${fmt(q.c)}`;

    const up = (q.dp ?? 0) >= 0;
    const chgEl = document.getElementById("spChange");
    chgEl.textContent = `${up?"+":""}${(q.dp??0).toFixed(2)}% (${up?"+":""}$${fmt(Math.abs(q.d??0))})`;
    chgEl.className = "sp-change " + (up ? "up" : "down");

    // Stats
    const mc = p.marketCapitalization;
    const mcStr = mc ? (mc >= 1e6 ? `$${(mc/1e6).toFixed(2)}T` : mc >= 1e3 ? `$${(mc/1e3).toFixed(1)}B` : `$${mc.toFixed(0)}M`) : "—";
    document.getElementById("statsGrid").innerHTML = [
      [t("stat_open"), `$${fmt(q.o)}`],
      [t("stat_prev"), `$${fmt(q.pc)}`],
      [t("stat_high"), `<span class="up">$${fmt(q.h)}</span>`],
      [t("stat_low"), `<span class="down">$${fmt(q.l)}</span>`],
      [t("stat_mktcap"), mcStr],
    ].map(([l,v]) => `<div class="stat-card"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join("");

    // Chart
    drawChart(candles);

    // News
    document.getElementById("stockNews").innerHTML = (news||[]).slice(0,5).map(n => `
      <div class="news-item">
        <div class="news-headline"><a href="${n.url}" target="_blank" rel="noopener">${n.headline}</a></div>
        <div class="news-meta">${n.source} · ${timeAgo(n.datetime)}</div>
      </div>`).join("") || "";
  } catch(e) {
    document.getElementById("statsGrid").innerHTML = `<div class="error-state" style="grid-column:1/-1"><div class="error-state-icon">⚠️</div>${t("error_load")}: ${e.message}</div>`;
  }
}

// ── CHART ─────────────────────────────────────────────────────────────────────
function drawChart(candles) {
  const canvas = document.getElementById("stockChart");
  const ctx = canvas.getContext("2d");
  const wrap = document.getElementById("chartWrap");
  if (!candles || !candles.closes?.length) {
    canvas.style.display = "none"; return;
  }
  canvas.style.display = "block";
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth - 32;
  const h = 160;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  ctx.scale(dpr, dpr);

  const closes = candles.closes;
  const min = Math.min(...candles.lows);
  const max = Math.max(...candles.highs);
  const range = max - min || 1;
  const n = closes.length;
  const padL = 8, padR = 8, padT = 12, padB = 8;
  const cw = (w - padL - padR) / n;

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = "rgba(42,51,86,0.7)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((h - padT - padB) * i / 4);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
  }

  closes.forEach((close, i) => {
    const open = candles.opens[i];
    const high = candles.highs[i];
    const low = candles.lows[i];
    const up = close >= open;
    const color = up ? "#10b981" : "#ef4444";
    const x = padL + i * cw + cw / 2;
    const toY = v => padT + (h - padT - padB) * (1 - (v - min) / range);

    // Wick
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, toY(high)); ctx.lineTo(x, toY(low)); ctx.stroke();

    // Body
    const bw = Math.max(cw * 0.55, 3);
    const y1 = toY(Math.max(open, close));
    const y2 = toY(Math.min(open, close));
    const bh = Math.max(Math.abs(y2 - y1), 1.5);
    ctx.fillStyle = color;
    ctx.fillRect(x - bw / 2, y1, bw, bh);
  });
}

// ── AI ANALYZE ────────────────────────────────────────────────────────────────
async function analyzeCurrentStock() {
  if (!currentSymbol) return;
  const btn = document.getElementById("spAiBtn");
  btn.disabled = true; btn.textContent = t("analyzing");
  const result = document.getElementById("aiResult");
  result.classList.remove("hidden");
  result.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>${t("analyzing")}</p></div>`;
  try {
    const data = await apiFetch("/api/analyze", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ symbol: currentSymbol }) });
    result.innerHTML = formatMarkdown(data.analysis || "—");
  } catch(e) {
    result.innerHTML = `<div class="error-state"><div class="error-state-icon">⚠️</div>${t("error_load")}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = t("btn_ai_analyze");
  }
}

function formatMarkdown(text) {
  return text
    .replace(/## (.+)/g, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>").replace(/$/, "</p>")
    .replace(/<p><h2>/g, "<h2>").replace(/<\/h2><\/p>/g, "</h2>");
}

// ── WATCHLIST ─────────────────────────────────────────────────────────────────
function updateWatchBtn() {
  const btn = document.getElementById("spWatchBtn");
  if (!btn || !currentSymbol) return;
  const inWl = watchlist.includes(currentSymbol);
  btn.textContent = inWl ? t("btn_watching") : t("btn_add_watch");
  btn.className = inWl ? "btn-secondary active-wl" : "btn-secondary";
}

function toggleWatchlistCurrent() {
  if (!currentSymbol) return;
  const idx = watchlist.indexOf(currentSymbol);
  if (idx >= 0) watchlist.splice(idx, 1);
  else watchlist.push(currentSymbol);
  localStorage.setItem("watchlist", JSON.stringify(watchlist));
  updateWatchBtn();
}

async function addToWatchlist(symbol) {
  if (!watchlist.includes(symbol)) {
    watchlist.push(symbol);
    localStorage.setItem("watchlist", JSON.stringify(watchlist));
  }
  renderWatchlist();
}

async function renderWatchlist() {
  const el = document.getElementById("watchlistTable");
  if (!watchlist.length) {
    el.innerHTML = `<div class="wl-empty">📋 ${t("wl_empty")}</div>`; return;
  }
  el.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  const rows = await Promise.all(watchlist.map(async sym => {
    try {
      const d = await apiFetch(`/api/stock/${sym}`);
      const up = (d.quote.dp ?? 0) >= 0;
      return { sym, name: d.profile.name || sym, c: d.quote.c, dp: d.quote.dp, up };
    } catch { return { sym, name: sym, c: null, dp: null, up: true }; }
  }));
  el.innerHTML = rows.map(r => `
    <div class="wl-row" onclick="loadStock('${r.sym}');switchTab('dashboard')">
      <span class="wl-sym">${r.sym}</span>
      <span class="wl-name">${r.name}</span>
      <span class="wl-price">${r.c != null ? "$"+fmt(r.c) : "—"}</span>
      <span class="wl-chg ${r.up?"up":"down"}">${r.dp != null ? (r.up?"+":"")+r.dp.toFixed(2)+"%" : "—"}</span>
      <button class="wl-rm" onclick="event.stopPropagation();removeFromWl('${r.sym}')" title="Eemalda">✕</button>
    </div>`).join("");
}

function removeFromWl(sym) {
  watchlist = watchlist.filter(s => s !== sym);
  localStorage.setItem("watchlist", JSON.stringify(watchlist));
  renderWatchlist();
  if (currentSymbol === sym) updateWatchBtn();
}

// ── SCREENER ──────────────────────────────────────────────────────────────────
let screenerLoaded = false;
async function loadScreener() {
  const sector = document.getElementById("sectorFilter").value;
  const sortBy = document.getElementById("sortFilter").value;
  const el = document.getElementById("screenerTable");
  if (!screenerLoaded) el.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;
  try {
    const data = await apiFetch(`/api/screener?sector=${encodeURIComponent(sector)}&sortBy=${sortBy}`);
    screenerLoaded = true;
    if (!data.results?.length) { el.innerHTML = `<div class="error-state">Tulemused puuduvad</div>`; return; }
    el.innerHTML = `<div class="screener-table"><table class="scr-table">
      <thead><tr>
        <th>Sümbol</th><th>Ettevõte</th><th>Hind</th><th>Muutus</th><th>Turuväärtus</th><th>P/E</th>
      </tr></thead>
      <tbody>${data.results.map(r => {
        const up = (r.dp ?? 0) >= 0;
        const mc = r.marketCap;
        const mcStr = mc ? (mc >= 1e6 ? `$${(mc/1e6).toFixed(2)}T` : mc >= 1e3 ? `$${(mc/1e3).toFixed(1)}B` : `$${mc.toFixed(0)}M`) : "—";
        return `<tr onclick="loadStock('${r.symbol}');switchTab('dashboard')" style="cursor:pointer">
          <td><span class="scr-sym">${r.symbol}</span></td>
          <td><span class="scr-name">${r.name}</span></td>
          <td>$${fmt(r.c)}</td>
          <td class="${up?"up":"down"}">${up?"+":""}${(r.dp??0).toFixed(2)}%</td>
          <td>${mcStr}</td>
          <td>${r.pe != null ? r.pe.toFixed(1) : "—"}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  } catch(e) {
    el.innerHTML = `<div class="error-state"><div class="error-state-icon">⚠️</div>${t("error_load")}</div>`;
  }
}

// ── AI CHAT ───────────────────────────────────────────────────────────────────
function renderQuickBtns() {
  const el = document.getElementById("quickBtns");
  el.innerHTML = ["quick1","quick2","quick3","quick4"].map(k =>
    `<button class="qbtn" onclick="askChat('${t(k).replace(/'/g,"\\'")}')">💬 ${t(k)}</button>`
  ).join("");
}

function askChat(q) {
  document.getElementById("chatInput").value = q;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById("chatInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  const msgs = document.getElementById("chatMessages");

  msgs.innerHTML += `<div class="chat-msg user"><div class="msg-bubble">${escHtml(q)}</div></div>`;
  const typing = document.createElement("div");
  typing.className = "chat-msg bot";
  typing.innerHTML = `<div class="msg-bubble"><div class="chat-typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
  msgs.appendChild(typing);
  msgs.scrollTop = msgs.scrollHeight;

  try {
    const data = await apiFetch("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ question: q, lang: currentLang, symbol: currentSymbol || "" })
    });
    msgs.removeChild(typing);
    const sent = data.sentiment || "neutral";
    const risk = data.riskLevel || "medium";
    const pts = (data.keyPoints || []).map(p => `<div class="key-point">${escHtml(p)}</div>`).join("");
    msgs.innerHTML += `<div class="chat-msg bot">
      <div class="msg-bubble">${escHtml(data.answer || "—")}${pts ? `<div class="key-points">${pts}</div>` : ""}</div>
      <div class="msg-meta">
        <span class="msg-badge badge-${sent}">${sent}</span>
        <span class="msg-badge badge-${risk}">Risk: ${risk}</span>
      </div>
    </div>`;
  } catch(e) {
    msgs.removeChild(typing);
    msgs.innerHTML += `<div class="chat-msg bot"><div class="msg-bubble" style="color:var(--red)">⚠️ ${t("error_load")}</div></div>`;
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// ── NEWS ──────────────────────────────────────────────────────────────────────
async function loadNews(source, btn) {
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const el = document.getElementById("newsFeed");
  el.innerHTML = `<div class="loading-spinner" style="grid-column:1/-1"><div class="spinner"></div></div>`;
  try {
    let data;
    if (source === "bbc") {
      data = await apiFetch("/api/news/bbc");
    } else if (source === "alphavantage") {
      data = await apiFetch("/api/news/alphavantage");
    } else if (source === "yahoo") {
      data = await apiFetch("/api/market/news?source=yahoo");
    } else {
      // finnhub — kõik allikad peale Reuters
      data = await apiFetch("/api/market/news");
    }
    el.innerHTML = (data.news || []).map(n => `
      <div class="news-card">
        ${n.image ? `<img class="news-card-img" src="${n.image}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="news-card-img-placeholder">📰</div>`}
        <div class="news-card-body">
          <div class="news-card-source">${n.source}</div>
          <div class="news-card-title"><a href="${n.url}" target="_blank" rel="noopener">${escHtml(n.headline)}</a></div>
          <div class="news-card-time">${timeAgo(n.datetime)}</div>
        </div>
      </div>`).join("") || `<div class="error-state" style="grid-column:1/-1">Uudised puuduvad</div>`;
  } catch(e) {
    const isNoKey = e.message?.includes("võti puudub") || e.message?.includes("MISSING_AV_KEY");
    el.innerHTML = `<div class="error-state" style="grid-column:1/-1">
      <div class="error-state-icon">${isNoKey ? "🔑" : "⚠️"}</div>
      ${isNoKey
        ? "Alpha Vantage API võti puudub. Lisa <code>ALPHA_VANTAGE_KEY</code> backend .env faili."
        : t("error_load")}
    </div>`;
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
async function apiFetch(url, opts) {
  const res = await fetch(API + url, opts);
  if (!res.ok) { const e = await res.json().catch(()=>({error:res.statusText})); throw new Error(e.error||res.statusText); }
  return res.json();
}

function fmt(n) { if (n == null || isNaN(n)) return "—"; return Number(n).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2}); }
function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function timeAgo(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const diff = Date.now() - d;
  const m = Math.floor(diff/60000);
  if (m < 60) return m + "min tagasi";
  const h = Math.floor(m/60);
  if (h < 24) return h + "h tagasi";
  return d.toLocaleDateString("et-EE");
}

// ── INIT ──────────────────────────────────────────────────────────────────────
applyI18n();
renderQuickBtns();
loadMarketOverview();
loadNews("finnhub", document.querySelector(".filter-btn"));
