// ═══════════════════════════════════════════════════════════════
//  INDIA MONITOR v4.0 — Bloomberg Terminal Backend
//  Render.com (Node.js) — github.com/Skrauth20/indiamonitor
// ═══════════════════════════════════════════════════════════════
const express   = require('express');
const cors      = require('cors');
const cron      = require('node-cron');
const NodeCache = require('node-cache');

const app   = express();
const PORT  = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

app.use(cors({
  origin: [
    'https://indiamonitor.app','https://www.indiamonitor.app',
    'http://indiamonitor.app','http://localhost:3000',
    'http://localhost:5500','http://127.0.0.1:5500'
  ],
  methods: ['GET'],
}));
app.use(express.json());

// ── helpers ──────────────────────────────────────────────────
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
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function severity(title) {
  const t = title.toLowerCase();
  if (['killed','dead','attack','bomb','blast','terror','war','nuclear','missile',
       'strike','infiltration','encounter','ceasefire'].some(k => t.includes(k))) return 'critical';
  if (['alert','tensions','warning','emergency','cyclone','earthquake','flood',
       'clash','protest','border','military','navy','army','naxal'].some(k => t.includes(k))) return 'high';
  if (['rbi','rate','market','crash','election','court','supreme','parliament',
       'isro','policy','gdp'].some(k => t.includes(k))) return 'medium';
  return 'low';
}

// ════════════════════════════════════════════════════════════════
// 1. NEWS — 15 RSS feeds
// ════════════════════════════════════════════════════════════════
const FEEDS = [
  { name:'NDTV',            url:'https://feeds.feedburner.com/ndtvnews-top-stories',                    cat:'national' },
  { name:'The Hindu',       url:'https://www.thehindu.com/news/national/feeder/default.rss',            cat:'national' },
  { name:'Times of India',  url:'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',           cat:'national' },
  { name:'Indian Express',  url:'https://indianexpress.com/section/india/feed/',                        cat:'national' },
  { name:'Hindustan Times', url:'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml',      cat:'national' },
  { name:'LiveMint',        url:'https://www.livemint.com/rss/markets',                                 cat:'economy'  },
  { name:'Economic Times',  url:'https://economictimes.indiatimes.com/rssfeedstopstories.cms',          cat:'economy'  },
  { name:'Business Standard',url:'https://www.business-standard.com/rss/home_page_top_stories.rss',    cat:'economy'  },
  { name:'MoneyControl',    url:'https://www.moneycontrol.com/rss/latestnews.xml',                      cat:'economy'  },
  { name:'NDTV Gadgets',    url:'https://feeds.feedburner.com/gadgets360-latest',                       cat:'tech'     },
  { name:'Reuters India',   url:'https://feeds.reuters.com/reuters/INtopNews',                          cat:'world'    },
  { name:'Al Jazeera',      url:'https://www.aljazeera.com/xml/rss/all.xml',                            cat:'world'    },
  { name:'WION',            url:'https://www.wionews.com/feeds/india/rss.xml',                          cat:'national' },
];

async function fetchFeed(feed) {
  try {
    const RSSParser = require('rss-parser');
    const parser = new RSSParser({ timeout:8000, headers:{'User-Agent':'IndiaMonitor/4.0'} });
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items||[]).slice(0,8).map(i => ({
      source:feed.name, category:feed.cat,
      title:(i.title||'').trim(), link:i.link||'',
      pubDate:i.pubDate||i.isoDate||new Date().toISOString(),
      excerpt:(i.contentSnippet||i.content||'').replace(/<[^>]*>/g,'').trim().slice(0,200),
    }));
  } catch(e) { console.error(`[RSS] ${feed.name}: ${e.message}`); return []; }
}

