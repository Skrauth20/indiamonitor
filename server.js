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
// 2. MARKETS — Yahoo Finance (free)
// ══════════════════════════════════════
async function fetchMarkets() {
  console.log('[MKT] Fetching...');
  const syms = [
    { s: '^NSEI', n: 'NIFTY 50', t: 'index' },
    { s: '^BSESN', n: 'SENSEX', t: 'index' },
    { s: '^NSEBANK', n: 'BANK NIFTY', t: 'index' },
    { s: 'USDINR=X', n: 'USD/INR', t: 'forex' },
    { s: 'EURINR=X', n: 'EUR/INR', t: 'forex' },
    { s: 'GC=F', n: 'GOLD', t: 'commodity' },
    { s: 'CL=F', n: 'CRUDE OIL', t: 'commodity' },
    { s: 'SI=F', n: 'SILVER', t: 'commodity' },
    { s: 'BTC-INR', n: 'BTC/INR', t: 'crypto' },
    { s: 'ETH-INR', n: 'ETH/INR', t: 'crypto' },
    { s: '^INDIAVIX', n: 'INDIA VIX', t: 'index' },
  ];
  try {
    const str = syms.map(s => s.s).join(',');
    const r = await safeFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(str)}`, {
      headers: { 'User-Agent': 'IndiaMonitor/1.0' }, timeout: 10000
    });
    const d = await r.json();
    const quotes = (d?.quoteResponse?.result || []).map(q => {
      const sym = syms.find(s => s.s === q.symbol);
      if (!sym) return null;
      return {
        name: sym.n, symbol: q.symbol, type: sym.t,
        price: q.regularMarketPrice || 0,
        change: q.regularMarketChange || 0,
        changePct: q.regularMarketChangePercent || 0,
        high: q.regularMarketDayHigh || 0,
        low: q.regularMarketDayLow || 0,
        prevClose: q.regularMarketPreviousClose || 0,
        marketState: q.marketState || 'UNKNOWN',
        currency: q.currency || 'INR',
        updatedAt: new Date().toISOString(),
      };
    }).filter(Boolean);
    cache.set('markets', quotes);
    console.log(`[MKT] ${quotes.length} symbols cached`);
    return quotes;
  } catch (e) {
    console.error(`[MKT] ${e.message}`);
    return cache.get('markets') || [];
  }
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
  for (const c of CITIES) {
    try {
      const r = await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.la}&longitude=${c.lo}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&timezone=Asia/Kolkata`, { timeout: 6000 });
      const d = await r.json(); const cur = d.current || {};
      results.push({
        city: c.n, lat: c.la, lng: c.lo,
        temperature: cur.temperature_2m, windSpeed: cur.wind_speed_10m,
        humidity: cur.relative_humidity_2m, condition: wxText(cur.weather_code),
        updatedAt: new Date().toISOString(),
      });
    } catch (e) { /* skip */ }
  }
  cache.set('weather', results);
  console.log(`[WX] ${results.length} cities cached`);
  return results;
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
      const r = await safeFetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.la}&longitude=${c.lo}&current=pm2_5,pm10,us_aqi`, { timeout: 6000 });
      const d = await r.json(); const cur = d.current || {};
      results.push({
        city: c.n, lat: c.la, lng: c.lo,
        aqi: cur.us_aqi, pm25: cur.pm2_5, pm10: cur.pm10,
        level: aqiLvl(cur.us_aqi), updatedAt: new Date().toISOString(),
      });
    } catch (e) { /* skip */ }
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
// 8. ALL SPORTS COMBINED
// ══════════════════════════════════════
async function fetchAllSports() {
  console.log('[SPORTS] Fetching all...');
  await Promise.allSettled([fetchCricket(), fetchFootball()]);
  const combined = {
    cricket: cache.get('cricket') || { live: [], upcoming: [], recent: [] },
    football: cache.get('football') || { live: [], upcoming: [], recent: [] },
    updatedAt: new Date().toISOString(),
  };
  cache.set('sports', combined);
  return combined;
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

app.get('/api/all', async (req, res) => {
  res.json({
    success: true, timestamp: new Date().toISOString(),
    news: cache.get('news') || [], markets: cache.get('markets') || [],
    earthquakes: cache.get('earthquakes') || [], weather: cache.get('weather') || [],
    airquality: cache.get('airquality') || [],
    sports: cache.get('sports') || { cricket: {}, football: {} },
  });
});

// Root route
app.get('/', (req, res) => {
  res.json({ name: 'India Monitor API', version: '1.0.0', status: 'running', endpoints: ['/api/health','/api/news','/api/markets','/api/earthquakes','/api/weather','/api/airquality','/api/cricket','/api/football','/api/sports','/api/all'] });
});

// ══════════════════════════════════════
// CRON SCHEDULES
// ══════════════════════════════════════
cron.schedule('*/5 * * * *', () => fetchAllNews().catch(console.error));
cron.schedule('*/3 9-15 * * 1-5', () => fetchMarkets().catch(console.error));
cron.schedule('*/15 0-8,16-23 * * *', () => fetchMarkets().catch(console.error));
cron.schedule('*/10 * * * *', () => fetchQuakes().catch(console.error));
cron.schedule('*/30 * * * *', () => fetchWeather().catch(console.error));
cron.schedule('*/30 * * * *', () => fetchAQI().catch(console.error));
cron.schedule('*/2 * * * *', () => fetchAllSports().catch(console.error)); // Sports: every 2 min (live scores need frequent updates)

// ══════════════════════════════════════
// BOOT
// ══════════════════════════════════════
async function boot() {
  console.log('🇮🇳 INDIA MONITOR v1.0 — Starting...');
  await Promise.allSettled([fetchAllNews(), fetchMarkets(), fetchQuakes(), fetchWeather(), fetchAQI(), fetchAllSports()]);
  console.log('✅ Initial data loaded');
  app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log(`   /api/health | /api/news | /api/markets | /api/earthquakes | /api/weather | /api/airquality | /api/sports | /api/cricket | /api/football | /api/all`);
  });
}
boot();
