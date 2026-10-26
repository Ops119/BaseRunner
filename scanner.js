// New-coin scanner for Base: finds fresh pools with market cap under ~$20k, runs strict safety screens,
// and tracks the survivors in a tiny PAPER-ONLY sleeve. It never touches the wallet and never trades live.
// Data: GeckoTerminal (pools, free) and GoPlus (contract security, free). Zero dependencies.
const fs = require('fs');
const path = require('path');

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DEAD = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const lc = (s) => String(s || '').toLowerCase();

function scanConfig(env = process.env) {
  return {
    enabled: env.SCAN !== 'off',
    intervalSec: +env.SCAN_INTERVAL_SEC || 300,
    maxMc: +env.SCAN_MAX_MC || 20000, minMc: +env.SCAN_MIN_MC || 3000,
    minLiq: +env.SCAN_MIN_LIQ || 3000,
    minAgeMin: 15, maxAgeHr: 48,
    maxTax: 0.08, minHolders: 40, maxTopHolder: 0.15, maxCreator: 0.10, minLpLocked: 0.80,
    minBuyers1h: 8, maxPump1h: 150, minDump1h: -30, minSellBuyRatio: 0.3,
    confirmations: 2,                                  // must pass this many scans in a row before the sleeve may enter
    budget: +env.SCAN_BUDGET_USD || 30, perTrade: +env.SCAN_TRADE_USD || 10, maxOpen: 3,
    stop: -0.30, takeProfit: 1.0, trailArm: 0.5, trailDrop: 0.25, timeHr: 12, rugLiqDrop: 0.5,
    poolFee: 0.01, extraBuySlip: 0.03, extraSellSlip: 0.05,   // deliberately pessimistic fills
    gecko: env.GECKO_URL || 'https://api.geckoterminal.com/api/v2/networks/base',
    goplus: env.GOPLUS_URL || 'https://api.gopluslabs.io/api/v1/token_security/8453',
  };
}

// ---------- parsing ----------
function parsePools(json) {
  const tok = {};
  for (const inc of json.included || []) if (inc.type === 'token') tok[inc.id] = inc.attributes || {};
  return (json.data || []).map((p) => {
    const a = p.attributes || {}, rel = p.relationships || {};
    const bid = rel.base_token?.data?.id || '', qid = rel.quote_token?.data?.id || '';
    return {
      pool: lc(a.address), name: a.name, created: Date.parse(a.pool_created_at),
      base: lc(tok[bid]?.address || bid.split('_')[1]), sym: tok[bid]?.symbol || (a.name || '').split(' / ')[0],
      quote: lc(tok[qid]?.address || qid.split('_')[1]), dex: rel.dex?.data?.id || '',
      mc: num(a.market_cap_usd), fdv: num(a.fdv_usd), liq: num(a.reserve_in_usd), price: num(a.base_token_price_usd),
      vol24: num(a.volume_usd?.h24), ch1h: num(a.price_change_percentage?.h1), ch24: num(a.price_change_percentage?.h24),
      tx1h: a.transactions?.h1 || null,
    };
  }).filter((p) => /^0x[0-9a-f]{40}$/.test(p.base) && /^0x[0-9a-f]{40}$/.test(p.pool));
}