async function fetchAllNews() {
  console.log('[NEWS] Fetching...');
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  let items = [];
  results.forEach(r => { if (r.status==='fulfilled') items.push(...r.value); });
  items.sort((a,b) => new Date(b.pubDate)-new Date(a.pubDate));
  const seen = new Set();
  const deduped = items.filter(i => {
    const k = i.title.toLowerCase().slice(0,50);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).map(i => ({...i, severity:severity(i.title), timeAgo:timeAgo(i.pubDate)}));
  cache.set('news', deduped.slice(0,60));
  console.log(`[NEWS] ${deduped.length} items`);
  return deduped.slice(0,60);
}

// ════════════════════════════════════════════════════════════════
// 2. REGIONAL NEWS
// ════════════════════════════════════════════════════════════════
const REGIONAL = {
  hindi:   [{name:'BBC हिन्दी',  url:'https://feeds.bbci.co.uk/hindi/rss.xml'},
            {name:'अमर उजाला',   url:'https://www.amarujala.com/rss/breaking-news.xml'},
            {name:'दैनिक भास्कर', url:'https://www.bhaskar.com/rss-feed/1061'}],
  marathi: [{name:'TV9 मराठी',   url:'https://www.tv9marathi.com/feed'},
            {name:'ABP माझा',    url:'https://marathi.abplive.com/feed'}],
  bangla:  [{name:'ABP আনন্দ',   url:'https://bengali.abplive.com/feed'},
            {name:'TV9 বাংলা',   url:'https://tv9bangla.com/feed'}],
  tamil:   [{name:'BBC Tamil',   url:'https://feeds.bbci.co.uk/tamil/rss.xml'},
            {name:'Thanthi TV',  url:'https://www.thanthitv.com/feed'}],
  gujarati:[{name:'BBC Gujarati',url:'https://feeds.bbci.co.uk/gujarati/rss.xml'}],
  punjabi: [{name:'BBC Punjabi', url:'https://feeds.bbci.co.uk/punjabi/rss.xml'}],
  urdu:    [{name:'BBC Urdu',    url:'https://feeds.bbci.co.uk/urdu/rss.xml'}],
  nepali:  [{name:'BBC Nepali',  url:'https://feeds.bbci.co.uk/nepali/rss.xml'}],
};

async function fetchRegionalNews(lang) {
  const feeds = REGIONAL[lang]; if (!feeds) return [];
  const RSSParser = require('rss-parser');
  const parser = new RSSParser({ timeout:10000, headers:{'User-Agent':'IndiaMonitor/4.0'} });
  let items = [];
  await Promise.allSettled(feeds.map(async f => {
    try {
      const p = await parser.parseURL(f.url);
      (p.items||[]).slice(0,8).forEach(i => items.push({
        source:f.name, title:(i.title||'').trim(), link:i.link||'',
        pubDate:i.pubDate||i.isoDate||new Date().toISOString(),
        excerpt:(i.contentSnippet||'').trim().slice(0,200),
      }));
    } catch(e) { console.error(`[${lang}] ${f.name}: ${e.message}`); }
  }));
  items.sort((a,b) => new Date(b.pubDate)-new Date(a.pubDate));
  const seen = new Set();
  const result = items
    .filter(i => { const k=i.title.toLowerCase().slice(0,50); if(seen.has(k))return false; seen.add(k);return true; })
    .map(i => ({...i, severity:severity(i.title), timeAgo:timeAgo(i.pubDate)}))
    .slice(0,30);
  cache.set(`news_${lang}`, result);
  return result;
}

// ════════════════════════════════════════════════════════════════
// 3. MARKETS — Google Finance scrape + Open.er-api forex
// ════════════════════════════════════════════════════════════════
const GFIN_SYMS = [
  {g:'NIFTY_50:INDEXNSE',  n:'NIFTY 50',   t:'index', cur:'INR'},
  {g:'SENSEX:INDEXBOM',    n:'SENSEX',      t:'index', cur:'INR'},
  {g:'NIFTY_BANK:INDEXNSE',n:'BANK NIFTY', t:'index', cur:'INR'},
  {g:'NIFTY_IT:INDEXNSE',  n:'NIFTY IT',   t:'index', cur:'INR'},
  {g:'NIFTY_MIDCAP_100:INDEXNSE',n:'MIDCAP 100',t:'index',cur:'INR'},
  {g:'USDINR:CUR',  n:'USD/INR', t:'forex', cur:'INR'},
  {g:'EURINR:CUR',  n:'EUR/INR', t:'forex', cur:'INR'},
  {g:'GBPINR:CUR',  n:'GBP/INR', t:'forex', cur:'INR'},
  {g:'JPYINR:CUR',  n:'JPY/INR', t:'forex', cur:'INR'},
  {g:'AEFINR:CUR',  n:'AED/INR', t:'forex', cur:'INR'},
];

async function fetchMarkets() {
  console.log('[MKT] Fetching...');
  const quotes = []; const seen = new Set();
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  for (const gs of GFIN_SYMS) {
    if (seen.has(gs.n)) continue;
    try {
      const r   = await safeFetch(`https://www.google.com/finance/quote/${gs.g}`,{headers:{' User-Agent':UA},timeout:8000});
      const html= await r.text();
      const price = html.match(/data-last-price="([^"]+)"/)?.[1];
      const chg   = html.match(/data-last-normal-market-change="([^"]+)"/)?.[1];
      const pct   = html.match(/data-last-normal-market-change-percent="([^"]+)"/)?.[1];
      if (price) {
        quotes.push({ name:gs.n, symbol:gs.g, type:gs.t,
          price:parseFloat(price)||0, change:parseFloat(chg)||0,
          changePct:(parseFloat(pct)||0)*100, currency:gs.cur,
          updatedAt:new Date().toISOString() });
        seen.add(gs.n);
      }
    } catch(e) { /* skip */ }
  }

  // Forex backup
  try {
    const r = await safeFetch('https://open.er-api.com/v6/latest/USD',{timeout:8000});
    const d = await r.json();
    if (d.rates?.INR) {
      const inr = d.rates.INR;
      [['USD/INR','USDINR',inr],['EUR/INR','EURINR',inr/d.rates.EUR],
       ['GBP/INR','GBPINR',inr/d.rates.GBP],['JPY/INR','JPYINR',inr/d.rates.JPY],
       ['AED/INR','AEDINR',inr/d.rates.AED]].forEach(([n,s,p])=>{
        if (!seen.has(n)) { quotes.push({name:n,symbol:s,type:'forex',price:p,change:0,changePct:0,currency:'INR',updatedAt:new Date().toISOString()}); seen.add(n); }
      });
    }
  } catch(e) { console.error('[MKT] FX backup:', e.message); }

  // Gold/Silver/Crude from Google Finance
  const comItems = [
    {g:'XAU-USD',n:'GOLD',unit:'USD/oz',t:'commodity',cur:'USD'},
    {g:'XAG-USD',n:'SILVER',unit:'USD/oz',t:'commodity',cur:'USD'},
    {g:'CL=F',   n:'CRUDE WTI',unit:'USD/bbl',t:'commodity',cur:'USD'},
    {g:'NG=F',   n:'NAT GAS',unit:'USD/MMBtu',t:'commodity',cur:'USD'},
  ];
  for (const c of comItems) {
    try {
      const r    = await safeFetch(`https://www.google.com/finance/quote/${c.g}`,{headers:{'User-Agent':UA},timeout:8000});
      const html = await r.text();
      const price = html.match(/data-last-price="([^"]+)"/)?.[1];
      const pct   = html.match(/data-last-normal-market-change-percent="([^"]+)"/)?.[1];
      if (price) quotes.push({name:c.n,symbol:c.g,type:c.t,price:parseFloat(price)||0,change:0,changePct:(parseFloat(pct)||0)*100,currency:c.cur,unit:c.unit,updatedAt:new Date().toISOString()});
    } catch(e) { /* skip */ }
  }

  if (quotes.length) { cache.set('markets',quotes); console.log(`[MKT] ${quotes.length} symbols`); }
  return cache.get('markets') || [];
}

