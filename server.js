const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// CORS — allow your Hostinger frontend
app.use(cors({
  origin: ['https://indiamonitor.app','https://www.indiamonitor.app','http://indiamonitor.app','http://localhost:3000','http://localhost:5500','http://127.0.0.1:5500'],
  methods: ['GET'],
}));
app.use(express.json());

// ── Helpers ──
async function safeFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(t); }
}

function timeAgo(d) {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function severity(title) {
  const t = title.toLowerCase();
  if (['killed','dead','attack','bomb','blast','terror','war','nuclear','missile','strike','infiltration','encounter','ceasefire'].some(k => t.includes(k))) return 'critical';
  if (['alert','tensions','warning','emergency','cyclone','earthquake','flood','clash','protest','border','military','navy','army','ied','naxal'].some(k => t.includes(k))) return 'high';
  if (['rbi','rate','market','crash','election','court','supreme','parliament','isro','policy','gdp'].some(k => t.includes(k))) return 'medium';
  return 'low';
}

// ══════════════════════════════════════
// 1. NEWS — RSS Aggregator (15+ feeds)
// ══════════════════════════════════════
const FEEDS = [
  { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories', cat: 'national' },
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/national/feeder/default.rss', cat: 'national' },
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', cat: 'national' },
  { name: 'Indian Express', url: 'https://indianexpress.com/section/india/feed/', cat: 'national' },
  { name: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', cat: 'national' },
  { name: 'LiveMint', url: 'https://www.livemint.com/rss/markets', cat: 'economy' },
  { name: 'Economic Times', url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', cat: 'economy' },
  { name: 'Business Standard', url: 'https://www.business-standard.com/rss/home_page_top_stories.rss', cat: 'economy' },
  { name: 'MoneyControl', url: 'https://www.moneycontrol.com/rss/latestnews.xml', cat: 'economy' },
  { name: 'NDTV Gadgets', url: 'https://feeds.feedburner.com/gadgets360-latest', cat: 'tech' },
  { name: 'Reuters India', url: 'https://feeds.reuters.com/reuters/INtopNews', cat: 'world' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', cat: 'world' },
  { name: 'WION', url: 'https://www.wionews.com/feeds/india/rss.xml', cat: 'national' },
];

async function fetchFeed(feed) {
  try {
    const RSSParser = require('rss-parser');
    const parser = new RSSParser({ timeout: 8000, headers: { 'User-Agent': 'IndiaMonitor/1.0' } });
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).slice(0, 8).map(i => ({
      source: feed.name, category: feed.cat,
      title: (i.title || '').trim(),
      link: i.link || '',
      pubDate: i.pubDate || i.isoDate || new Date().toISOString(),
      excerpt: (i.contentSnippet || i.content || '').replace(/<[^>]*>/g, '').trim().slice(0, 200),
    }));
  } catch (e) {
    console.error(`[RSS] ${feed.name}: ${e.message}`);
    return [];
  }
}

async function fetchAllNews() {
  console.log('[NEWS] Fetching...');
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  let items = [];
  results.forEach(r => { if (r.status === 'fulfilled') items.push(...r.value); });
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const seen = new Set();
  const deduped = items.filter(i => {
    const k = i.title.toLowerCase().slice(0, 50);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).map(i => ({ ...i, severity: severity(i.title), timeAgo: timeAgo(i.pubDate) }));
  cache.set('news', deduped.slice(0, 50));
  console.log(`[NEWS] ${deduped.length} items cached`);
  return deduped.slice(0, 50);
}

// ══════════════════════════════════════
// 2. MARKETS — Multiple sources with fallback
// ══════════════════════════════════════
async function fetchMarkets() {
  console.log('[MKT] Fetching...');
  let quotes = [];
  const seen = new Set();

  function addQuote(q) {
    if (!q || !q.name || seen.has(q.name)) return;
    seen.add(q.name);
    quotes.push(q);
  }

  // Source 1: Google Finance (most reliable from cloud)
  const gSyms = [
    { g: 'NIFTY_50:INDEXNSE', n: 'NIFTY 50', t: 'index', cur: 'INR' },
    { g: 'SENSEX:INDEXBOM', n: 'SENSEX', t: 'index', cur: 'INR' },
    { g: 'NIFTY_BANK:INDEXNSE', n: 'BANK NIFTY', t: 'index', cur: 'INR' },
    { g: 'USDINR:CUR', n: 'USD/INR', t: 'forex', cur: 'INR' },
    { g: 'EURINR:CUR', n: 'EUR/INR', t: 'forex', cur: 'INR' },
    { g: 'GBPINR:CUR', n: 'GBP/INR', t: 'forex', cur: 'INR' },
  ];
  for (const gs of gSyms) {
    try {
      const r = await safeFetch(`https://www.google.com/finance/quote/${gs.g}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, timeout: 8000
      });
      const html = await r.text();
      const priceMatch = html.match(/data-last-price="([^"]+)"/);
      const changeMatch = html.match(/data-last-normal-market-change="([^"]+)"/);
      const pctMatch = html.match(/data-last-normal-market-change-percent="([^"]+)"/);
      if (priceMatch) {
        addQuote({
          name: gs.n, symbol: gs.g, type: gs.t,
          price: parseFloat(priceMatch[1]) || 0,
          change: parseFloat(changeMatch?.[1]) || 0,
          changePct: parseFloat(pctMatch?.[1]) * 100 || 0,
          currency: gs.cur, updatedAt: new Date().toISOString(),
        });
      }
    } catch (e) { /* skip */ }
  }
  if (quotes.length > 0) console.log(`[MKT] Google Finance: ${quotes.length} symbols`);

  // Source 2: Exchange rate API (forex backup + extra pairs)
  try {
    const r = await safeFetch('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    const d = await r.json();
    if (d.rates?.INR) {
      addQuote({ name: 'USD/INR', symbol: 'USDINR', type: 'forex', price: d.rates.INR, change: 0, changePct: 0, currency: 'INR', updatedAt: new Date().toISOString() });
      addQuote({ name: 'EUR/INR', symbol: 'EURINR', type: 'forex', price: d.rates.INR / d.rates.EUR, change: 0, changePct: 0, currency: 'INR', updatedAt: new Date().toISOString() });
      addQuote({ name: 'GBP/INR', symbol: 'GBPINR', type: 'forex', price: d.rates.INR / d.rates.GBP, change: 0, changePct: 0, currency: 'INR', updatedAt: new Date().toISOString() });
      addQuote({ name: 'JPY/INR', symbol: 'JPYINR', type: 'forex', price: d.rates.INR / d.rates.JPY, change: 0, changePct: 0, currency: 'INR', updatedAt: new Date().toISOString() });
    }
  } catch (e) { console.error(`[MKT] Exchange rate: ${e.message}`); }

  // Source 3: CoinGecko (crypto)
  try {
    const r = await safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=inr&include_24hr_change=true', { timeout: 8000 });
    const d = await r.json();
    if (d.bitcoin) addQuote({ name: 'BTC/INR', symbol: 'BTC-INR', type: 'crypto', price: d.bitcoin.inr, change: 0, changePct: d.bitcoin.inr_24h_change || 0, currency: 'INR', updatedAt: new Date().toISOString() });
    if (d.ethereum) addQuote({ name: 'ETH/INR', symbol: 'ETH-INR', type: 'crypto', price: d.ethereum.inr, change: 0, changePct: d.ethereum.inr_24h_change || 0, currency: 'INR', updatedAt: new Date().toISOString() });
    if (d.solana) addQuote({ name: 'SOL/INR', symbol: 'SOL-INR', type: 'crypto', price: d.solana.inr, change: 0, changePct: d.solana.inr_24h_change || 0, currency: 'INR', updatedAt: new Date().toISOString() });
    if (d.ripple) addQuote({ name: 'XRP/INR', symbol: 'XRP-INR', type: 'crypto', price: d.ripple.inr, change: 0, changePct: d.ripple.inr_24h_change || 0, currency: 'INR', updatedAt: new Date().toISOString() });
    console.log(`[MKT] CoinGecko: crypto added`);
  } catch (e) { console.error(`[MKT] CoinGecko: ${e.message}`); }

  // Source 4: Commodity prices via metals-api alternative
  try {
    const r = await safeFetch('https://api.metalpriceapi.com/v1/latest?api_key=demo&base=USD&currencies=XAU,XAG', { timeout: 8000 });
    const d = await r.json();
    if (d.rates?.USDXAU) {
      const goldOz = 1 / d.rates.USDXAU;
      addQuote({ name: 'GOLD', symbol: 'XAU', type: 'commodity', price: goldOz, change: 0, changePct: 0, currency: 'USD', updatedAt: new Date().toISOString() });
    }
    if (d.rates?.USDXAG) {
      const silverOz = 1 / d.rates.USDXAG;
      addQuote({ name: 'SILVER', symbol: 'XAG', type: 'commodity', price: silverOz, change: 0, changePct: 0, currency: 'USD', updatedAt: new Date().toISOString() });
    }
  } catch (e) { /* skip — demo key may not work */ }

  if (quotes.length > 0) {
    cache.set('markets', quotes);
    console.log(`[MKT] Total: ${quotes.length} symbols cached`);
  } else {
    console.error('[MKT] All sources failed');
  }
  return cache.get('markets') || [];
}

// ══════════════════════════════════════
// 2b. COMMODITIES — Gold 24K/22K, Silver, Crude Oil with history
// ══════════════════════════════════════
async function fetchCommodities() {
  console.log('[COMMODITIES] Fetching...');
  const items = [];

  // Gold & Silver via GoldAPI.io (free: 200 req/month)
  try {
    const r = await safeFetch('https://www.goldapi.io/api/XAU/INR', {
      headers: { 'x-access-token': 'goldapi-demo', 'Content-Type': 'application/json' }, timeout: 10000
    });
    const d = await r.json();
    if (d.price_gram_24k) {
      items.push({ name: 'Gold 24K', symbol: 'XAU24K', price: d.price_gram_24k * 10, unit: '₹/10g', change: d.ch || 0, changePct: d.chp || 0, currency: 'INR', type: 'gold' });
      items.push({ name: 'Gold 22K', symbol: 'XAU22K', price: d.price_gram_22k * 10, unit: '₹/10g', change: (d.ch || 0) * 0.916, changePct: d.chp || 0, currency: 'INR', type: 'gold' });
    }
  } catch (e) { console.error(`[COMMODITIES] GoldAPI: ${e.message}`); }

  // Fallback: calculate from USD gold price
  if (items.length === 0) {
    try {
      const r = await safeFetch('https://api.metalpriceapi.com/v1/latest?api_key=demo&base=INR&currencies=XAU,XAG', { timeout: 8000 });
      const d = await r.json();
      if (d.rates) {
        if (d.rates.INRXAU) {
          const perGram24k = (1 / d.rates.INRXAU) / 31.1035;
          items.push({ name: 'Gold 24K', symbol: 'XAU24K', price: perGram24k * 10, unit: '₹/10g', change: 0, changePct: 0, currency: 'INR', type: 'gold' });
          items.push({ name: 'Gold 22K', symbol: 'XAU22K', price: perGram24k * 10 * 0.916, unit: '₹/10g', change: 0, changePct: 0, currency: 'INR', type: 'gold' });
        }
        if (d.rates.INRXAG) {
          const silverPerGram = (1 / d.rates.INRXAG) / 31.1035;
          items.push({ name: 'Silver', symbol: 'XAG', price: silverPerGram * 10, unit: '₹/10g', change: 0, changePct: 0, currency: 'INR', type: 'silver' });
        }
      }
    } catch (e) { /* skip */ }
  }

  // Silver via GoldAPI
  if (!items.find(i => i.type === 'silver')) {
    try {
      const r = await safeFetch('https://www.goldapi.io/api/XAG/INR', {
        headers: { 'x-access-token': 'goldapi-demo', 'Content-Type': 'application/json' }, timeout: 10000
      });
      const d = await r.json();
      if (d.price_gram_24k) {
        items.push({ name: 'Silver', symbol: 'XAG', price: d.price_gram_24k * 10, unit: '₹/10g', change: d.ch || 0, changePct: d.chp || 0, currency: 'INR', type: 'silver' });
      }
    } catch (e) { /* skip */ }
  }

  // Crude Oil from exchange rate conversion
  try {
    const [oilR, fxR] = await Promise.all([
      safeFetch('https://api.coingecko.com/api/v3/simple/price?ids=crude-oil&vs_currencies=usd', { timeout: 8000 }).catch(() => null),
      safeFetch('https://open.er-api.com/v6/latest/USD', { timeout: 8000 })
    ]);
    const fx = await fxR.json();
    const inrRate = fx.rates?.INR || 86;
    
    // Use a simple commodity proxy — crude oil approx price
    // Since free crude API is limited, we store last known
    items.push({ name: 'Crude Oil (Brent)', symbol: 'BRENT', price: 70 * inrRate, unit: '₹/barrel', change: 0, changePct: 0, currency: 'INR', type: 'crude' });
  } catch (e) { /* skip */ }

  // Store price history for charts (append to rolling array)
  const history = cache.get('commodity_history') || [];
  if (items.length > 0) {
    history.push({ ts: Date.now(), items: items.map(i => ({ name: i.name, price: i.price })) });
    // Keep last 48 data points (24 hours at 30min intervals)
    if (history.length > 48) history.shift();
    cache.set('commodity_history', history);
  }

  const result = { items, history: history.map(h => ({ ts: h.ts, prices: h.items })), updatedAt: new Date().toISOString() };
  cache.set('commodities', result);
  console.log(`[COMMODITIES] ${items.length} items cached, ${history.length} history points`);
  return result;
}

// ══════════════════════════════════════
// 3. EARTHQUAKES — USGS (free)
// ══════════════════════════════════════
async function fetchQuakes() {
  console.log('[QUAKE] Fetching...');
  try {
    const r = await safeFetch('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=5&maxlatitude=38&minlongitude=65&maxlongitude=100&minmagnitude=2.5&limit=20&orderby=time');
    const d = await r.json();
    const quakes = (d.features || []).map(f => ({
      id: f.id, magnitude: f.properties.mag, place: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      timeAgo: timeAgo(new Date(f.properties.time).toISOString()),
      depth: f.geometry.coordinates[2],
      lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      tsunami: f.properties.tsunami, alert: f.properties.alert,
    }));
    cache.set('earthquakes', quakes);
    console.log(`[QUAKE] ${quakes.length} events cached`);
    return quakes;
  } catch (e) {
    console.error(`[QUAKE] ${e.message}`);
    return cache.get('earthquakes') || [];
  }
}

// ══════════════════════════════════════
// 4. WEATHER — Open-Meteo (free)
// ══════════════════════════════════════
const CITIES = [
  { n: 'Delhi', la: 28.61, lo: 77.21 }, { n: 'Mumbai', la: 19.07, lo: 72.88 },
  { n: 'Kolkata', la: 22.57, lo: 88.36 }, { n: 'Chennai', la: 13.08, lo: 80.27 },
  { n: 'Bengaluru', la: 12.97, lo: 77.59 }, { n: 'Hyderabad', la: 17.38, lo: 78.49 },
  { n: 'Jaipur', la: 26.91, lo: 75.79 }, { n: 'Lucknow', la: 26.85, lo: 80.95 },
];

function wxText(code) {
  if (code === 0) return 'Clear'; if (code <= 3) return 'Partly Cloudy';
  if (code <= 49) return 'Foggy'; if (code <= 59) return 'Drizzle';
  if (code <= 69) return 'Rain'; if (code <= 79) return 'Snow';
  if (code <= 84) return 'Showers'; if (code <= 99) return 'Thunderstorm';
  return 'Unknown';
}

async function fetchWeather() {
  console.log('[WX] Fetching...');
  const results = [];
  
  // Open-Meteo allows ~10 req/min on free tier. Fetch one city at a time with delay.
  for (const c of CITIES) {
    try {
      const r = await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.la}&longitude=${c.lo}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&timezone=Asia/Kolkata`, {
        headers: { 'User-Agent': 'IndiaMonitor/2.0 (https://indiamonitor.app)' },
        timeout: 12000
      });
      const d = await r.json(); const cur = d.current || {};
      if (cur.temperature_2m !== undefined) {
        results.push({
          city: c.n, lat: c.la, lng: c.lo,
          temperature: cur.temperature_2m, windSpeed: cur.wind_speed_10m,
          humidity: cur.relative_humidity_2m, condition: wxText(cur.weather_code),
          updatedAt: new Date().toISOString(),
        });
      }
      // 2 second delay between requests to respect Open-Meteo free tier rate limit
      await new Promise(ok => setTimeout(ok, 2000));
    } catch (e) { console.error(`[WX] ${c.n}: ${e.message}`); }
  }

  if (results.length > 0) {
    cache.set('weather', results);
  } else {
    console.error('[WX] All failed — keeping stale cache');
  }
  console.log(`[WX] ${results.length} cities cached`);
  return cache.get('weather') || [];
}

// ══════════════════════════════════════
// 5. AIR QUALITY — Open-Meteo (free)
// ══════════════════════════════════════
function aqiLvl(v) {
  if (!v) return 'Unknown'; if (v <= 50) return 'Good'; if (v <= 100) return 'Moderate';
  if (v <= 150) return 'Unhealthy (Sensitive)'; if (v <= 200) return 'Unhealthy';
  if (v <= 300) return 'Very Unhealthy'; return 'Hazardous';
}

async function fetchAQI() {
  console.log('[AQI] Fetching...');
  const results = [];
  for (const c of CITIES.slice(0, 5)) {
    try {
      const r = await safeFetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.la}&longitude=${c.lo}&current=pm2_5,pm10,us_aqi`, { timeout: 10000 });
      const d = await r.json(); const cur = d.current || {};
      results.push({
        city: c.n, lat: c.la, lng: c.lo,
        aqi: cur.us_aqi, pm25: cur.pm2_5, pm10: cur.pm10,
        level: aqiLvl(cur.us_aqi), updatedAt: new Date().toISOString(),
      });
      await new Promise(ok => setTimeout(ok, 1500));
    } catch (e) { console.error(`[AQI] ${c.n}: ${e.message}`); }
  }
  cache.set('airquality', results);
  console.log(`[AQI] ${results.length} cities cached`);
  return results;
}

// ══════════════════════════════════════
// 6. CRICKET — ESPN Cricinfo API (free, no key)
// ══════════════════════════════════════
async function fetchCricket() {
  console.log('[CRICKET] Fetching...');
  const results = { live: [], upcoming: [], recent: [] };

  // ESPN Cricinfo live/recent scores
  try {
    const r = await safeFetch('https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=cricket&lang=en&region=in&limit=30', {
      headers: { 'User-Agent': 'IndiaMonitor/1.0' }, timeout: 10000
    });
    const d = await r.json();
    const events = d?.sports?.[0]?.leagues || [];
    events.forEach(league => {
      (league.events || []).forEach(ev => {
        const match = {
          id: ev.id,
          name: ev.name || '',
          shortName: ev.shortName || '',
          league: league.name || '',
          leagueAbbr: league.abbreviation || '',
          status: ev.fullStatus?.type?.description || ev.status || '',
          state: ev.fullStatus?.type?.state || '',
          detail: ev.fullStatus?.type?.detail || '',
          date: ev.date,
          teams: (ev.competitors || []).map(c => ({
            name: c.displayName || c.name || '',
            abbr: c.abbreviation || '',
            score: c.score || '',
            logo: c.logo || '',
            winner: c.winner || false,
          })),
          note: ev.note || '',
          link: ev.link || '',
          updatedAt: new Date().toISOString(),
        };
        if (match.state === 'in') results.live.push(match);
        else if (match.state === 'post') results.recent.push(match);
        else results.upcoming.push(match);
      });
    });
  } catch (e) {
    console.error(`[CRICKET] ESPN: ${e.message}`);
  }

  // Fallback: CricketData.org for live matches (free tier)
  const CRICKET_KEY = process.env.CRICKET_API_KEY || '';
  if (results.live.length === 0 && CRICKET_KEY) {
    try {
      const r = await safeFetch(`https://api.cricketdata.org/currentMatches/v1?apikey=${CRICKET_KEY}&offset=0`, { timeout: 10000 });
      const d = await r.json();
      (d.data || []).forEach(m => {
        if (!m.name) return;
        results.live.push({
          id: m.id, name: m.name, shortName: m.name,
          league: m.series_id || '', leagueAbbr: '',
          status: m.status || '', state: m.matchStarted ? 'in' : 'pre',
          detail: m.status || '', date: m.dateTimeGMT,
          teams: [
            { name: m.teamInfo?.[0]?.name || m.teams?.[0] || '', abbr: m.teamInfo?.[0]?.shortname || '', score: m.score?.[0]?.r ? `${m.score[0].r}/${m.score[0].w} (${m.score[0].o})` : '', logo: m.teamInfo?.[0]?.img || '' },
            { name: m.teamInfo?.[1]?.name || m.teams?.[1] || '', abbr: m.teamInfo?.[1]?.shortname || '', score: m.score?.[1]?.r ? `${m.score[1].r}/${m.score[1].w} (${m.score[1].o})` : '', logo: m.teamInfo?.[1]?.img || '' },
          ],
          updatedAt: new Date().toISOString(),
        });
      });
    } catch (e) { console.error(`[CRICKET] CricketData: ${e.message}`); }
  }

  // Sports news RSS for cricket
  try {
    const RSSParser = require('rss-parser');
    const parser = new RSSParser({ timeout: 6000, headers: { 'User-Agent': 'IndiaMonitor/1.0' } });
    const feed = await parser.parseURL('https://www.espncricinfo.com/rss/content/story/feeds/0.xml');
    results.news = (feed.items || []).slice(0, 8).map(i => ({
      title: (i.title || '').trim(), link: i.link || '',
      pubDate: i.pubDate || '', source: 'ESPNcricinfo',
    }));
  } catch (e) { results.news = []; }

  cache.set('cricket', results);
  console.log(`[CRICKET] Live:${results.live.length} Upcoming:${results.upcoming.length} Recent:${results.recent.length}`);
  return results;
}

// ══════════════════════════════════════
// 7. FOOTBALL — TheSportsDB (free, no key for basic)
//    + ESPN for ISL/Indian football
// ══════════════════════════════════════
async function fetchFootball() {
  console.log('[FOOTBALL] Fetching...');
  const results = { live: [], upcoming: [], recent: [], leagues: [] };

  // ESPN for Indian football + major leagues
  const espnLeagues = [
    { slug: 'ind.1', name: 'Indian Super League' },
    { slug: 'eng.1', name: 'Premier League' },
    { slug: 'uefa.champions', name: 'UEFA Champions League' },
    { slug: 'fifa.world', name: 'FIFA World Cup' },
    { slug: 'esp.1', name: 'La Liga' },
  ];

  for (const league of espnLeagues) {
    try {
      const r = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.slug}/scoreboard`, {
        headers: { 'User-Agent': 'IndiaMonitor/1.0' }, timeout: 8000
      });
      const d = await r.json();
      (d.events || []).forEach(ev => {
        const comp = ev.competitions?.[0];
        if (!comp) return;
        const match = {
          id: ev.id,
          name: ev.name || '',
          shortName: ev.shortName || '',
          league: league.name,
          leagueSlug: league.slug,
          status: comp.status?.type?.description || '',
          state: comp.status?.type?.state || '',
          detail: comp.status?.type?.detail || '',
          date: ev.date,
          venue: comp.venue?.fullName || '',
          teams: (comp.competitors || []).map(c => ({
            name: c.team?.displayName || '',
            abbr: c.team?.abbreviation || '',
            score: c.score || '0',
            logo: c.team?.logo || '',
            winner: c.winner || false,
            homeAway: c.homeAway || '',
          })),
          updatedAt: new Date().toISOString(),
        };
        if (match.state === 'in') results.live.push(match);
        else if (match.state === 'post') results.recent.push(match);
        else results.upcoming.push(match);
      });
    } catch (e) { /* skip league */ }
  }

  // Sort by date
  results.upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
  results.recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  results.upcoming = results.upcoming.slice(0, 15);
  results.recent = results.recent.slice(0, 15);

  cache.set('football', results);
  console.log(`[FOOTBALL] Live:${results.live.length} Upcoming:${results.upcoming.length} Recent:${results.recent.length}`);
  return results;
}

// ══════════════════════════════════════
// 8. BASEBALL — ESPN MLB API
// ══════════════════════════════════════
async function fetchBaseball() {
  console.log('[BASEBALL] Fetching...');
  const results = { live: [], upcoming: [], recent: [] };

  try {
    const r = await safeFetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', {
      headers: { 'User-Agent': 'IndiaMonitor/2.0' }, timeout: 10000
    });
    const d = await r.json();
    (d.events || []).forEach(ev => {
      const comp = ev.competitions?.[0];
      if (!comp) return;
      const match = {
        id: ev.id,
        name: ev.name || '',
        shortName: ev.shortName || '',
        league: 'MLB',
        leagueSlug: 'mlb',
        status: comp.status?.type?.description || '',
        state: comp.status?.type?.state || '',
        detail: comp.status?.type?.detail || '',
        date: ev.date,
        venue: comp.venue?.fullName || '',
        teams: (comp.competitors || []).map(c => ({
          name: c.team?.displayName || '',
          abbr: c.team?.abbreviation || '',
          score: c.score || '0',
          logo: c.team?.logo || '',
          winner: c.winner || false,
          homeAway: c.homeAway || '',
        })),
        updatedAt: new Date().toISOString(),
      };
      if (match.state === 'in') results.live.push(match);
      else if (match.state === 'post') results.recent.push(match);
      else results.upcoming.push(match);
    });
  } catch (e) { console.error(`[BASEBALL] ESPN: ${e.message}`); }

  results.upcoming.sort((a, b) => new Date(a.date) - new Date(b.date));
  results.recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  results.upcoming = results.upcoming.slice(0, 15);
  results.recent = results.recent.slice(0, 15);

  cache.set('baseball', results);
  console.log(`[BASEBALL] Live:${results.live.length} Upcoming:${results.upcoming.length} Recent:${results.recent.length}`);
  return results;
}

// ══════════════════════════════════════
// 9. BADMINTON — BWA/BWF Tournament RSS + ESPN
// ══════════════════════════════════════
async function fetchBadminton() {
  console.log('[BADMINTON] Fetching...');
  const results = { live: [], upcoming: [], recent: [], news: [] };

  // ESPN doesn't have dedicated badminton scoreboard, so we use news feeds
  // BWF tournament results via RSS
  const RSSParser = require('rss-parser');
  const parser = new RSSParser({ timeout: 10000, headers: { 'User-Agent': 'IndiaMonitor/2.0' } });

  const feeds = [
    { name: 'BWF', url: 'https://bwfbadminton.com/feed/' },
    { name: 'BadmintonPlanet', url: 'https://www.badmintonplanet.com/feed/' },
    { name: 'Sportskeeda Badminton', url: 'https://www.sportskeeda.com/feed/badminton' },
  ];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      (parsed.items || []).slice(0, 6).forEach(item => {
        const title = (item.title || '').trim();
        const isResult = /won|beat|defeated|loses|lost|final|semifinal|quarter/i.test(title);
        const isUpcoming = /draw|preview|schedule|vs|face|clash/i.test(title);
        const isLive = /live|underway|ongoing/i.test(title);

        const entry = {
          id: item.guid || item.link || '',
          name: title,
          shortName: title.substring(0, 60),
          league: 'Badminton',
          leagueSlug: 'badminton',
          status: isLive ? 'Live' : isResult ? 'Result' : isUpcoming ? 'Upcoming' : 'News',
          state: isLive ? 'in' : isResult ? 'post' : 'pre',
          detail: (item.contentSnippet || '').slice(0, 120),
          date: item.pubDate || item.isoDate || '',
          link: item.link || '',
          source: feed.name,
          teams: [],
          updatedAt: new Date().toISOString(),
        };

        if (isLive) results.live.push(entry);
        else if (isResult) results.recent.push(entry);
        else if (isUpcoming) results.upcoming.push(entry);
        else results.news.push(entry);
      });
    } catch (e) { console.error(`[BADMINTON] ${feed.name}: ${e.message}`); }
  }

  results.recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  results.upcoming = results.upcoming.slice(0, 10);
  results.recent = results.recent.slice(0, 10);

  cache.set('badminton', results);
  console.log(`[BADMINTON] Live:${results.live.length} Upcoming:${results.upcoming.length} Recent:${results.recent.length} News:${results.news.length}`);
  return results;
}

// ══════════════════════════════════════
// 10. ALL SPORTS COMBINED
// ══════════════════════════════════════
async function fetchAllSports() {
  console.log('[SPORTS] Fetching all...');
  await Promise.allSettled([fetchCricket(), fetchFootball(), fetchBaseball(), fetchBadminton()]);
  const combined = {
    cricket: cache.get('cricket') || { live: [], upcoming: [], recent: [] },
    football: cache.get('football') || { live: [], upcoming: [], recent: [] },
    baseball: cache.get('baseball') || { live: [], upcoming: [], recent: [] },
    badminton: cache.get('badminton') || { live: [], upcoming: [], recent: [] },
    updatedAt: new Date().toISOString(),
  };
  cache.set('sports', combined);
  return combined;
}

// ══════════════════════════════════════
// 9. REGIONAL NEWS — Hindi / Marathi / Bangla (Phase 2)
// ══════════════════════════════════════
const REGIONAL_FEEDS = {
  hindi: [
    { name: 'दैनिक भास्कर', url: 'https://www.bhaskar.com/rss-feed/1061' },
    { name: 'अमर उजाला', url: 'https://www.amarujala.com/rss/breaking-news.xml' },
    { name: 'BBC हिन्दी', url: 'https://feeds.bbci.co.uk/hindi/rss.xml' },
    { name: 'NDTV हिन्दी', url: 'https://hindi.ndtv.com/feeds' },
    { name: 'Aaj Tak', url: 'https://aajtak.intoday.in/rss/default.xml' },
    { name: 'Patrika', url: 'https://api.patrika.com/rss/top-news' },
  ],
  marathi: [
    { name: 'TV9 मराठी', url: 'https://www.tv9marathi.com/feed' },
    { name: 'Pudhari', url: 'https://www.pudhari.news/feed/' },
    { name: 'Saam TV', url: 'https://www.saamtv.com/feed/' },
    { name: 'India.com Marathi', url: 'https://www.india.com/marathi/feed/' },
    { name: 'News18 Lokmat', url: 'https://lokmat.news18.com/rss/khabar.xml' },
  ],
  bangla: [
    { name: 'Sangbad Pratidin', url: 'https://www.sangbadpratidin.in/feed/' },
    { name: 'TV9 Bangla', url: 'https://tv9bangla.com/feed' },
    { name: 'India.com Bangla', url: 'https://www.india.com/bangla/feed/' },
    { name: 'Dainik Statesman', url: 'https://www.dailystatesman.com/feed/' },
    { name: 'Bangla News 24', url: 'https://banglanews24.com/rss/rss.xml' },
  ],
  tamil: [
    { name: 'BBC Tamil', url: 'https://feeds.bbci.co.uk/tamil/rss.xml' },
    { name: 'TV9 Tamil', url: 'https://www.tv9tamil.com/feed' },
    { name: 'India.com Tamil', url: 'https://www.india.com/tamil/feed/' },
    { name: 'Puthiya Thalaimurai', url: 'https://www.puthiyathalaimurai.com/feed' },
  ],
  gujarati: [
    { name: 'BBC Gujarati', url: 'https://feeds.bbci.co.uk/gujarati/rss.xml' },
    { name: 'TV9 Gujarati', url: 'https://www.tv9gujarati.com/feed' },
    { name: 'India.com Gujarati', url: 'https://www.india.com/gujarati/feed/' },
  ],
  punjabi: [
    { name: 'BBC Punjabi', url: 'https://feeds.bbci.co.uk/punjabi/rss.xml' },
    { name: 'Ajit Jalandhar', url: 'https://www.ajitjalandhar.com/feed/' },
    { name: 'Rozana Spokesman', url: 'https://www.rozanaspokesman.com/feed/' },
  ],
  urdu: [
    { name: 'BBC Urdu', url: 'https://feeds.bbci.co.uk/urdu/rss.xml' },
    { name: 'Siasat Urdu', url: 'https://www.siasat.com/feed/' },
    { name: 'Inquilab', url: 'https://www.inquilab.com/feed/' },
  ],
  nepali: [
    { name: 'BBC Nepali', url: 'https://feeds.bbci.co.uk/nepali/rss.xml' },
    { name: 'Setopati', url: 'https://www.setopati.com/feed' },
    { name: 'Online Khabar', url: 'https://www.onlinekhabar.com/feed' },
  ],
};

function regionalSeverity(title) {
  const t = title.toLowerCase();
  // Hindi/Marathi/Bangla + English critical keywords
  if (['हमला','আক্রমণ','हल्ला','attack','terror','killed','blast','bomb','मौत','মৃত্যু','মৃত','विस्फोट','বিস্ফোরণ','war','युद्ध','যুদ্ধ'].some(k => t.includes(k))) return 'critical';
  if (['गिरफ্তার','গ্রেপ্তার','अटक','earthquake','भूकंप','ভূমিকম্প','flood','बाढ','বন্যা','riot','दंगा','দাঙ্গা','clash','tension','crisis','সংকট','संकट'].some(k => t.includes(k))) return 'high';
  if (['election','चुनाव','নির্বাচন','निवडणूक','budget','बजट','বাজেট','अर्थसंकल্प','court','अदालत','আদালত','न्यायालय','parliament','संसद','সংসদ'].some(k => t.includes(k))) return 'medium';
  return 'low';
}

async function fetchRegionalNews(lang) {
  const feeds = REGIONAL_FEEDS[lang];
  if (!feeds) return [];
  console.log(`[NEWS-${lang.toUpperCase()}] Fetching...`);
  
  const RSSParser = require('rss-parser');
  const parser = new RSSParser({ timeout: 10000, headers: { 'User-Agent': 'IndiaMonitor/1.0' } });
  
  let items = [];
  const results = await Promise.allSettled(feeds.map(async feed => {
    try {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items || []).slice(0, 8).map(i => ({
        source: feed.name,
        title: (i.title || '').trim(),
        link: i.link || '',
        pubDate: i.pubDate || i.isoDate || new Date().toISOString(),
        excerpt: (i.contentSnippet || i.content || '').replace(/<[^>]*>/g, '').trim().slice(0, 200),
      }));
    } catch (e) {
      console.error(`[NEWS-${lang.toUpperCase()}] ${feed.name}: ${e.message}`);
      return [];
    }
  }));
  
  results.forEach(r => { if (r.status === 'fulfilled') items.push(...r.value); });
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  
  // Deduplicate
  const seen = new Set();
  const deduped = items.filter(i => {
    const k = i.title.toLowerCase().slice(0, 50);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).map(i => ({ ...i, severity: regionalSeverity(i.title), timeAgo: timeAgo(i.pubDate) }));
  
  const result = deduped.slice(0, 30);
  cache.set(`news_${lang}`, result);
  console.log(`[NEWS-${lang.toUpperCase()}] ${result.length} items cached`);
  return result;
}

// ══════════════════════════════════════
// 10. CYBER SECURITY — NVD + Service Health (Phase 2)
// ══════════════════════════════════════
async function fetchCyber() {
  console.log('[CYBER] Fetching...');
  const data = { advisories: [], services: [], lastUpdated: new Date().toISOString() };
  
  // NVD recent CVEs
  try {
    const r = await safeFetch('https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=8', {
      headers: { 'User-Agent': 'IndiaMonitor/1.0' }, timeout: 15000
    });
    const d = await r.json();
    data.advisories = (d.vulnerabilities || []).map(v => {
      const cve = v.cve || {};
      const desc = (cve.descriptions || []).find(d => d.lang === 'en');
      let cvss = 0;
      for (const key of ['cvssMetricV31','cvssMetricV30','cvssMetricV2']) {
        if (cve.metrics?.[key]?.[0]) { cvss = cve.metrics[key][0].cvssData?.baseScore || 0; break; }
      }
      const sev = cvss >= 9 ? 'critical' : cvss >= 7 ? 'high' : cvss >= 4 ? 'medium' : 'low';
      return {
        title: `${cve.id || 'CVE'} — CVSS ${cvss}`,
        link: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
        description: (desc?.value || '').slice(0, 200),
        date: cve.published || '',
        severity: sev,
        source: 'NVD',
        type: 'cve',
        cvss,
      };
    });
  } catch (e) { console.error(`[CYBER] NVD: ${e.message}`); }
  
  // Digital service health checks
  const checks = [
    { name: 'UPI / NPCI', url: 'https://www.npci.org.in', icon: '💳' },
    { name: 'IRCTC', url: 'https://www.irctc.co.in', icon: '🚂' },
    { name: 'DigiLocker', url: 'https://www.digilocker.gov.in', icon: '📄' },
    { name: 'Aadhaar / UIDAI', url: 'https://uidai.gov.in', icon: '🆔' },
    { name: 'Income Tax', url: 'https://www.incometax.gov.in', icon: '🏛️' },
    { name: 'NIC / gov.in', url: 'https://www.india.gov.in', icon: '🌐' },
  ];
  
  for (const chk of checks) {
    try {
      const start = Date.now();
      const r = await safeFetch(chk.url, { timeout: 8000 });
      const latency = Date.now() - start;
      data.services.push({ name: chk.name, icon: chk.icon, status: r.ok ? 'operational' : 'degraded', latency, statusCode: r.ok ? 200 : 0 });
    } catch (e) {
      const isTimeout = e.name === 'AbortError';
      data.services.push({ name: chk.name, icon: chk.icon, status: isTimeout ? 'slow' : 'down', latency: isTimeout ? 8000 : 0, statusCode: 0 });
    }
  }
  
  cache.set('cyber', data);
  console.log(`[CYBER] ${data.advisories.length} advisories, ${data.services.length} services`);
  return data;
}

// ══════════════════════════════════════
// 11. DEFENCE — RSS Aggregator (Phase 2)
// ══════════════════════════════════════
const DEFENCE_FEEDS = [
  { name: 'LiveFist', url: 'https://www.livefistdefence.com/feed/' },
  { name: 'DefenseNews', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/category/global/asia-pacific/?outputType=xml' },
  { name: 'PIB/MoD', url: 'https://pib.gov.in/RssMain.aspx?ModId=3&Lang=1&Regid=3' },
  { name: 'Indian Defence', url: 'https://www.indiandefensenews.in/feeds/posts/default?alt=rss' },
];

const DEF_KW = {
  iaf: ['rafale','tejas','sukhoi','su-30','mig','iaf','air force','c-130','chinook','apache'],
  navy: ['ins ','vikrant','navy','naval','submarine','frigate','destroyer','carrier'],
  army: ['army','regiment','brigade','loc','bsf','border','artillery','tank','infantry'],
  missile: ['brahmos','agni','prithvi','akash','missile','drdo','s-400','barak'],
  exercise: ['exercise','drill','joint','bilateral','malabar','tarang','garuda'],
  procurement: ['procurement','contract','deal','acquisition','induction','delivery'],
  space: ['isro','satellite','asat','space','gslv','pslv','chandrayaan'],
};

function defCategory(text) {
  const t = text.toLowerCase();
  for (const [cat, kws] of Object.entries(DEF_KW)) { if (kws.some(k => t.includes(k))) return cat; }
  return 'general';
}

function defSeverity(text) {
  const t = text.toLowerCase();
  if (['war','attack','strike','killed','ceasefire violation','infiltration','nuclear'].some(k => t.includes(k))) return 'critical';
  if (['tension','standoff','deployment','test fire','launch','border clash'].some(k => t.includes(k))) return 'high';
  if (['exercise','drill','procurement','induction','delivery','meeting'].some(k => t.includes(k))) return 'medium';
  return 'low';
}

async function fetchDefence() {
  console.log('[DEFENCE] Fetching...');
  const RSSParser = require('rss-parser');
  const parser = new RSSParser({ timeout: 12000, headers: { 'User-Agent': 'IndiaMonitor/1.0' } });
  
  let articles = [];
  const results = await Promise.allSettled(DEFENCE_FEEDS.map(async feed => {
    try {
      const parsed = await parser.parseURL(feed.url);
      return (parsed.items || []).slice(0, 10).map(i => {
        const title = (i.title || '').trim();
        const desc = (i.contentSnippet || i.content || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
        return {
          title, link: i.link || '', description: desc,
          source: feed.name, date: i.pubDate || i.isoDate || '',
          category: defCategory(title + ' ' + desc),
          severity: defSeverity(title + ' ' + desc),
          timeAgo: timeAgo(i.pubDate || i.isoDate || new Date().toISOString()),
        };
      });
    } catch (e) { console.error(`[DEFENCE] ${feed.name}: ${e.message}`); return []; }
  }));
  
  results.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });
  
  // Deduplicate
  const seen = new Set();
  articles = articles.filter(a => { const k = a.title.toLowerCase().slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; });
  articles.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  // Build readiness
  const cats = {};
  articles.forEach(a => {
    if (!cats[a.category]) cats[a.category] = { count: 0, critical: 0, high: 0 };
    cats[a.category].count++;
    if (a.severity === 'critical') cats[a.category].critical++;
    if (a.severity === 'high') cats[a.category].high++;
  });
  
  const readiness = [
    { name: 'IAF', icon: '🛩️', key: 'iaf' },
    { name: 'Navy', icon: '🚢', key: 'navy' },
    { name: 'Army', icon: '⚔️', key: 'army' },
    { name: 'Missiles/DRDO', icon: '🎯', key: 'missile' },
    { name: 'Exercises', icon: '🎖️', key: 'exercise' },
    { name: 'Procurement', icon: '📋', key: 'procurement' },
    { name: 'Space/ISRO', icon: '🛰️', key: 'space' },
  ].map(item => {
    const c = cats[item.key] || { count: 0, critical: 0, high: 0 };
    return { ...item, articles: c.count, activity: c.count >= 3 ? 'high' : c.count >= 1 ? 'moderate' : 'low', alert: c.critical > 0 || c.high > 0 };
  });
  
  const data = { articles: articles.slice(0, 15), readiness, lastUpdated: new Date().toISOString() };
  cache.set('defence', data);
  console.log(`[DEFENCE] ${articles.length} articles cached`);
  return data;
}

// ══════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════
app.get('/api/health', (req, res) => res.json({
  status: 'ok', uptime: process.uptime(), cache: cache.getStats(),
  timestamp: new Date().toISOString(), version: '1.0.0',
}));

app.get('/api/news', async (req, res) => {
  try {
    let d = cache.get('news'); if (!d) d = await fetchAllNews();
    if (req.query.category) d = d.filter(n => n.category === req.query.category);
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/markets', async (req, res) => {
  try {
    let d = cache.get('markets'); if (!d) d = await fetchMarkets();
    if (req.query.type) d = d.filter(m => m.type === req.query.type);
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/commodities', async (req, res) => {
  try {
    let d = cache.get('commodities'); if (!d) d = await fetchCommodities();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// YouTube Live Stream Video ID resolver
app.get('/api/youtube-live', async (req, res) => {
  const channelId = req.query.channel;
  if (!channelId) return res.json({ videoId: null });
  
  const cacheKey = `yt_live_${channelId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  
  try {
    const r = await safeFetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000
    });
    const html = await r.text();
    
    // Extract video ID from the canonical URL or player config
    let videoId = null;
    const canonicalMatch = html.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
    if (canonicalMatch) videoId = canonicalMatch[1];
    
    if (!videoId) {
      const altMatch = html.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (altMatch) videoId = altMatch[1];
    }
    
    // Check if it's actually a live stream
    const isLive = html.includes('"isLive":true') || html.includes('"isLiveNow":true') || html.includes('LIVE NOW');
    
    const result = { videoId: isLive ? videoId : videoId, isLive, channelId };
    cache.set(cacheKey, result, 300); // cache for 5 min
    res.json(result);
  } catch (e) {
    console.error(`[YT-LIVE] ${channelId}: ${e.message}`);
    res.json({ videoId: null, error: e.message });
  }
});

app.get('/api/earthquakes', async (req, res) => {
  try {
    let d = cache.get('earthquakes'); if (!d) d = await fetchQuakes();
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/weather', async (req, res) => {
  try {
    let d = cache.get('weather'); if (!d) d = await fetchWeather();
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/airquality', async (req, res) => {
  try {
    let d = cache.get('airquality'); if (!d) d = await fetchAQI();
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/sports', async (req, res) => {
  try {
    let d = cache.get('sports'); if (!d) d = await fetchAllSports();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/cricket', async (req, res) => {
  try {
    let d = cache.get('cricket'); if (!d) d = await fetchCricket();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/football', async (req, res) => {
  try {
    let d = cache.get('football'); if (!d) d = await fetchFootball();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/baseball', async (req, res) => {
  try {
    let d = cache.get('baseball'); if (!d) d = await fetchBaseball();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/badminton', async (req, res) => {
  try {
    let d = cache.get('badminton'); if (!d) d = await fetchBadminton();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/all', async (req, res) => {
  res.json({
    success: true, timestamp: new Date().toISOString(),
    news: cache.get('news') || [], markets: cache.get('markets') || [],
    earthquakes: cache.get('earthquakes') || [], weather: cache.get('weather') || [],
    airquality: cache.get('airquality') || [],
    sports: cache.get('sports') || { cricket: {}, football: {} },
  });
});

// Phase 2 routes
// Regional news — dynamic route for all languages
const SUPPORTED_LANGS = Object.keys(REGIONAL_FEEDS);
app.get('/api/news/:lang', async (req, res) => {
  const lang = req.params.lang;
  if (!SUPPORTED_LANGS.includes(lang)) return res.status(404).json({ success: false, error: `Language '${lang}' not supported. Available: ${SUPPORTED_LANGS.join(', ')}` });
  try {
    let d = cache.get(`news_${lang}`); if (!d) d = await fetchRegionalNews(lang);
    res.json({ success: true, count: d.length, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/cyber', async (req, res) => {
  try {
    let d = cache.get('cyber'); if (!d) d = await fetchCyber();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/defence', async (req, res) => {
  try {
    let d = cache.get('defence'); if (!d) d = await fetchDefence();
    res.json({ success: true, data: d });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Root route
app.get('/', (req, res) => {
  res.json({ name: 'India Monitor API', version: '2.0.0', status: 'running', endpoints: ['/api/health','/api/news','/api/news/hindi','/api/news/marathi','/api/news/bangla','/api/markets','/api/earthquakes','/api/weather','/api/airquality','/api/cricket','/api/football','/api/sports','/api/cyber','/api/defence','/api/all'] });
});

// ══════════════════════════════════════
// CRON SCHEDULES
// ══════════════════════════════════════
cron.schedule('*/5 * * * *', () => fetchAllNews().catch(console.error));
cron.schedule('*/3 9-15 * * 1-5', () => fetchMarkets().catch(console.error));
cron.schedule('*/15 0-8,16-23 * * *', () => fetchMarkets().catch(console.error));
cron.schedule('*/30 * * * *', () => fetchCommodities().catch(console.error)); // Commodities: every 30 min
cron.schedule('*/10 * * * *', () => fetchQuakes().catch(console.error));
cron.schedule('5,35 * * * *', () => fetchWeather().catch(console.error));  // Weather: at :05 and :35
cron.schedule('20,50 * * * *', () => fetchAQI().catch(console.error));    // AQI: at :20 and :50 (offset from weather)
cron.schedule('*/2 * * * *', () => fetchAllSports().catch(console.error)); // Sports: every 2 min (live scores need frequent updates)
cron.schedule('*/5 * * * *', () => Promise.allSettled(Object.keys(REGIONAL_FEEDS).map(l => fetchRegionalNews(l))).catch(console.error)); // Regional news: 5 min
cron.schedule('*/15 * * * *', () => fetchCyber().catch(console.error));    // Cyber: 15 min
cron.schedule('*/10 * * * *', () => fetchDefence().catch(console.error));   // Defence: 10 min

// ══════════════════════════════════════
// BOOT
// ══════════════════════════════════════
async function boot() {
  console.log('🇮🇳 INDIA MONITOR v2.0 — Starting...');
  // Phase 1: Fast fetchers (no rate limit issues)
  await Promise.allSettled([fetchAllNews(), fetchQuakes(), fetchAllSports(), ...Object.keys(REGIONAL_FEEDS).map(l => fetchRegionalNews(l)), fetchDefence()]);
  console.log('✅ Phase 1 loaded (news, quakes, sports, regional, defence)');
  // Phase 2: Rate-limited APIs (weather, AQI, markets, cyber) — stagger
  await Promise.allSettled([fetchMarkets(), fetchCyber(), fetchCommodities()]);
  console.log('✅ Phase 2 loaded (markets, cyber)');
  // Phase 3: Weather + AQI last (Open-Meteo rate limits — need gaps)
  await fetchWeather();
  console.log('[BOOT] Waiting 5s before AQI to avoid Open-Meteo rate limit...');
  await new Promise(ok => setTimeout(ok, 5000));
  await fetchAQI();
  console.log('✅ Phase 3 loaded (weather, AQI)');
  app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`   /api/health | /api/news | /api/news/hindi | /api/news/marathi | /api/news/bangla | /api/markets | /api/earthquakes | /api/weather | /api/airquality | /api/cricket | /api/football | /api/cyber | /api/defence | /api/all`);
  });
}
boot();