// ---------- screens ----------
// Cheap market screen. Returns list of reasons the pool is rejected (empty = passes).
function screenMarket(p, c, now = Date.now()) {
  const why = [];
  if (p.quote !== WETH && p.quote !== USDC) why.push('quote token is not WETH/USDC');
  const mc = p.mc ?? p.fdv;                       // market cap is null for unverified tokens; FDV is the upper bound
  if (mc == null) why.push('no market cap or FDV');
  else if (mc > c.maxMc) why.push(`market cap $${Math.round(mc)} above limit`);
  else if (mc < c.minMc) why.push(`market cap $${Math.round(mc)} below floor`);
  if (p.price == null || p.price <= 0) why.push('no price');
  if (p.liq == null || p.liq < c.minLiq) why.push(`liquidity $${Math.round(p.liq || 0)} below $${c.minLiq}`);
  const ageMin = (now - p.created) / 60000;
  if (!Number.isFinite(ageMin)) why.push('unknown age');
  else if (ageMin < c.minAgeMin) why.push(`too new (${Math.round(ageMin)} min): waiting out the launch window`);
  else if (ageMin > c.maxAgeHr * 60) why.push('older than ' + c.maxAgeHr + 'h');
  const t = p.tx1h;
  if (!t) why.push('no 1h trading data');
  else {
    if ((t.buyers || 0) < c.minBuyers1h) why.push(`only ${t.buyers || 0} buyers in 1h`);
    if ((t.sells || 0) < 3 || (t.sells || 0) < (t.buys || 0) * c.minSellBuyRatio) why.push('almost no sells (honeypot pattern or one-way flow)');
  }
  if (p.ch1h != null && p.ch1h > c.maxPump1h) why.push(`already up ${Math.round(p.ch1h)}% in 1h (not chasing)`);
  if (p.ch1h != null && p.ch1h < c.minDump1h) why.push(`down ${Math.round(p.ch1h)}% in 1h`);
  return why;
}

// Contract screen on a GoPlus record. Anything unknown fails closed.
function screenSecurity(r, p, c) {
  const why = [], warn = [];
  if (!r) return { why: ['no security data (fail closed)'], warn };
  const is1 = (k) => r[k] === '1', not0 = (k) => r[k] !== '0';
  if (r.is_open_source !== '1') why.push('source code not verified');
  if (not0('is_honeypot')) why.push(r.is_honeypot === '1' ? 'HONEYPOT' : 'honeypot status unknown');
  if (is1('cannot_sell_all')) why.push('cannot sell full balance');
  if (is1('cannot_buy')) why.push('cannot buy');
  const bt = num(r.buy_tax), st = num(r.sell_tax);
  if (bt == null || st == null) why.push('tax unknown');
  else { if (bt > c.maxTax) why.push(`buy tax ${(bt * 100).toFixed(0)}%`); if (st > c.maxTax) why.push(`sell tax ${(st * 100).toFixed(0)}%`); }
  const bad = { is_proxy: 'upgradeable proxy', is_mintable: 'owner can mint', hidden_owner: 'hidden owner', can_take_back_ownership: 'ownership can be reclaimed',
    selfdestruct: 'can self-destruct', transfer_pausable: 'owner can pause trading', is_blacklisted: 'has blacklist', is_whitelisted: 'has whitelist',
    trading_cooldown: 'trade cooldown', personal_slippage_modifiable: 'per-wallet tax', slippage_modifiable: 'owner can change tax',
    anti_whale_modifiable: 'limits can be changed', is_airdrop_scam: 'airdrop scam' };
  for (const [k, m] of Object.entries(bad)) if (is1(k)) why.push(m);
  if (r.fake_token && Number(r.fake_token.value) === 1) why.push('counterfeit of a known token');
  const holders = num(r.holder_count);
  if (holders == null || holders < c.minHolders) why.push(`only ${holders ?? '?'} holders`);
  const cp = num(r.creator_percent); if (cp != null && cp > c.maxCreator) why.push(`creator holds ${(cp * 100).toFixed(0)}%`);
  const op = num(r.owner_percent); if (op != null && op > c.maxCreator) why.push(`owner holds ${(op * 100).toFixed(0)}%`);
  // biggest real holder: exclude the pool itself, burn addresses and locked wallets
  if (!Array.isArray(r.holders) || !r.holders.length) why.push('holder list unavailable');
  else {
    const top = r.holders.filter((h) => lc(h.address) !== p.pool && !DEAD.has(lc(h.address)) && h.is_locked !== 1 && h.is_locked !== '1')
      .reduce((m, h) => Math.max(m, num(h.percent) || 0), 0);
    if (top > c.maxTopHolder) why.push(`one wallet holds ${(top * 100).toFixed(0)}%`);
  }
  // liquidity must be burned or locked, otherwise the creator can pull it
  if (!Array.isArray(r.lp_holders) || !r.lp_holders.length) why.push('LP lock cannot be verified');
  else {
    const locked = r.lp_holders.filter((h) => DEAD.has(lc(h.address)) || h.is_locked === 1 || h.is_locked === '1').reduce((s, h) => s + (num(h.percent) || 0), 0);
    if (locked < c.minLpLocked) why.push(`only ${(locked * 100).toFixed(0)}% of liquidity burned/locked`);
  }
  const owner = lc(r.owner_address);
  if (owner && !DEAD.has(owner)) warn.push('owner not renounced');
  if (is1('external_call')) warn.push('makes external calls');
  if (r.other_potential_risks) warn.push(String(r.other_potential_risks).slice(0, 80));
  return { why, warn };
}