// ════════════════════════════════════════════════════════════════
// 4. CRYPTO — CoinGecko (free, no key)
// ════════════════════════════════════════════════════════════════
async function fetchCrypto() {
  console.log('[CRYPTO] Fetching...');
  try {
    const r = await safeFetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,dogecoin,cardano,binancecoin,matic-network&vs_currencies=inr,usd&include_24hr_change=true&include_market_cap=true',
      {timeout:10000}
    );
    const d = await r.json();
    const coins = [
      {id:'bitcoin',sym:'BTC',ic:'₿'},
      {id:'ethereum',sym:'ETH',ic:'Ξ'},
      {id:'binancecoin',sym:'BNB',ic:'◈'},
      {id:'solana',sym:'SOL',ic:'◎'},
      {id:'ripple',sym:'XRP',ic:'✕'},
      {id:'dogecoin',sym:'DOGE',ic:'Ð'},
      {id:'cardano',sym:'ADA',ic:'₳'},
      {id:'matic-network',sym:'MATIC',ic:'⬡'},
    ];
    const result = coins.map(c => {
      const p = d[c.id]; if (!p) return null;
      return { id:c.id, sym:c.sym, icon:c.ic,
        inr:p.inr, usd:p.usd,
        change24h:p.inr_24h_change||0,
        mcap:p.inr_market_cap||0 };
    }).filter(Boolean);
    cache.set('crypto', result);
    // Feed ticker
    const ticker = result.map(c => ({
      label:c.sym,
      value:`₹${c.inr>=1e7?(c.inr/1e7).toFixed(2)+'Cr':c.inr>=1e5?(c.inr/1e5).toFixed(2)+'L':c.inr.toFixed(0)}`,
      change:c.change24h
    }));
    cache.set('ticker_crypto', ticker);
    console.log(`[CRYPTO] ${result.length} coins`);
    return result;
  } catch(e) { console.error('[CRYPTO]',e.message); return cache.get('crypto')||[]; }
}

// ════════════════════════════════════════════════════════════════
// 5. FOREX — Currency-API (completely free, no key, no limits)
// ════════════════════════════════════════════════════════════════
async function fetchForex() {
  console.log('[FOREX] Fetching...');
  try {
    const r = await safeFetch(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/inr.json',
      {timeout:8000}
    );
    const d = await r.json();
    const rates = d.inr || {};
    const pairs = ['usd','eur','gbp','jpy','aed','sgd','aud','cad','chf','cny','thb','myr','hkd','krw','chf'];
    const result = {
      base:'INR', date:d.date,
      rates: pairs.reduce((acc,k) => { if(rates[k]) acc[k.toUpperCase()]=rates[k]; return acc; }, {})
    };
    cache.set('forex', result, 3600);
    console.log(`[FOREX] ${Object.keys(result.rates).length} pairs`);
    return result;
  } catch(e) {
    // Fallback to open.er-api
    try {
      const r = await safeFetch('https://open.er-api.com/v6/latest/INR',{timeout:8000});
      const d = await r.json();
      const pairs = ['USD','EUR','GBP','JPY','AED','SGD','AUD','CAD','CHF','CNY'];
      const result = { base:'INR', date:new Date().toISOString().slice(0,10),
        rates:pairs.reduce((acc,k)=>{if(d.rates[k])acc[k]=d.rates[k];return acc;},{})};
      cache.set('forex',result,3600); return result;
    } catch(e2) { return cache.get('forex')||{base:'INR',rates:{}}; }
  }
}

