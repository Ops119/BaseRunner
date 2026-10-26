// Base AI trading agent: watchlist, risk-managed paper trading, x402-aware data feed, dashboard server.
// Zero dependencies. Run: node agent.js  ->  http://localhost:8402
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadOrCreateWallet } = require('./wallet');
const { createLive, liveConfig } = require('./live');
const { createScanner } = require('./scanner');

const LCFG = liveConfig();
const LIVE_ON = LCFG.enabled;
let L = null; // live executor, set in startup() when LIVE=1
const DATA_DIR = process.env.STATE_DIR || __dirname; // on Railway: the mounted volume (e.g. /data)
fs.mkdirSync(DATA_DIR, { recursive: true });
const STOP_FILE = path.join(DATA_DIR, 'STOP');
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const DASH_TOKEN = process.env.DASH_TOKEN || '';
if (DASH_TOKEN && DASH_TOKEN.length < 16) { console.error('\nREFUSED TO START: DASH_TOKEN must be at least 16 characters (use a long random string).\n'); process.exit(1); }

const CFG = {
  port: +process.env.PORT || 8402,
  tickSeconds: +process.env.TICK_SECONDS || 60,
  mode: LIVE_ON ? 'live' : 'paper',
  startCash: +process.env.START_CASH || 1000,
  maxPositionPct: 0.15, cashReserve: 0.20, maxOpen: 4,
  stopLoss: -0.10, takeProfit: 0.20, trailActivate: 0.06, trailStop: 0.05,
  timeStopHours: 72, cooldownHours: 6, dailyLossHalt: -0.05, feePct: 0.003,
  x402DataUrl: process.env.X402_DATA_URL || '',
  regimeDays: process.env.REGIME === 'off' ? 0 : (+process.env.REGIME_DAYS || 100), // BTC trend filter, see README backtest
  rpc: process.env.BASE_RPC || 'https://mainnet.base.org',
};

// Top 8 tradeable Base assets (volatile, liquid; stablecoins excluded because they cannot make profit).
// Ranked by CoinMarketCap rank, 26 Oct 2026. ETH/BTC trade on Base as WETH/cbBTC. Verify contracts before live use.
const WATCHLIST = [
  { sym: 'ETH',     name: 'Ethereum (WETH)',     cg: 'ethereum',              slip: 0.001, tier: 'Core' },
  { sym: 'BTC',     name: 'Coinbase BTC (cbBTC)', cg: 'coinbase-wrapped-btc', slip: 0.001, tier: 'Core' },
  { sym: 'LINK',    name: 'Chainlink',           cg: 'chainlink',             slip: 0.004, tier: 'Blue chip' },
  { sym: 'MORPHO',  name: 'Morpho',              cg: 'morpho',                slip: 0.004, tier: 'DeFi' },
  { sym: 'AERO',    name: 'Aerodrome',           cg: 'aerodrome-finance',     slip: 0.004, tier: 'DeFi' },
  { sym: 'VIRTUAL', name: 'Virtuals Protocol',   cg: 'virtual-protocol',      slip: 0.005, tier: 'AI agents' },
  { sym: 'BRETT',   name: 'Brett',               cg: 'based-brett',           slip: 0.010, tier: 'Meme' },
  { sym: 'DEGEN',   name: 'Degen',               cg: 'degen-base',            slip: 0.010, tier: 'Meme' },
];

// Offline snapshot (CoinMarketCap, 26 Oct 2026 06:54 UTC). Display only: the agent never trades on it.
const SNAPSHOT = {
  ETH: [2314.75, -0.30, -0.89, -4.64], BTC: [79940.10, -0.21, -0.54, -3.35], LINK: [11.3623, -0.72, 0.08, -6.79],
  MORPHO: [2.0012, -1.52, -4.13, -18.21], AERO: [0.66617, -0.28, -2.28, -16.54], VIRTUAL: [0.61333, -0.87, -0.67, -7.14],
  BRETT: [0.0046314, -0.93, -1.78, -1.60], DEGEN: [0.00089692, -0.35, -1.32, -8.48],
};

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !DASH_TOKEN) { console.error('\nREFUSED TO START: the dashboard would be reachable from the internet. Set DASH_TOKEN to a long random string.\n'); process.exit(1); }
const wallet = loadOrCreateWallet(DATA_DIR);
const STATE_FILE = path.join(DATA_DIR, LIVE_ON ? 'state-live.json' : 'state.json');
const now = () => Date.now();
const utcDay = () => new Date().toISOString().slice(0, 10);