function scoreOf(p, warn) {
  const mc = p.mc ?? p.fdv, t = p.tx1h || {};
  const s = Math.min((p.liq || 0) / mc, 1) * 40 + Math.min((t.buyers || 0) / 50, 1) * 30 + (1 - Math.abs(0.5 - (t.buys || 1) / ((t.buys || 1) + (t.sells || 1))) * 2) * 20 + (warn.includes('owner not renounced') ? 0 : 10);
  return Math.round(s);
}

// ---------- scanner ----------
function createScanner({ dir, log, fetchFn = (...a) => fetch(...a), now = () => Date.now(), cfg = scanConfig() }) {
  const file = path.join(dir, 'scan-state.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { st = null; }
  st = Object.assign({ pending: {}, seen: {}, rejected: {}, candidates: [], recentRejects: [], sleeve: null, lastScan: 0, lastError: null, scans: 0 }, st || {});
  if (!st.sleeve) st.sleeve = { cash: cfg.budget, budget: cfg.budget, positions: {}, closed: [], halted: false };
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, file); };
  let busy = false, timer = null, backoffUntil = 0;

  async function getJson(url) {
    const r = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': 'base-agent/2' }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) { backoffUntil = now() + 5 * 60e3; throw new Error('rate limited (429), backing off 5 min'); }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
    return r.json();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function refreshPools(addrs) {
    const out = [];
    for (let i = 0; i < addrs.length; i += 30) {
      const j = await getJson(`${cfg.gecko}/pools/multi/${addrs.slice(i, i + 30).join(',')}?include=base_token`);
      out.push(...parsePools(j));
    }
    return out;
  }

  async function securityOf(token) {
    const j = await getJson(`${cfg.goplus}?contract_addresses=${token}`);
    return j?.result?.[token] || j?.result?.[Object.keys(j?.result || {})[0]] || null;
  }

  // ----- paper sleeve -----
  function sleeveEquity(marks) {
    const s = st.sleeve; let v = s.cash;
    for (const p of Object.values(s.positions)) v += p.qty * (marks[p.pool]?.price ?? p.last ?? p.entry) * (1 - p.exitHaircut);
    return v;
  }
  function closePos(key, p, px, liq, why) {
    const s = st.sleeve, gross = p.qty * px, impact = Math.min(gross / Math.max((liq || p.liq0) / 2, 1), 0.9);
    const net = gross * (1 - impact - cfg.extraSellSlip) * (1 - cfg.poolFee);
    s.cash += Math.max(net, 0); delete s.positions[key];
    const pnl = net - p.usd;
    s.closed.unshift({ t: now(), sym: p.sym, token: p.token, usd: p.usd, net, pnlPct: (net / p.usd - 1) * 100, why });
    s.closed = s.closed.slice(0, 40);
    log(`Scanner sleeve (paper): sold ${p.sym} (${why}) ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'sell' : 'risk');
  }
  function manage(marks, haveData) {
    const s = st.sleeve;
    for (const [key, p] of Object.entries(s.positions)) {
      const m = marks[p.pool];
      if (!m || m.price == null) {
        p.missing = (p.missing || 0) + 1;
        if (haveData && p.missing >= 3) { s.closed.unshift({ t: now(), sym: p.sym, token: p.token, usd: p.usd, net: 0, pnlPct: -100, why: 'pool vanished (rug)' }); delete s.positions[key]; log(`Scanner sleeve (paper): ${p.sym} pool disappeared, written off`, 'risk'); }
        continue;
      }
      p.missing = 0; p.last = m.price; p.peak = Math.max(p.peak, m.price);
      const ret = m.price / p.entry - 1, age = (now() - p.openedAt) / 3600e3;
      if (m.liq != null && m.liq < p.liq0 * (1 - cfg.rugLiqDrop)) closePos(key, p, m.price, m.liq, 'liquidity pulled');
      else if (ret <= cfg.stop) closePos(key, p, m.price, m.liq, 'stop-loss');
      else if (ret >= cfg.takeProfit) closePos(key, p, m.price, m.liq, 'take-profit');
      else if (p.peak / p.entry - 1 >= cfg.trailArm && m.price / p.peak - 1 <= -cfg.trailDrop) closePos(key, p, m.price, m.liq, 'trailing stop');
      else if (age >= cfg.timeHr) closePos(key, p, m.price, m.liq, 'time stop');
    }
    if (!s.halted && sleeveEquity(marks) < s.budget * 0.5) { s.halted = true; log('Scanner sleeve (paper) lost half its budget: no new entries until you reset scan-state.json.', 'risk'); }
  }
  function maybeEnter(cands, marks) {
    const s = st.sleeve;
    if (s.halted || Object.keys(s.positions).length >= cfg.maxOpen) return;
    const recent = new Set(s.closed.filter((x) => now() - x.t < 24 * 3600e3).map((x) => x.token));   // no revenge re-entry for 24h
    const c = cands.find((x) => x.confirmed && !s.positions[x.token] && !recent.has(x.token));
    if (!c) return;
    const usd = Math.min(cfg.perTrade, s.cash);
    if (usd < 3) return;
    const impact = usd / (c.liq / 2), fill = c.price * (1 + impact + cfg.extraBuySlip);
    const qty = usd * (1 - cfg.poolFee) / fill;
    s.cash -= usd;
    s.positions[c.token] = { token: c.token, pool: c.pool, sym: c.sym, entry: fill, qty, usd, openedAt: now(), peak: fill, liq0: c.liq, last: c.price, exitHaircut: cfg.extraSellSlip + cfg.poolFee };
    log(`Scanner sleeve (paper): bought $${usd.toFixed(2)} of ${c.sym} at MC $${Math.round(c.mc)}, liquidity $${Math.round(c.liq)} (screens passed ${c.passes}x)`, 'buy');
  }

  async function scanOnce() {
    if (busy || now() < backoffUntil) return;
    busy = true;
    try {
      // 1) discover newest pools, add to the pending watch list
      const fresh = [];
      for (const page of [1, 2]) { fresh.push(...parsePools(await getJson(`${cfg.gecko}/new_pools?include=base_token&page=${page}`))); await sleep(300); }
      const byPool = {};
      for (const p of fresh) { byPool[p.pool] = p; if (!st.pending[p.pool]) st.pending[p.pool] = { first: now(), token: p.base }; }
      // 2) refresh everything we are watching that the new-pools pages did not just give us
      const stale = Object.keys(st.pending).filter((a) => !byPool[a]);
      const open = Object.values(st.sleeve.positions).map((p) => p.pool).filter((a) => !byPool[a] && !stale.includes(a));
      const need = [...new Set([...stale, ...open])];
      let refreshed = [];
      if (need.length) refreshed = await refreshPools(need);
      const data = {}; for (const p of [...fresh, ...refreshed]) data[p.pool] = p;
      // 3) manage the sleeve with fresh marks before looking for new entries
      manage(data, true);
      // 4) screen
      const cands = [], rejects = [];
      let secCalls = 0;
      for (const [addr, meta] of Object.entries(st.pending)) {
        const p = data[addr];
        if (!p) { if (now() - meta.first > cfg.maxAgeHr * 3600e3) delete st.pending[addr]; continue; }
        const age = (now() - p.created) / 3600e3;
        if (age > cfg.maxAgeHr || (p.mc ?? p.fdv ?? 0) > cfg.maxMc * 3) { delete st.pending[addr]; delete st.seen[p.base]; continue; }
        const rj = st.rejected[p.base];
        if (rj && rj.hard && now() - rj.t < 24 * 3600e3) continue;               // known-bad contract, do not re-check
        let why = screenMarket(p, cfg, now());
        let warn = [];
        if (!why.length) {
          // market screen passed: now the contract screen (cached 1h, capped per scan)
          let sec = meta.sec && now() - meta.secAt < 3600e3 ? meta.sec : undefined;
          if (sec === undefined && secCalls < 8) {
            try { sec = await securityOf(p.base); meta.sec = sec; meta.secAt = now(); secCalls++; await sleep(400); }
            catch (e) { why = ['security check unavailable: ' + e.message]; sec = undefined; }
          }
          if (!why.length) {
            if (sec === undefined) why = ['security check queued'];
            else { const r = screenSecurity(sec, p, cfg); why = r.why; warn = r.warn; if (why.length) st.rejected[p.base] = { t: now(), hard: true, why }; }
          }
        }
        const mc = p.mc ?? p.fdv;
        if (why.length) {
          delete st.seen[p.base];
          if (!why[0].startsWith('too new') && !why[0].includes('queued')) rejects.push({ sym: p.sym, token: p.base, mc, why: why.slice(0, 3), t: now() });
        } else {
          const sn = st.seen[p.base] = st.seen[p.base] || { n: 0 };
          sn.n++; sn.last = now();
          cands.push({ token: p.base, pool: p.pool, sym: p.sym, dex: p.dex, mc, usedFdv: p.mc == null, liq: p.liq, price: p.price, ch1h: p.ch1h, buyers1h: p.tx1h?.buyers, ageMin: Math.round((now() - p.created) / 60000), warn, score: scoreOf(p, warn), passes: sn.n, confirmed: sn.n >= cfg.confirmations });
        }
      }
      cands.sort((a, b) => b.score - a.score);
      st.candidates = cands.slice(0, 15);
      st.recentRejects = [...rejects, ...st.recentRejects].slice(0, 12);
      // 5) entry (paper sleeve)
      maybeEnter(cands, data);
      for (const k of Object.keys(st.rejected)) if (now() - st.rejected[k].t > 24 * 3600e3) delete st.rejected[k];
      const keep = Object.entries(st.pending).sort((a, b) => b[1].first - a[1].first).slice(0, 90);
      st.pending = Object.fromEntries(keep);
      st.lastScan = now(); st.lastError = null; st.scans++;
      st.lastStats = { watched: Object.keys(st.pending).length, passed: cands.length, rejectedNow: rejects.length };
    } catch (e) {
      st.lastError = e.message; log('Scanner: ' + e.message, 'risk');
    } finally { busy = false; try { save(); } catch (e) {} }
  }

  return {
    scanOnce, cfg,
    start() { if (!cfg.enabled) return; setTimeout(scanOnce, 5000); timer = setInterval(scanOnce, cfg.intervalSec * 1000); },
    async stop() { clearInterval(timer); const t0 = now(); while (busy && now() - t0 < 20000) await sleep(200); },
    api() {
      const s = st.sleeve, marks = {};
      for (const p of Object.values(s.positions)) marks[p.pool] = { price: p.last };
      const eq = sleeveEquity(marks);
      return {
        enabled: cfg.enabled, lastScan: st.lastScan, lastError: st.lastError, stats: st.lastStats || null,
        limits: { maxMc: cfg.maxMc, minLiq: cfg.minLiq, minLpLocked: Math.round(cfg.minLpLocked * 100), maxTax: Math.round(cfg.maxTax * 100) },
        candidates: st.candidates, rejects: st.recentRejects.slice(0, 6),
        sleeve: { budget: s.budget, equity: eq, pnl: eq - s.budget, halted: s.halted, perTrade: cfg.perTrade,
          open: Object.values(s.positions).map((p) => ({ sym: p.sym, usd: p.usd, pnlPct: ((p.last || p.entry) * (1 - p.exitHaircut) / p.entry - 1) * 100, ageH: (now() - p.openedAt) / 3600e3 })),
          closed: s.closed.slice(0, 6) },
      };
    },
  };
}

module.exports = { createScanner, scanConfig, parsePools, screenMarket, screenSecurity };