// ════════════════════════════════════════════════════════════════
// 6. WEATHER — Open-Meteo (free, no key, no limits)
// ════════════════════════════════════════════════════════════════
const CITIES = [
  {n:'Delhi',     la:28.61, lo:77.21},
  {n:'Mumbai',    la:19.07, lo:72.88},
  {n:'Kolkata',   la:22.57, lo:88.36},
  {n:'Chennai',   la:13.08, lo:80.27},
  {n:'Bengaluru', la:12.97, lo:77.59},
  {n:'Hyderabad', la:17.38, lo:78.49},
  {n:'Jaipur',    la:26.91, lo:75.79},
  {n:'Lucknow',   la:26.85, lo:80.95},
  {n:'Ahmedabad', la:23.03, lo:72.58},
  {n:'Pune',      la:18.52, lo:73.86},
];
function wxText(code) {
  if(code===0)return'Clear';if(code<=3)return'Partly Cloudy';
  if(code<=49)return'Foggy';if(code<=59)return'Drizzle';
  if(code<=69)return'Rain';if(code<=79)return'Snow';
  if(code<=84)return'Showers';if(code<=99)return'Thunderstorm';return'Unknown';
}
async function fetchWeather() {
  console.log('[WX] Fetching...');
  const results = [];
  // Batch request — all cities in one API call using multi-coordinate endpoint
  try {
    const lats = CITIES.map(c=>c.la).join(',');
    const lons = CITIES.map(c=>c.lo).join(',');
    const r = await safeFetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m,apparent_temperature,precipitation&timezone=Asia/Kolkata`,
      {timeout:15000}
    );
    const data = await r.json();
    // Response is array when multiple locations
    const arr = Array.isArray(data) ? data : [data];
    arr.forEach((d,i) => {
      const c = CITIES[i]; if (!c) return;
      const cur = d.current||{};
      if (cur.temperature_2m !== undefined) {
        results.push({
          city:c.n, lat:c.la, lng:c.lo,
          temperature:Math.round(cur.temperature_2m),
          feelsLike:Math.round(cur.apparent_temperature||cur.temperature_2m),
          windSpeed:Math.round(cur.wind_speed_10m||0),
          humidity:cur.relative_humidity_2m||0,
          precipitation:cur.precipitation||0,
          condition:wxText(cur.weather_code||0),
          code:cur.weather_code||0,
          updatedAt:new Date().toISOString(),
        });
      }
    });
  } catch(e) {
    console.error('[WX] Batch failed, trying serial...');
    for (const c of CITIES.slice(0,5)) {
      try {
        const r = await safeFetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.la}&longitude=${c.lo}&current=temperature_2m,wind_speed_10m,weather_code,relative_humidity_2m&timezone=Asia/Kolkata`,{timeout:8000});
        const d = await r.json(); const cur = d.current||{};
        if (cur.temperature_2m!==undefined) results.push({city:c.n,lat:c.la,lng:c.lo,temperature:Math.round(cur.temperature_2m),windSpeed:Math.round(cur.wind_speed_10m||0),humidity:cur.relative_humidity_2m||0,condition:wxText(cur.weather_code||0),code:cur.weather_code||0,updatedAt:new Date().toISOString()});
        await new Promise(ok=>setTimeout(ok,1000));
      } catch(e2) { console.error(`[WX] ${c.n}: ${e2.message}`); }
    }
  }
  if (results.length) { cache.set('weather',results); console.log(`[WX] ${results.length} cities`); }
  return cache.get('weather')||[];
}