let S = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {
  startedAt: now(), cash: CFG.startCash, startEquity: CFG.startCash, positions: {}, trades: [], log: [],
  equity: [], cooldown: {}, dayKey: utcDay(), dayStart: CFG.startCash, halted: false,
};
let live = { prices: {}, source: 'none', updated: 0, chain: { eth: null, usdc: null, ok: false } };

function log(msg, kind = 'info') {
  S.log.unshift({ t: now(), kind, msg });
  S.log = S.log.slice(0, 80);
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${kind.toUpperCase()} ${msg}`);
}
const save = () => { const t = STATE_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(S)); fs.renameSync(t, STATE_FILE); }; // atomic: a kill mid-write can't corrupt state

// BTC trend regime: only open new positions while BTC trades above its N-day average. Fails closed.
const regime = { ok: null, btc: null, sma: null, checked: 0, err: null };
async function updateRegime() {
  if (!CFG.regimeDays) { regime.ok = true; return; }
  if (now() - regime.checked < 3600e3 && regime.ok !== null) return;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${CFG.regimeDays + 5}&interval=daily`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const closes = (await r.json()).prices.map(p => p[1]).filter(Number.isFinite);
    if (closes.length < CFG.regimeDays + 1) throw new Error('not enough history');
    const win = closes.slice(-(CFG.regimeDays + 1), -1); // prior N completed daily closes
    const sma = win.reduce((x, y) => x + y, 0) / win.length, btc = live.prices.BTC?.price || closes[closes.length - 1];
    const ok = btc > sma;
    if (regime.ok !== ok) log(`Regime ${ok ? 'ON' : 'OFF'}: BTC $${btc.toFixed(0)} is ${ok ? 'above' : 'below'} its ${CFG.regimeDays}-day average $${sma.toFixed(0)}. ${ok ? 'New entries allowed.' : 'No new entries (exits still managed).'}`, 'risk');
    Object.assign(regime, { ok, btc, sma, checked: now(), err: null });
  } catch (e) {
    regime.checked = now() - 3000e3; // retry in ~10 min
    if (regime.err !== e.message) log('Regime check failed (' + e.message + '): no new entries until it works.', 'risk');
    regime.err = e.message; if (regime.ok !== null) regime.ok = null;
  }
}

// ---------- data ----------
async function fetchJson(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: r.status === 402 ? await r.json().catch(() => ({})) : await r.json() };
}

async function fetchPrices() {
  const ids = WATCHLIST.map(w => w.cg).join(',');
  const url = CFG.x402DataUrl || `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=1h,24h,7d`;
  try {
    const { status, body } = await fetchJson(url);
    if (status === 402) {
      // x402: server wants payment. Paper mode never pays; log the requirement so you can see what it would cost.
      const req = (body.accepts || [])[0] || {};
      log(`x402 data source asks for payment: ${req.maxAmountRequired || '?'} units of ${req.asset || '?'} on ${req.network || '?'} (not paid in ${CFG.mode} mode)`, 'x402');
      throw new Error('402');
    }
    if (status !== 200 || !Array.isArray(body)) throw new Error('HTTP ' + status);
    const out = {};
    for (const w of WATCHLIST) {
      const m = body.find(x => x.id === w.cg);
      if (m) out[w.sym] = { price: m.current_price, c1h: m.price_change_percentage_1h_in_currency, c24h: m.price_change_percentage_24h_in_currency, c7d: m.price_change_percentage_7d_in_currency, vol: m.total_volume };
    }
    if (Object.keys(out).length < 6) throw new Error('incomplete data');
    return { prices: out, source: CFG.x402DataUrl ? 'x402 feed' : 'CoinGecko live' };
  } catch (e) {
    const out = {};
    for (const [sym, v] of Object.entries(SNAPSHOT)) out[sym] = { price: v[0], c1h: v[1], c24h: v[2], c7d: v[3] };
    return { prices: out, source: 'SNAPSHOT (offline, trading paused)', err: e.message };
  }
}