// ════════════════════════════════════════════════════════════════
// 7. AQI — Open-Meteo Air Quality
// ════════════════════════════════════════════════════════════════
function aqiLevel(v) {
  if(!v)return'Unknown';if(v<=50)return'Good';if(v<=100)return'Moderate';
  if(v<=150)return'Unhealthy (Sensitive)';if(v<=200)return'Unhealthy';
  if(v<=300)return'Very Unhealthy';return'Hazardous';
}
async function fetchAQI() {
  console.log('[AQI] Fetching...');
  const results = [];
  for (const c of CITIES.slice(0,6)) {
    try {
      const r = await safeFetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${c.la}&longitude=${c.lo}&current=pm2_5,pm10,us_aqi`,{timeout:10000});
      const d = await r.json(); const cur = d.current||{};
      results.push({city:c.n,lat:c.la,lng:c.lo,aqi:cur.us_aqi||0,pm25:cur.pm2_5||0,pm10:cur.pm10||0,level:aqiLevel(cur.us_aqi),updatedAt:new Date().toISOString()});
      await new Promise(ok=>setTimeout(ok,1200));
    } catch(e) { console.error(`[AQI] ${c.n}: ${e.message}`); }
  }
  cache.set('airquality',results);
  console.log(`[AQI] ${results.length} cities`);
  return results;
}

// ════════════════════════════════════════════════════════════════
// 8. EARTHQUAKES — USGS (free)
// ════════════════════════════════════════════════════════════════
async function fetchQuakes() {
  console.log('[QUAKE] Fetching...');
  try {
    const r = await safeFetch('https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=5&maxlatitude=38&minlongitude=65&maxlongitude=100&minmagnitude=2.5&limit=20&orderby=time');
    const d = await r.json();
    const quakes = (d.features||[]).map(f => ({
      id:f.id, magnitude:f.properties.mag, place:f.properties.place,
      time:new Date(f.properties.time).toISOString(),
      timeAgo:timeAgo(new Date(f.properties.time).toISOString()),
      depth:f.geometry.coordinates[2], lat:f.geometry.coordinates[1],
      lng:f.geometry.coordinates[0], tsunami:f.properties.tsunami,
      alert:f.properties.alert,
    }));
    cache.set('earthquakes',quakes);
    console.log(`[QUAKE] ${quakes.length} events`);
    return quakes;
  } catch(e) { console.error(`[QUAKE] ${e.message}`); return cache.get('earthquakes')||[]; }
}

// ════════════════════════════════════════════════════════════════
// 9. CRICKET — ESPN Cricinfo (free)
// ════════════════════════════════════════════════════════════════
async function fetchCricket() {
  console.log('[CRICKET] Fetching...');
  const results = {live:[],upcoming:[],recent:[],news:[]};
  try {
    const r = await safeFetch('https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=cricket&lang=en&region=in&limit=30',{headers:{'User-Agent':'IndiaMonitor/4.0'},timeout:10000});
    const d = await r.json();
    const events = d?.sports?.[0]?.leagues||[];
    events.forEach(league => {
      (league.events||[]).forEach(ev => {
        const match = {id:ev.id,name:ev.name||'',league:league.name||'',leagueAbbr:league.abbreviation||'',
          status:ev.fullStatus?.type?.description||'',state:ev.fullStatus?.type?.state||'',
          detail:ev.fullStatus?.type?.detail||'',date:ev.date,
          teams:(ev.competitors||[]).map(c=>({name:c.displayName||'',abbr:c.abbreviation||'',score:c.score||'',logo:c.logo||'',winner:c.winner||false})),
          link:ev.link||''};
        if(match.state==='in')results.live.push(match);
        else if(match.state==='post')results.recent.push(match);
        else results.upcoming.push(match);
      });
    });
  } catch(e) { console.error(`[CRICKET] ${e.message}`); }
  // ESPNcricinfo RSS news
  try {
    const RSSParser = require('rss-parser');
    const p = new RSSParser({timeout:6000,headers:{'User-Agent':'IndiaMonitor/4.0'}});
    const feed = await p.parseURL('https://www.espncricinfo.com/rss/content/story/feeds/0.xml');
    results.news = (feed.items||[]).slice(0,6).map(i=>({title:(i.title||'').trim(),link:i.link||'',pubDate:i.pubDate||'',source:'ESPNcricinfo'}));
  } catch(e) { results.news=[]; }
  cache.set('cricket',results);
  console.log(`[CRICKET] Live:${results.live.length} Upcoming:${results.upcoming.length}`);
  return results;
}

// ════════════════════════════════════════════════════════════════
// 10. FOOTBALL — ESPN (free)
// ════════════════════════════════════════════════════════════════
async function fetchFootball() {
  console.log('[FOOTBALL] Fetching...');
  const results = {live:[],upcoming:[],recent:[]};
  const leagues = [
    {slug:'ind.1',name:'ISL'},{slug:'eng.1',name:'Premier League'},
    {slug:'uefa.champions',name:'UCL'},{slug:'esp.1',name:'La Liga'},
    {slug:'ger.1',name:'Bundesliga'},
  ];
  for (const lg of leagues) {
    try {
      const r = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg.slug}/scoreboard`,{headers:{'User-Agent':'IndiaMonitor/4.0'},timeout:8000});
      const d = await r.json();
      (d.events||[]).forEach(ev => {
        const comp = ev.competitions?.[0]; if(!comp) return;
        const match = {id:ev.id,name:ev.name||'',league:lg.name,
          status:comp.status?.type?.description||'',state:comp.status?.type?.state||'',
          detail:comp.status?.type?.detail||'',date:ev.date,venue:comp.venue?.fullName||'',
          teams:(comp.competitors||[]).map(c=>({name:c.team?.displayName||'',abbr:c.team?.abbreviation||'',score:c.score||'0',logo:c.team?.logo||'',winner:c.winner||false}))};
        if(match.state==='in')results.live.push(match);
        else if(match.state==='post')results.recent.push(match);
        else results.upcoming.push(match);
      });
    } catch(e) { /* skip */ }
  }
  results.upcoming.sort((a,b)=>new Date(a.date)-new Date(b.date));
  results.recent.sort((a,b)=>new Date(b.date)-new Date(a.date));
  cache.set('football',results);
  console.log(`[FOOTBALL] Live:${results.live.length}`);
  return results;
}

// ════════════════════════════════════════════════════════════════
// 11. ISS — wheretheiss.at (free)
// ════════════════════════════════════════════════════════════════
async function fetchISS() {
  try {
    const r = await safeFetch('https://api.wheretheiss.at/v1/satellites/25544',{timeout:8000});
    const d = await r.json();
    cache.set('iss',d,15);
    return d;
  } catch(e) { return cache.get('iss')||null; }
}

// ════════════════════════════════════════════════════════════════
// 12. FLIGHTS — adsb.lol (free ADS-B)
// ════════════════════════════════════════════════════════════════
async function fetchFlights() {
  try {
    const r = await safeFetch('https://api.adsb.lol/v2/lat/22/lon/82/dist/1400',{timeout:10000});
    const raw = await r.json();
    const ac = (raw.ac||[])
      .filter(a=>a.lat&&a.lon&&a.alt_baro&&a.alt_baro!=='ground'&&!a.ground)
      .slice(0,60)
      .map(a=>({hex:a.hex,flight:(a.flight||a.r||a.hex||'').trim(),
        lat:a.lat,lon:a.lon,
        alt:typeof a.alt_baro==='number'?Math.round(a.alt_baro*0.3048):0,
        speed:a.gs?Math.round(a.gs*1.852):0,
        heading:a.track||0,type:a.t||''}));
    const d = {total:raw.ac?.length||0,sample:ac};
    cache.set('flights',d,30);
    return d;
  } catch(e) { return cache.get('flights')||{total:0,sample:[]}; }
}

// ════════════════════════════════════════════════════════════════
// 13. CYBER — NVD CVE + Service health
// ════════════════════════════════════════════════════════════════
async function fetchCyber() {
  console.log('[CYBER] Fetching...');
  const data = {advisories:[],services:[],lastUpdated:new Date().toISOString()};
  try {
    const r = await safeFetch('https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=8',{headers:{'User-Agent':'IndiaMonitor/4.0'},timeout:15000});
    const d = await r.json();
    data.advisories = (d.vulnerabilities||[]).map(v => {
      const cve = v.cve||{};
      const desc = (cve.descriptions||[]).find(d=>d.lang==='en');
      let cvss = 0;
      for (const key of ['cvssMetricV31','cvssMetricV30','cvssMetricV2']) {
        if (cve.metrics?.[key]?.[0]) { cvss=cve.metrics[key][0].cvssData?.baseScore||0; break; }
      }
      const sev = cvss>=9?'critical':cvss>=7?'high':cvss>=4?'medium':'low';
      return {title:`${cve.id||'CVE'} — CVSS ${cvss}`,link:`https://nvd.nist.gov/vuln/detail/${cve.id}`,description:(desc?.value||'').slice(0,200),date:cve.published||'',severity:sev,source:'NVD',cvss};
    });
  } catch(e) { console.error(`[CYBER] NVD: ${e.message}`); }
  const checks = [
    {name:'UPI/NPCI',url:'https://www.npci.org.in',icon:'💳'},
    {name:'IRCTC',url:'https://www.irctc.co.in',icon:'🚂'},
    {name:'DigiLocker',url:'https://www.digilocker.gov.in',icon:'📄'},
    {name:'UIDAI/Aadhaar',url:'https://uidai.gov.in',icon:'🆔'},
    {name:'Income Tax',url:'https://www.incometax.gov.in',icon:'🏛️'},
    {name:'India Gov',url:'https://www.india.gov.in',icon:'🌐'},
  ];
  for (const chk of checks) {
    try {
      const start = Date.now();
      const r = await safeFetch(chk.url,{timeout:6000});
      data.services.push({name:chk.name,icon:chk.icon,status:r.ok?'operational':'degraded',latency:Date.now()-start});
    } catch(e) {
      data.services.push({name:chk.name,icon:chk.icon,status:e.name==='AbortError'?'slow':'down',latency:0});
    }
  }
  cache.set('cyber',data);
  console.log(`[CYBER] ${data.advisories.length} CVEs, ${data.services.length} services`);
  return data;
}

// ════════════════════════════════════════════════════════════════
// 14. DEFENCE — RSS feeds
// ════════════════════════════════════════════════════════════════
const DEF_FEEDS = [
  {name:'LiveFist',    url:'https://www.livefistdefence.com/feed/'},
  {name:'DefenseNews', url:'https://www.defensenews.com/arc/outboundfeeds/rss/category/global/asia-pacific/?outputType=xml'},
  {name:'PIB/MoD',     url:'https://pib.gov.in/RssMain.aspx?ModId=3&Lang=1&Regid=3'},
];
const DEF_KW = {
  iaf:['rafale','tejas','sukhoi','iaf','air force','c-130','chinook','apache'],
  navy:['ins ','vikrant','navy','naval','submarine','frigate','destroyer'],
  army:['army','regiment','brigade','loc','bsf','border','artillery','infantry'],
  missile:['brahmos','agni','prithvi','akash','missile','drdo','s-400'],
  exercise:['exercise','drill','joint','bilateral','malabar'],
  procurement:['procurement','contract','deal','acquisition','induction'],
  space:['isro','satellite','asat','gslv','pslv','chandrayaan'],
};
function defCat(text){const t=text.toLowerCase();for(const[cat,kws]of Object.entries(DEF_KW)){if(kws.some(k=>t.includes(k)))return cat;}return'general';}
function defSev(text){const t=text.toLowerCase();if(['war','attack','strike','killed','nuclear'].some(k=>t.includes(k)))return'critical';if(['tension','standoff','test fire','launch','border clash'].some(k=>t.includes(k)))return'high';return'medium';}

async function fetchDefence() {
  console.log('[DEFENCE] Fetching...');
  const RSSParser = require('rss-parser');
  const parser = new RSSParser({timeout:12000,headers:{'User-Agent':'IndiaMonitor/4.0'}});
  let articles = [];
  await Promise.allSettled(DEF_FEEDS.map(async feed => {
    try {
      const p = await parser.parseURL(feed.url);
      (p.items||[]).slice(0,10).forEach(i => {
        const title = (i.title||'').trim();
        const desc  = (i.contentSnippet||'').trim().slice(0,200);
        articles.push({title,link:i.link||'',description:desc,source:feed.name,
          date:i.pubDate||i.isoDate||'',category:defCat(title+' '+desc),
          severity:defSev(title+' '+desc),timeAgo:timeAgo(i.pubDate||new Date().toISOString())});
      });
    } catch(e) { console.error(`[DEFENCE] ${feed.name}: ${e.message}`); }
  }));
  const seen = new Set();
  articles = articles.filter(a=>{const k=a.title.toLowerCase().slice(0,50);if(seen.has(k))return false;seen.add(k);return true;});
  articles.sort((a,b)=>new Date(b.date)-new Date(a.date));
  const cats = {};
  articles.forEach(a=>{if(!cats[a.category])cats[a.category]={count:0,critical:0,high:0};cats[a.category].count++;if(a.severity==='critical')cats[a.category].critical++;if(a.severity==='high')cats[a.category].high++;});
  const readiness = [{name:'IAF',icon:'🛩️',key:'iaf'},{name:'Navy',icon:'🚢',key:'navy'},{name:'Army',icon:'⚔️',key:'army'},{name:'Missiles',icon:'🎯',key:'missile'},{name:'Exercises',icon:'🎖️',key:'exercise'},{name:'Procurement',icon:'📋',key:'procurement'},{name:'Space/ISRO',icon:'🛰️',key:'space'}]
    .map(item=>{const c=cats[item.key]||{count:0,critical:0,high:0};return{...item,articles:c.count,activity:c.count>=3?'high':c.count>=1?'moderate':'low',alert:c.critical>0||c.high>0};});
  const data = {articles:articles.slice(0,15),readiness,lastUpdated:new Date().toISOString()};
  cache.set('defence',data);
  console.log(`[DEFENCE] ${articles.length} articles`);
  return data;
}