async function rpc(method, params) {
  const r = await fetch(CFG.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  return (await r.json()).result;
}
async function fetchChain() {
  try {
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const data = '0x70a08231' + wallet.address.slice(2).toLowerCase().padStart(64, '0');
    const [eth, usdc] = await Promise.all([rpc('eth_getBalance', [wallet.address, 'latest']), rpc('eth_call', [{ to: USDC, data }, 'latest'])]);
    live.chain = { eth: Number(BigInt(eth)) / 1e18, usdc: Number(BigInt(usdc)) / 1e6, ok: true };
  } catch (e) { live.chain = { eth: null, usdc: null, ok: false }; }
}

// ---------- strategy ----------
function signal(d) {
  if (!d || d.c1h == null || d.c24h == null || d.c7d == null) return null;
  if (d.c1h > 0.3 && d.c24h > 2 && d.c7d > -10) return { type: 'MOMENTUM', score: d.c24h / 10 + d.c1h };
  if (d.c7d <= -12 && d.c1h > 0.5 && d.c24h > -3) return { type: 'DIP BOUNCE', score: -d.c7d / 20 + d.c1h };
  return null;
}
const equity = () => S.cash + Object.entries(S.positions).reduce((a, [s, p]) => a + p.qty * (live.prices[s]?.price || p.entry), 0);

async function sell(sym, why) {
  const p = S.positions[sym], w = WATCHLIST.find(x => x.sym === sym);
  let px, qty = p.qty, net, hash, via;
  if (LIVE_ON) {
    const r = await L.sell(sym, p.qty, live.prices[sym].price);
    if (!r) return; // failure already logged; position stays open and is retried next tick
    ({ px, qty, usd: net, hash } = r); via = r.router;
  } else {
    px = live.prices[sym].price * (1 - w.slip);
    const gross = p.qty * px; net = gross - gross * CFG.feePct;
  }
  S.cash += net; const pnl = net - p.cost;
  S.trades.unshift({ t: now(), sym, side: 'SELL', px, qty, usd: net, pnl, why, hash, via });
  S.cooldown[sym] = now() + CFG.cooldownHours * 3600e3;
  delete S.positions[sym];
  save();
  log(`${LIVE_ON ? 'LIVE ' : ''}SELL ${sym} @ ${px.toPrecision(5)} (${why}) P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}${hash ? ` via ${via} ${hash.slice(0, 12)}…` : ''}`, pnl >= 0 ? 'win' : 'loss');
}
async function buy(sym, usd, sig) {
  const w = WATCHLIST.find(x => x.sym === sym);
  let px, qty, hash, via;
  if (LIVE_ON) {
    const r = await L.buy(sym, usd, live.prices[sym].price);
    if (!r) return;
    ({ px, qty, usd, hash } = r); via = r.router;
  } else {
    px = live.prices[sym].price * (1 + w.slip); qty = (usd - usd * CFG.feePct) / px;
  }
  S.cash -= usd;
  S.positions[sym] = { qty, entry: px, cost: usd, peak: px, openedAt: now(), sig: sig.type };
  S.trades.unshift({ t: now(), sym, side: 'BUY', px, qty, usd, why: sig.type, hash });
  save();
  log(`${LIVE_ON ? 'LIVE ' : ''}BUY ${sym} $${usd.toFixed(2)} @ ${px.toPrecision(5)} (${sig.type}, score ${sig.score.toFixed(2)})${hash ? ` via ${via} ${hash.slice(0, 12)}…` : ''}`, 'buy');
}

async function decide() {
  if (S.dayKey !== utcDay()) { S.dayKey = utcDay(); S.dayStart = equity(); S.halted = false; log('New UTC day: daily loss counter reset'); }
  // exits first
  for (const [sym, p] of Object.entries(S.positions)) {
    const px = live.prices[sym]?.price;
    if (!(px > 0)) { if (!p._noPx) { log(`No price for held ${sym} this tick: exit checks skipped for it.`, 'risk'); p._noPx = true; } continue; }
    p._noPx = false; p.peak = Math.max(p.peak, px);
    const ret = px / p.entry - 1, fromPeak = px / p.peak - 1, age = (now() - p.openedAt) / 3600e3;
    if (ret <= CFG.stopLoss) await sell(sym, 'stop-loss');
    else if (ret >= CFG.takeProfit) await sell(sym, 'take-profit');
    else if (p.peak / p.entry - 1 >= CFG.trailActivate && fromPeak <= -CFG.trailStop) await sell(sym, 'trailing stop');
    else if (age >= CFG.timeStopHours && ret < 0.02) await sell(sym, 'time stop');
  }
  if (LIVE_ON && (L.stopped() || L.halted())) {
    if (!S._stopLogged) { log(L.stopped() ? 'STOP file present: no new entries (open positions still managed).' : 'Too many failed live trades: new entries halted. Check the log, then restart.', 'risk'); S._stopLogged = true; }
    return;
  }
  S._stopLogged = false;
  const eq = equity();
  if (!S.halted && eq / S.dayStart - 1 <= CFG.dailyLossHalt) { S.halted = true; log(`Daily loss limit hit (${((eq / S.dayStart - 1) * 100).toFixed(1)}%). No new entries until next UTC day.`, 'risk'); }
  if (S.halted || Object.keys(S.positions).length >= CFG.maxOpen) return;
  await updateRegime();
  if (CFG.regimeDays && regime.ok !== true) return; // downtrend (or unknown): stay in cash
  const cands = WATCHLIST.filter(w => !S.positions[w.sym] && !(S.cooldown[w.sym] > now()) && (!LIVE_ON || L.tradable(w.sym)))
    .filter(w => live.prices[w.sym]?.price > 0).map(w => ({ sym: w.sym, sig: signal(live.prices[w.sym]) })).filter(c => c.sig).sort((a, b) => b.sig.score - a.sig.score);
  if (!cands.length) return;
  const best = cands[0], room = S.cash - eq * CFG.cashReserve;
  let size = Math.min(eq * CFG.maxPositionPct, room);
  if (LIVE_ON) size = Math.min(size, L.maxTradeUsd(best.sym));
  if (size >= (LIVE_ON ? 5 : 25)) await buy(best.sym, size, best.sig);
}

let ticking = false;
async function tick() {
  if (ticking || shuttingDown) return; // a slow swap can outlast the tick interval; never run two decision cycles at once
  ticking = true;
  try { await tickInner(); lastTickOk = now(); } catch (e) { log('Tick error: ' + e.message, 'risk'); } finally { ticking = false; }
}
async function tickInner() {
  const r = await fetchPrices();
  live.prices = r.prices; live.source = r.source; live.updated = now();
  fetchChain();
  if (r.source.startsWith('SNAPSHOT')) { if (!S._warned) { log('No live price feed reachable. Showing snapshot; trading paused.', 'risk'); S._warned = true; } }
  else {
    S._warned = false;
    if (LIVE_ON) { try { S.cash = Math.min(S.cash, await L.usdcBalance()); } catch (e) { log('Live: could not read USDC balance, skipping this tick', 'risk'); save(); return; } }
    await decide();
    S.equity.push([now(), equity()]); S.equity = S.equity.slice(-1500);
  }
  save();
}

// ---------- server ----------
function apiState() {
  const eq = equity(), sells = S.trades.filter(t => t.side === 'SELL'), wins = sells.filter(t => t.pnl > 0);
  return {
    mode: CFG.mode, stopped: fs.existsSync(STOP_FILE), caps: LIVE_ON ? { total: LCFG.maxTotalUsd, trade: LCFG.maxTradeUsd } : null, source: live.source, updated: live.updated, tickSeconds: CFG.tickSeconds, halted: S.halted,
    wallet: { address: wallet.address, network: 'Base (8453)', chain: live.chain },
    paper: { cash: S.cash, equity: eq, start: S.startEquity, pnl: eq - S.startEquity, pnlPct: (eq / S.startEquity - 1) * 100, dayPct: (eq / S.dayStart - 1) * 100, trades: sells.length, winRate: sells.length ? wins.length / sells.length * 100 : null },
    regime: CFG.regimeDays ? { ok: regime.ok, btc: regime.btc, sma: regime.sma, days: CFG.regimeDays } : null,
    risk: { maxPositionPct: Math.round(CFG.maxPositionPct * 100), stopLoss: Math.round(CFG.stopLoss * 100), takeProfit: Math.round(CFG.takeProfit * 100), trailing: Math.round(CFG.trailStop * 100), dailyHalt: Math.round(CFG.dailyLossHalt * 100), reserve: Math.round(CFG.cashReserve * 100), maxOpen: CFG.maxOpen },
    watchlist: WATCHLIST.map((w, i) => { const d = live.prices[w.sym] || {}, p = S.positions[w.sym], sg = d.price ? signal(d) : null;
      return { rank: i + 1, sym: w.sym, name: w.name, tier: w.tier, ...d, signal: sg && sg.type, pos: p ? { qty: p.qty, entry: p.entry, value: p.qty * d.price, pnlPct: (d.price / p.entry - 1) * 100 } : null }; }),
    scan: scanner ? scanner.api() : null,
    equity: S.equity.slice(-300), trades: S.trades.slice(0, 25), log: S.log.slice(0, 30),
  };
}

const crypto = require('crypto');
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
const safeEq = (x, y) => crypto.timingSafeEqual(sha(x), sha(y));
const COOKIE_VAL = DASH_TOKEN ? sha(DASH_TOKEN).toString('hex') : ''; // the cookie holds a hash, never the token itself
const cookieOf = (req, k) => ((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(p => p[0] === k) || [])[1] || '';
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
// Brute-force guard: 10 wrong tokens per 5 minutes per client, then 429. Behind Railway's proxy the client is the last X-Forwarded-For entry.
const fails = new Map();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
const blocked = (ip) => { const f = fails.get(ip); return !!f && f.n >= 10 && now() - f.t < 300e3; };
const noteFail = (ip) => { const f = fails.get(ip); if (!f || now() - f.t >= 300e3) fails.set(ip, { n: 1, t: now() }); else f.n++; if (fails.size > 1000) fails.clear(); };
let lastTickOk = 0, shuttingDown = false;
function handle(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (req.url === '/health') { // unauthenticated, reveals nothing sensitive; used by Railway healthcheck
    const age = lastTickOk ? Math.round((now() - lastTickOk) / 1000) : null;
    res.writeHead(shuttingDown ? 503 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: !shuttingDown, mode: CFG.mode, lastTickAgeSec: age }));
  }
  if (DASH_TOKEN) { // everything else needs the token (Bearer header, cookie, or one-time ?token= which sets a cookie)
    const ip = clientIp(req);
    if (blocked(ip)) { res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '300' }); return res.end('too many attempts'); }
    const u = new URL(req.url, 'http://x'), q = u.searchParams.get('token');
    let ck = ''; try { ck = decodeURIComponent(cookieOf(req, 'agent_auth')); } catch (e) {}
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    const okAuth = (bearer && safeEq(bearer, DASH_TOKEN)) || (q && safeEq(q, DASH_TOKEN)) || (ck && safeEq(ck, COOKIE_VAL));
    if (!okAuth) { noteFail(ip); res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('unauthorized: open the dashboard once with ?token=YOUR_DASH_TOKEN'); }
    if (q && req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : ''; // plain-http localhost still works
      res.writeHead(302, { 'set-cookie': `agent_auth=${COOKIE_VAL}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=2592000`, location: u.pathname }); return res.end();
    }
  }
  if (req.method === 'POST' && req.headers['x-agent'] !== '1') { res.writeHead(403); return res.end('forbidden'); }
  if (req.method === 'POST' && req.url === '/api/stop') { fs.writeFileSync(STOP_FILE, 'stopped from dashboard ' + new Date().toISOString()); log('Kill switch pressed: no new entries.', 'risk'); res.writeHead(200); return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/api/resume') { try { fs.unlinkSync(STOP_FILE); } catch (e) {} log('Kill switch cleared.'); res.writeHead(200); return res.end('ok'); }
  if (req.url.startsWith('/api/state')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(apiState())); }
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, buf) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(buf); });
}
// A throw inside a request handler must never take the trading process down.
const server = http.createServer((req, res) => {
  try { handle(req, res); } catch (e) { console.error('request error: ' + e.message); try { if (!res.headersSent) res.writeHead(500); res.end('error'); } catch (e2) {} }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;

async function startup() {
  if (LIVE_ON) {
    const fail = (m) => { console.error('\nLIVE MODE REFUSED TO START: ' + m + '\n(Nothing was traded. Remove LIVE=1 to run in paper mode.)\n'); process.exit(1); };
    if (!LCFG.confirmed) fail('set LIVE_CONFIRM=I_UNDERSTAND_THIS_USES_REAL_MONEY to confirm.');
    try { require.resolve('viem'); } catch (e) { fail('run "npm install viem" first.'); }
    const pk = wallet.privateKey;
    L = createLive({ privateKey: pk, address: wallet.address, cfg: { ...LCFG, stopFile: STOP_FILE }, log });
    let pre;
    try { pre = await L.preflight(); } catch (e) { fail(e.message); }
    const usdc = await L.usdcBalance();
    if (usdc < 10) fail(`wallet has $${usdc.toFixed(2)} USDC on Base. Fund ${wallet.address} with USDC (and a little ETH for gas) first.`);
    if (!fs.existsSync(STATE_FILE)) { const b = Math.min(usdc, LCFG.maxTotalUsd); S.cash = S.startEquity = S.dayStart = b; log(`Live bankroll set to $${b.toFixed(2)} (cap $${LCFG.maxTotalUsd}, wallet has $${usdc.toFixed(2)}).`); }
  }
  server.listen(CFG.port, HOST, () => {
    console.log(`\nDashboard: http://localhost:${CFG.port}\nWallet:    ${wallet.address} (Base)\nMode:      ${CFG.mode.toUpperCase()}${LIVE_ON ? `  (cap $${LCFG.maxTotalUsd} total, $${LCFG.maxTradeUsd} per trade; create a file named STOP to halt entries)` : ''}\n`);
    if (wallet.created) log('Agent wallet created. Private key stored in wallet.json (chmod 600). Back it up; never share it.');
    tick(); tickTimer = setInterval(tick, CFG.tickSeconds * 1000);
    try {
      // Scanner coins trade with real money only with BOTH opt-ins; otherwise the scanner stays paper-only.
      let exec = null;
      if (LIVE_ON && process.env.SCAN_LIVE === '1') {
        if (process.env.SCAN_LIVE_CONFIRM === 'I_ACCEPT_SCANNER_COINS_CAN_GO_TO_ZERO') {
          const routers = LCFG.routers.filter(r => r !== 'delta'); // gasless intents are for liquid majors; tiny tokens use the direct aggregators
          exec = { routers: routers.length ? routers : ['velora', 'kyber'],
            register: (k, addr, sym) => L.registerToken(k, addr, sym), forget: (k) => L.forgetToken(k), probeSell: (k, h) => L.probeSell(k, h), usdc: () => L.usdcBalance(),
            buy: (k, usd, px, o) => L.buy(k, usd, px, { ...o, scanner: true }), sell: (k, q, px, o) => L.sell(k, q, px, { ...o, scanner: true }) };
          log('Scanner LIVE sleeve ENABLED: real money, tiny caps. Scanner coins can go to zero.', 'risk');
        } else log('SCAN_LIVE=1 ignored: also set SCAN_LIVE_CONFIRM=I_ACCEPT_SCANNER_COINS_CAN_GO_TO_ZERO. Scanner stays paper-only.', 'risk');
      } else if (process.env.SCAN_LIVE === '1') log('SCAN_LIVE=1 ignored: it only works together with LIVE=1.', 'risk');
      scanner = createScanner({ dir: DATA_DIR, log, exec });
      scanner.start().catch((e) => log('Scanner failed to start: ' + e.message, 'risk'));
    } catch (e) { log('Scanner failed to start: ' + e.message, 'risk'); }
  });
}
let tickTimer = null;
let scanner = null;
// Graceful shutdown: Railway sends SIGTERM on every redeploy. Never die in the middle of a swap.
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`${sig}: finishing in-flight work, then exiting`);
  clearInterval(tickTimer);
  if (scanner) await scanner.stop();
  const t0 = now(); while (ticking && now() - t0 < (+process.env.SHUTDOWN_WAIT_SEC || 60) * 1000) await new Promise(r => setTimeout(r, 250));
  try { save(); } catch (e) {}
  server.close(); process.exit(ticking ? 1 : 0);
}
process.on('unhandledRejection', (e) => console.error('unhandled rejection: ' + (e && e.message || e)));
process.on('uncaughtException', (e) => { console.error('uncaught exception: ' + (e && e.stack || e)); process.exit(1); }); // Railway restarts us; state is saved after every fill
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
startup();