// ════════════════════════════════════════════════════════════════
// 15. HISTORY — Wikipedia On This Day
// ════════════════════════════════════════════════════════════════
async function fetchHistory() {
  try {
    const now = new Date();
    const mm  = String(now.getMonth()+1).padStart(2,'0');
    const dd  = String(now.getDate()).padStart(2,'0');
    const r   = await safeFetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`,{timeout:8000});
    const {events=[]} = await r.json();
    const india = events.filter(e=>/india|indian|delhi|mumbai|gandhi|nehru|kolkata|bombay|partition|independence/i.test(e.text));
    const items = (india.length>=3?india:events).slice(0,8).map(e=>{
      const pages=e.pages||[]; const link=pages[0]?.content_urls?.desktop?.page||'#';
      return {year:e.year,text:e.text,link};
    });
    cache.set('history',items,3600); return items;
  } catch(e) { return cache.get('history')||[]; }
}

// ════════════════════════════════════════════════════════════════
// 16. SPACE — SpaceX + Launch Library 2
// ════════════════════════════════════════════════════════════════
async function fetchSpace() {
  console.log('[SPACE] Fetching...');
  const data = {launches:[],isro:[],apod:null};
  // Upcoming launches — Launch Library 2 (free)
  try {
    const r = await safeFetch('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&format=json',{timeout:10000});
    const d = await r.json();
    data.launches = (d.results||[]).map(l=>({
      id:l.id,name:l.name,rocket:l.rocket?.configuration?.name||'',
      agency:l.launch_service_provider?.name||'',
      status:l.status?.name||'',date:l.net||'',
      image:l.image||'',
      pad:l.pad?.location?.name||'',
    }));
  } catch(e) { console.error('[SPACE] Launches:', e.message); }
  // NASA APOD (uses key if provided)
  try {
    const key = process.env.NASA_API_KEY||'DEMO_KEY';
    const r   = await safeFetch(`https://api.nasa.gov/planetary/apod?api_key=${key}`,{timeout:8000});
    const d   = await r.json();
    if (d.url) data.apod = {title:d.title,date:d.date,explanation:d.explanation?.slice(0,300),url:d.url,media_type:d.media_type};
  } catch(e) { console.error('[SPACE] APOD:', e.message); }
  cache.set('space',data,900); // 15 min
  console.log(`[SPACE] ${data.launches.length} launches`);
  return data;
}

// ════════════════════════════════════════════════════════════════
// 17. INDIA STATS — REST Countries + World Bank
// ════════════════════════════════════════════════════════════════
async function fetchIndiaStats() {
  try {
    const [cR,wbR] = await Promise.allSettled([
      safeFetch('https://restcountries.com/v3.1/alpha/IN',{timeout:8000}),
      safeFetch('https://api.worldbank.org/v2/country/IN/indicator/NY.GDP.MKTP.CD?format=json&per_page=1&mrv=1',{timeout:8000}),
    ]);
    const country = cR.status==='fulfilled'?(await cR.value.json())[0]:null;
    const wbData  = wbR.status==='fulfilled'?await wbR.value.json():null;
    const d = {
      name:country?.name?.official||'Republic of India',
      capital:country?.capital?.[0]||'New Delhi',
      population:country?.population||1400000000,
      area:country?.area||3287263,
      currencies:country?.currencies,
      languages:country?.languages,
      gdp:wbData?.[1]?.[0]?.value||null,
      gdpYear:wbData?.[1]?.[0]?.date||null,
    };
    cache.set('india_stats',d,86400); return d;
  } catch(e) { return cache.get('india_stats')||{}; }
}

// ════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════
app.get('/api/health', (req,res)=>res.json({status:'ok',uptime:process.uptime(),cache:cache.getStats(),ts:new Date().toISOString(),version:'4.0.0'}));

// Combined fast-boot (single request loads critical data)
app.get('/api/all', async (req,res) => {
  try {
    res.json({success:true,ts:Date.now(),data:{
      news:    cache.get('news')        || [],
      markets: cache.get('markets')     || [],
      crypto:  cache.get('crypto')      || [],
      weather: cache.get('weather')     || [],
      cricket: cache.get('cricket')     || {live:[],upcoming:[],recent:[]},
      quakes:  cache.get('earthquakes') || [],
      forex:   cache.get('forex')       || null,
    }});
  } catch(e) { res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/news',         async (req,res)=>{try{let d=cache.get('news');if(!d)d=await fetchAllNews();if(req.query.category)d=d.filter(n=>n.category===req.query.category);res.json({success:true,count:d.length,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/news/:lang',   async (req,res)=>{try{const lang=req.params.lang;let d=cache.get(`news_${lang}`);if(!d)d=await fetchRegionalNews(lang);res.json({success:true,count:d.length,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/markets',      async (req,res)=>{try{let d=cache.get('markets');if(!d)d=await fetchMarkets();res.json({success:true,count:d.length,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/crypto',       async (req,res)=>{try{let d=cache.get('crypto');if(!d)d=await fetchCrypto();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/forex',        async (req,res)=>{try{let d=cache.get('forex');if(!d)d=await fetchForex();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/weather',      async (req,res)=>{try{let d=cache.get('weather');if(!d)d=await fetchWeather();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/airquality',   async (req,res)=>{try{let d=cache.get('airquality');if(!d)d=await fetchAQI();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/earthquakes',  async (req,res)=>{try{let d=cache.get('earthquakes');if(!d)d=await fetchQuakes();res.json({success:true,count:d.length,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/cricket',      async (req,res)=>{try{let d=cache.get('cricket');if(!d)d=await fetchCricket();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/football',     async (req,res)=>{try{let d=cache.get('football');if(!d)d=await fetchFootball();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/iss',          async (req,res)=>{try{let d=cache.get('iss');if(!d)d=await fetchISS();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/flights',      async (req,res)=>{try{let d=cache.get('flights');if(!d)d=await fetchFlights();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/cyber',        async (req,res)=>{try{let d=cache.get('cyber');if(!d)d=await fetchCyber();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/defence',      async (req,res)=>{try{let d=cache.get('defence');if(!d)d=await fetchDefence();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/history',      async (req,res)=>{try{let d=cache.get('history');if(!d)d=await fetchHistory();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/space',        async (req,res)=>{try{let d=cache.get('space');if(!d)d=await fetchSpace();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});
app.get('/api/india-stats',  async (req,res)=>{try{let d=cache.get('india_stats');if(!d)d=await fetchIndiaStats();res.json({success:true,data:d});}catch(e){res.status(500).json({success:false,error:e.message});}});

app.get('/', (req,res)=>res.json({name:'India Monitor API',version:'4.0.0',status:'running',endpoints:['/api/all','/api/health','/api/news','/api/markets','/api/crypto','/api/forex','/api/weather','/api/airquality','/api/earthquakes','/api/cricket','/api/football','/api/iss','/api/flights','/api/cyber','/api/defence','/api/history','/api/space','/api/india-stats']}));

// ════════════════════════════════════════════════════════════════
// CRON SCHEDULES
// ════════════════════════════════════════════════════════════════
cron.schedule('*/5 * * * *',  ()=>fetchAllNews().catch(console.error));
cron.schedule('*/5 * * * *',  ()=>Promise.allSettled(Object.keys(REGIONAL).map(l=>fetchRegionalNews(l))).catch(console.error));
cron.schedule('*/3 * * * *',  ()=>fetchMarkets().catch(console.error));
cron.schedule('*/5 * * * *',  ()=>fetchCrypto().catch(console.error));
cron.schedule('0 * * * *',    ()=>fetchForex().catch(console.error));
cron.schedule('5,35 * * * *', ()=>fetchWeather().catch(console.error));
cron.schedule('20,50 * * * *',()=>fetchAQI().catch(console.error));
cron.schedule('*/10 * * * *', ()=>fetchQuakes().catch(console.error));
cron.schedule('*/2 * * * *',  ()=>fetchCricket().catch(console.error));
cron.schedule('*/2 * * * *',  ()=>fetchFootball().catch(console.error));
cron.schedule('*/1 * * * *',  ()=>fetchISS().catch(console.error));  // ISS every 1 min
cron.schedule('*/15 * * * *', ()=>fetchCyber().catch(console.error));
cron.schedule('*/10 * * * *', ()=>fetchDefence().catch(console.error));
cron.schedule('0 0 * * *',    ()=>fetchHistory().catch(console.error));  // daily
cron.schedule('0 */3 * * *',  ()=>fetchSpace().catch(console.error));   // 3-hourly

// ════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════
async function boot() {
  console.log('🇮🇳 INDIA MONITOR v4.0 — Bloomberg Terminal Backend Starting...');
  await Promise.allSettled([fetchAllNews(),fetchQuakes(),fetchCricket(),fetchFootball(),...Object.keys(REGIONAL).map(l=>fetchRegionalNews(l)),fetchDefence()]);
  console.log('✅ Phase 1 (news, sports, defence)');
  await Promise.allSettled([fetchMarkets(),fetchCrypto(),fetchForex(),fetchCyber(),fetchSpace(),fetchIndiaStats()]);
  console.log('✅ Phase 2 (markets, crypto, forex, cyber, space)');
  await fetchWeather();
  console.log('[BOOT] Weather done — waiting 5s before AQI...');
  await new Promise(ok=>setTimeout(ok,5000));
  await fetchAQI();
  console.log('✅ Phase 3 (weather, AQI)');
  app.listen(PORT, ()=>{ console.log(`🚀 India Monitor API v4.0 running on port ${PORT}`); });
}
boot();
