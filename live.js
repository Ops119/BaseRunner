// Live execution on Base. Swap routing: Velora (primary, no API key) with KyberSwap (backup). Needs: npm install viem
// Every guard below exists because this moves real money. Do not remove them to "make it trade more".
const fs = require('fs');
const path = require('path');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

// Routers we will ever approve or send to. Both confirmed on the providers' own docs (Base, chain 8453).
// Any quote pointing somewhere else is rejected, so a compromised or buggy API response cannot redirect funds.
const AUGUSTUS_V62 = '0x6a000f20005980200259b80c5102003040001068';   // Velora (same address on every chain)
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';   // KyberSwap MetaAggregationRouterV2 on Base
const DELTA = '0x0000000000bbf5c5fd284e657f01bd000933c96d';          // Velora Delta settlement contract (same on every Delta chain; Base is supported)
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// EIP-712 primary type = the struct no other struct refers to (docs don't name it; falls back to 'Order').
function primaryType(types) {
  const names = Object.keys(types).filter(n => n !== 'EIP712Domain');
  const refd = new Set();
  for (const n of names) for (const f of types[n]) refd.add(String(f.type).replace(/\[\d*\]$/, ''));
  const roots = names.filter(n => !refd.has(n));
  if (roots.length === 1) return roots[0];
  if (names.includes('Order')) return 'Order';
  throw new Error('cannot determine EIP-712 primary type');
}
// Delta wants ERC-2098 compact (64-byte) signatures; viem returns 65 bytes (r, s, v).
function compactSig(sig) {
  const h = sig.replace(/^0x/, '');
  if (h.length === 128) return '0x' + h;
  const r = h.slice(0, 64), s = BigInt('0x' + h.slice(64, 128)), v = parseInt(h.slice(128, 130), 16);
  const yParity = (v === 28 || v === 1) ? 1n : 0n;
  return '0x' + r + (s | (yParity << 255n)).toString(16).padStart(64, '0');
}

// Contracts from CoinMarketCap explorer links (Basescan). Preflight re-checks symbol() on chain and disables any mismatch.
// LINK has no verified Base address yet: set LINK_ADDRESS yourself after checking Basescan, otherwise LINK stays paper-only.
const TOKENS = {
  ETH:     { addr: WETH,                                         symbol: 'WETH',   dev: 0.06, bps: 100, size: 1.0 },
  BTC:     { addr: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC',  dev: 0.06, bps: 100, size: 1.0 },
  LINK:    { addr: process.env.LINK_ADDRESS || null,             symbol: 'LINK',   dev: 0.10, bps: 200, size: 1.0 },
  MORPHO:  { addr: '0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842', symbol: 'MORPHO', dev: 0.10, bps: 200, size: 1.0 },
  AERO:    { addr: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO',   dev: 0.10, bps: 200, size: 1.0 },
  VIRTUAL: { addr: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL',dev: 0.12, bps: 250, size: 1.0 },
  BRETT:   { addr: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT',  dev: 0.15, bps: 400, size: 0.5 },
  DEGEN:   { addr: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN',  dev: 0.15, bps: 400, size: 0.5 },
};

const ERC20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

function liveConfig() {
  const known = ['delta', 'velora', 'kyber'];
  const routers = (process.env.SWAP_ROUTERS || 'delta,velora,kyber').split(',').map(s => s.trim().toLowerCase()).filter(s => known.includes(s));
  return {
    enabled: process.env.LIVE === '1',
    confirmed: process.env.LIVE_CONFIRM === 'I_UNDERSTAND_THIS_USES_REAL_MONEY',
    routers: routers.length ? routers : known,             // order = priority; first is primary, rest are backups
    veloraBase: process.env.VELORA_BASE || 'https://api.velora.xyz',   // free, no key (docs: 1 req/s, 5,000/day)
    kyberBase: process.env.KYBER_BASE || 'https://aggregator-api.kyberswap.com', // legacy open endpoint, rate limited
    kyberKey: process.env.KYBER_API_KEY || '',             // optional: higher limits via Kyber's gateway
    rpc: process.env.BASE_RPC || 'https://mainnet.base.org',
    maxTotalUsd: +process.env.LIVE_MAX_USD || 100,         // hard cap on capital the agent may ever use
    maxTradeUsd: +process.env.LIVE_MAX_TRADE_USD || 25,    // hard cap per swap
    minGasEth: 0.0005,
    maxConsecutiveFails: 3,
    // Gasless (Delta) settings. The solver pays swap gas; one-time approvals still use a little ETH, so we approve
    // enough for N trades (bounded: USDC never above LIVE_MAX_USD) and only to the verified Delta contract.
    approvalTrades: +process.env.GASLESS_APPROVAL_TRADES || 5,
    deltaTtlSec: +process.env.DELTA_TTL_SEC || 90,       // order is unfillable after this, so a missed fill cannot land late
    deltaPollMs: +process.env.DELTA_POLL_MS || 2000,
  };
}

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  let j = {}; try { j = await r.json(); } catch (e) { /* non-JSON error body */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${String(j.error || j.message || '').slice(0, 120)}`.trim());
  return j;
}

// Each provider returns a normalised quote: { spender, to, data, value, gas?, expectedOut, minOut } (outputs in raw units).
// c = { sell, buy, sellAmount (BigInt), sellDec, buyDec, bps, taker, cfg }
const PROVIDERS = {
  velora: async (c) => {
    const q = new URLSearchParams({ srcToken: c.sell, destToken: c.buy, amount: c.sellAmount.toString(), srcDecimals: String(c.sellDec), destDecimals: String(c.buyDec),
      side: 'SELL', network: '8453', slippage: String(c.bps), userAddress: c.taker, version: '6.2', partner: 'base-agent' });
    const j = await getJson(`${c.cfg.veloraBase}/swap?${q}`);
    const pr = j.priceRoute, tx = j.txParams;
    if (!pr || !tx || !tx.to || !tx.data) throw new Error('no route');
    if (!same(tx.to, AUGUSTUS_V62) || (pr.contractAddress && !same(pr.contractAddress, AUGUSTUS_V62))) throw new Error(`unexpected router ${tx.to}`);
    if (tx.chainId != null && Number(tx.chainId) !== 8453) throw new Error('quote is for another chain');
    const expectedOut = BigInt(pr.destAmount);
    return { spender: AUGUSTUS_V62, to: tx.to, data: tx.data, value: BigInt(tx.value || 0), gas: undefined, expectedOut, minOut: (expectedOut * BigInt(10000 - c.bps)) / 10000n };
  },
  kyber: async (c) => {
    const base = c.cfg.kyberKey ? 'https://api.kyberswap.com/swap/base/api/v1' : `${c.cfg.kyberBase}/base/api/v1`;
    const h = { 'X-Client-Id': 'base-agent', ...(c.cfg.kyberKey ? { 'X-Api-Key': c.cfg.kyberKey } : {}) };
    const r = await getJson(`${base}/routes?${new URLSearchParams({ tokenIn: c.sell, tokenOut: c.buy, amountIn: c.sellAmount.toString() })}`, { headers: h });
    const rs = r.data && r.data.routeSummary;
    if (!rs) throw new Error(`no route (${r.message || r.code || '?'})`);
    const b = await getJson(`${base}/route/build`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ routeSummary: rs, sender: c.taker, recipient: c.taker, slippageTolerance: c.bps }) });
    const d = b.data;
    if (!d || !d.data || !d.routerAddress) throw new Error(`build failed (${b.message || b.code || '?'})`);
    if (!same(d.routerAddress, KYBER_ROUTER)) throw new Error(`unexpected router ${d.routerAddress}`);
    const expectedOut = BigInt(d.amountOut);
    return { spender: KYBER_ROUTER, to: d.routerAddress, data: d.data, value: BigInt(d.transactionValue || 0), gas: d.gas ? BigInt(d.gas) : undefined, expectedOut, minOut: (expectedOut * BigInt(10000 - c.bps)) / 10000n };
  },
};

function createLive({ privateKey, address, cfg, log, viemLib }) {
  const V = viemLib || require('viem');
  const { createPublicClient, createWalletClient, http, getAddress } = V;
  const { privateKeyToAccount } = viemLib ? viemLib.accounts : require('viem/accounts');
  const { base } = viemLib ? viemLib.chains : require('viem/chains');
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error('wallet address does not match its private key');
  const pub = createPublicClient({ chain: base, transport: http(cfg.rpc) });
  const wal = createWalletClient({ account, chain: base, transport: http(cfg.rpc) });
  const ok = {}; // sym -> { decimals }
  const T = { ...TOKENS }; // static watchlist + tokens registered at runtime by the scanner
  let fails = 0;
  // Every swap goes through one queue: two swaps at once would race on nonces and on the USDC allowance.
  let chain = Promise.resolve();
  const locked = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const stopFile = cfg.stopFile || path.join(__dirname, 'STOP'); // must be the same file the dashboard kill switch writes

  const bal = (addr) => pub.readContract({ address: addr, abi: ERC20, functionName: 'balanceOf', args: [account.address] });

  async function preflight() {
    if ((await pub.getChainId()) !== 8453) throw new Error('RPC is not Base mainnet (chainId 8453)');
    const eth = Number(await pub.getBalance({ address: account.address })) / 1e18;
    if (eth < cfg.minGasEth) throw new Error(`Wallet needs at least ${cfg.minGasEth} ETH on Base for gas (has ${eth.toFixed(6)})`);
    const usdcSym = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'symbol' });
    if (usdcSym !== 'USDC') throw new Error('USDC contract check failed');
    for (const [sym, t] of Object.entries(TOKENS)) {
      if (!t.addr) { log(`Live: ${sym} disabled (no verified Base address; set ${sym}_ADDRESS)`, 'risk'); continue; }
      try {
        const [s, d] = await Promise.all([
          pub.readContract({ address: getAddress(t.addr), abi: ERC20, functionName: 'symbol' }),
          pub.readContract({ address: getAddress(t.addr), abi: ERC20, functionName: 'decimals' }),
        ]);
        if (s.toLowerCase() !== t.symbol.toLowerCase()) { log(`Live: ${sym} DISABLED, contract says symbol "${s}" not "${t.symbol}"`, 'risk'); continue; }
        ok[sym] = { decimals: Number(d) };
      } catch (e) { log(`Live: ${sym} disabled, contract check failed (${e.shortMessage || e.message})`, 'risk'); }
    }
    log(`Live preflight passed. Routers: ${cfg.routers.join(' > ')}. Tradable on-chain: ${Object.keys(ok).join(', ') || 'none'}. Gas ETH ${eth.toFixed(5)}.`);
    return { eth, tradable: Object.keys(ok) };
  }

  // GASLESS route: Velora Delta. We sign an EIP-712 order off-chain; a solver settles it and pays the gas.
  // We never sign anything we haven't checked field by field against what we asked for.
  async function deltaSwap(sellToken, buyToken, sellAmount, sellDec, buyDec, bps, minOutHuman) {
    const base = cfg.veloraBase, H = { 'content-type': 'application/json' };
    const qs = new URLSearchParams({ srcToken: sellToken, destToken: buyToken, amount: sellAmount.toString(), srcDecimals: String(sellDec), destDecimals: String(buyDec),
      side: 'SELL', chainId: '8453', mode: 'DELTA', userAddress: account.address, partner: 'base-agent' });
    const quote = await getJson(`${base}/v2/quote?${qs}`);
    const d = quote.delta;
    if (!d || !d.route) throw new Error('no delta route');
    if (!same(d.spender, DELTA)) throw new Error(`unexpected delta spender ${d.spender}`);

    // One-time bounded approval to the verified Delta contract (needs a little ETH; reused for several trades).
    const have = await pub.readContract({ address: getAddress(sellToken), abi: ERC20, functionName: 'allowance', args: [account.address, getAddress(DELTA)] });
    if (have < sellAmount) {
      let amt = same(sellToken, USDC) ? sellAmount * BigInt(cfg.approvalTrades) : sellAmount; // multi-trade allowance only for USDC; other tokens get the exact amount
      if (same(sellToken, USDC)) { const cap = BigInt(Math.floor(cfg.maxTotalUsd * 1e6)); if (amt > cap) amt = cap; }
      if (amt < sellAmount) amt = sellAmount;
      const h = await wal.writeContract({ address: getAddress(sellToken), abi: ERC20, functionName: 'approve', args: [getAddress(DELTA), amt] });
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      if (rc.status !== 'success') throw new Error('delta approve reverted');
      log(`Live: approved Delta contract for ${cfg.approvalTrades} trades' worth (${h.slice(0, 10)}…)`);
    }

    const deadline = Math.floor(Date.now() / 1000) + cfg.deltaTtlSec;
    const built = await getJson(`${base}/v2/delta/orders/build`, { method: 'POST', headers: H,
      body: JSON.stringify({ route: d.route, owner: account.address, deadline, partner: 'base-agent', slippage: bps, permit: '0x' }) });
    const ts = built.toSign;
    if (!ts || !ts.domain || !ts.types || !ts.value) throw new Error('delta build returned no typed data');

    // ---- verify the order before signing ----
    const o = ts.value, dm = ts.domain;
    if (Number(dm.chainId) !== 8453) throw new Error('order is for another chain');
    if (!same(dm.verifyingContract, DELTA)) throw new Error(`order targets unexpected contract ${dm.verifyingContract}`);
    for (const f of ['owner', 'srcToken', 'destToken', 'srcAmount', 'destAmount', 'deadline']) if (o[f] == null) throw new Error(`order missing field ${f}`);
    if (!same(o.owner, account.address)) throw new Error('order owner is not our wallet');
    if (o.beneficiary && !same(o.beneficiary, account.address)) throw new Error('order pays someone else');
    if (!same(o.srcToken, sellToken) || !same(o.destToken, buyToken)) throw new Error('order tokens differ from request');
    if (BigInt(o.srcAmount) !== sellAmount) throw new Error('order sells a different amount');
    const outH = Number(BigInt(o.destAmount)) / 10 ** buyDec;
    if (!(outH >= minOutHuman)) throw new Error(`price guard: order min output ${outH} < required ${minOutHuman.toFixed(6)}`);
    if (Number(o.deadline) > Math.floor(Date.now() / 1000) + cfg.deltaTtlSec + 60) throw new Error('order deadline too far out');
    if (o.partnerAndFee != null && BigInt(o.partnerAndFee) !== 0n) throw new Error('order carries a partner fee');
    if (o.bridge && o.bridge.destinationChainId && ![0, 8453].includes(Number(o.bridge.destinationChainId))) throw new Error('order bridges to another chain');

    const types = { ...ts.types }; delete types.EIP712Domain;
    const sig = compactSig(await wal.signTypedData({ domain: dm, types, primaryType: primaryType(types), message: o }));
    const sub = await getJson(`${base}/v2/delta/orders`, { method: 'POST', headers: H, body: JSON.stringify({ chainId: 8453, order: o, signature: sig, partner: 'base-agent' }) });
    const id = sub.id || sub.orderId;
    if (!id) throw new Error('delta submit returned no order id');

    // Wait for a terminal state. The order cannot fill after its deadline, so once it is dead we may safely fall back.
    const end = Date.now() + (cfg.deltaTtlSec + 20) * 1000;
    while (Date.now() < end) {
      await sleep(cfg.deltaPollMs);
      let st; try { st = (await getJson(`${base}/v2/delta/orders/${id}`)).status; } catch (e) { continue; }
      if (st === 'COMPLETED') return { ref: id, router: 'delta' };
      if (['EXPIRED', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(st)) throw new Error(`delta order ended ${st} (nothing filled)`);
    }
    const e = new Error(`delta order ${id} status unknown after deadline; not retrying elsewhere in case it fills`);
    e.noFallback = true; throw e;
  }

  // Tries each router in priority order. Falls over to the next one on any problem BEFORE a swap is broadcast
  // (API down, no route, bad price, wrong router address, dry-run revert). Once a swap tx is sent, no fallback: it either confirms or the trade fails.
  async function swap(sellToken, buyToken, sellAmount, sellDec, buyDec, bps, minOutHuman, routers = cfg.routers) {
    const errs = [];
    for (let i = 0; i < routers.length; i++) {
      const name = routers[i];
      if (name === 'delta') {
        try {
          const r = await deltaSwap(sellToken, buyToken, sellAmount, sellDec, buyDec, bps, minOutHuman);
          log(`Live: swapped via delta (gasless)`);
          return r;
        } catch (e) {
          if (e.noFallback) throw e;
          errs.push(`delta: ${e.shortMessage || e.message}`);
          log(`Live: delta unusable (${e.shortMessage || e.message})${i < routers.length - 1 ? '; trying next' : ''}`, 'risk');
          continue;
        }
      }
      let q, call;
      try {
        q = await PROVIDERS[name]({ sell: sellToken, buy: buyToken, sellAmount, sellDec, buyDec, bps, taker: account.address, cfg });
        const minOutH = Number(q.minOut) / 10 ** buyDec;
        if (!(minOutH >= minOutHuman)) throw new Error(`price guard: min output ${minOutH} < required ${minOutHuman.toFixed(6)}`);
        if (q.value !== 0n) throw new Error('quote wants ETH value for an ERC20 swap');
        call = { account: account.address, to: getAddress(q.to), data: q.data, value: 0n };
        const have = await pub.readContract({ address: getAddress(sellToken), abi: ERC20, functionName: 'allowance', args: [account.address, getAddress(q.spender)] });
        if (have < sellAmount) {
          const h = await wal.writeContract({ address: getAddress(sellToken), abi: ERC20, functionName: 'approve', args: [getAddress(q.spender), sellAmount] }); // exact amount, never infinite
          const rc = await pub.waitForTransactionReceipt({ hash: h });
          if (rc.status !== 'success') throw new Error('approve reverted');
          log(`Live: approved exact amount to ${name} router (${h.slice(0, 10)}…)`);
        }
        await pub.call(call); // dry-run: throws if it would revert
      } catch (e) {
        errs.push(`${name}: ${e.shortMessage || e.message}`);
        log(`Live: ${name} unusable (${e.shortMessage || e.message})${i < routers.length - 1 ? '; trying backup' : ''}`, 'risk');
        continue;
      }
      const gas = q.gas ? (q.gas * 12n) / 10n : undefined;
      const hash = await wal.sendTransaction({ ...call, gas });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== 'success') throw new Error(`swap reverted on-chain via ${name}: ${hash}`);
      log(`Live: swapped via ${name}${i > 0 ? ' (backup)' : ''}`);
      return { ref: hash, router: name };
    }
    throw new Error('all routers failed: ' + errs.join(' | '));
  }

  const guardFail = (e) => { fails++; log(`Live trade failed (${fails}/${cfg.maxConsecutiveFails}): ${e.message}`, 'risk'); };
  const stopped = () => fs.existsSync(stopFile);

  return {
    preflight, stopped,
    // Serialised entry points (the *_ implementations above are not meant to be called directly).
    buy(...a) { return locked(() => this._buy(...a)); },
    sell(...a) { return locked(() => this._sell(...a)); },

    // Scanner support: tokens discovered at runtime. Only registered after on-chain checks; never touches TOKENS.
    async registerToken(key, addr, symHint) {
      const a = getAddress(addr);
      if (same(a, USDC) || same(a, WETH)) throw new Error('refusing to register USDC/WETH as a scanner token');
      const code = await (pub.getCode ? pub.getCode({ address: a }) : pub.getBytecode({ address: a }));
      if (!code || code === '0x') throw new Error('no contract code at address');
      const [s, d] = await Promise.all([
        pub.readContract({ address: a, abi: ERC20, functionName: 'symbol' }),
        pub.readContract({ address: a, abi: ERC20, functionName: 'decimals' }),
      ]);
      if (Number(d) < 0 || Number(d) > 18) throw new Error('unusual decimals ' + d);
      const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (symHint && norm(s) !== norm(symHint)) throw new Error(`symbol mismatch: chain says "${s}", listing says "${symHint}"`);
      T[key] = { addr: a, symbol: s, dev: 0.15, bps: 1000, size: 1.0 };
      ok[key] = { decimals: Number(d) };
      return { symbol: s, decimals: Number(d) };
    },
    forgetToken(key) { if (!TOKENS[key]) { delete T[key]; delete ok[key]; } },
    // How much USDC would selling `human` tokens return right now? Quote only, nothing is sent. null = no route.
    async probeSell(key, human) {
      const t = T[key], d = ok[key] && ok[key].decimals;
      if (!t || d == null) return null;
      const amt = BigInt(Math.floor(human * 10 ** d));
      if (amt <= 0n) return null;
      try {
        const q = new URLSearchParams({ srcToken: t.addr, destToken: USDC, amount: amt.toString(), srcDecimals: String(d), destDecimals: '6', side: 'SELL', network: '8453', version: '6.2' });
        const pr = (await getJson(`${cfg.veloraBase}/prices?${q}`)).priceRoute;
        if (pr && pr.destAmount && (!pr.contractAddress || same(pr.contractAddress, AUGUSTUS_V62))) return Number(BigInt(pr.destAmount)) / 1e6;
      } catch (e) { /* try the other aggregator */ }
      try {
        const base = cfg.kyberKey ? 'https://api.kyberswap.com/swap/base/api/v1' : `${cfg.kyberBase}/base/api/v1`;
        const h = { 'X-Client-Id': 'base-agent', ...(cfg.kyberKey ? { 'X-Api-Key': cfg.kyberKey } : {}) };
        const r = await getJson(`${base}/routes?${new URLSearchParams({ tokenIn: t.addr, tokenOut: USDC, amountIn: amt.toString() })}`, { headers: h });
        const out = r.data && r.data.routeSummary && r.data.routeSummary.amountOut;
        if (out) return Number(BigInt(out)) / 1e6;
      } catch (e) { /* no route */ }
      return null;
    },
    tradable: (sym) => !!ok[sym],
    maxTradeUsd: (sym) => Math.min(cfg.maxTradeUsd, cfg.maxTradeUsd * T[sym].size),
    halted: () => fails >= cfg.maxConsecutiveFails,
    usdcBalance: async () => Number(await bal(USDC)) / 1e6,
    ethBalance: async () => Number(await pub.getBalance({ address: account.address })) / 1e18,

    // returns { px, qty, usd, hash } or null on failure.
    // On ANY error we re-read balances: if a fill actually landed (e.g. a gasless order that filled while we were
    // timing out), we record it instead of leaving untracked tokens in the wallet.
    async _buy(sym, usd, price, o = {}) {
      const t = T[sym], d = ok[sym].decimals;
      if (stopped()) { log('Live: STOP file present, buy skipped', 'risk'); return null; }
      usd = Math.min(usd, this.maxTradeUsd(sym));
      let before, usdcBefore;
      try {
        before = await bal(getAddress(t.addr)); usdcBefore = await bal(USDC);
        const sellAmount = BigInt(Math.floor(usd * 1e6));
        const expected = usd / price;
        const { ref, router } = await swap(USDC, getAddress(t.addr), sellAmount, 6, d, o.bps ?? t.bps, expected * (1 - (o.dev ?? t.dev)), o.routers);
        const got = Number((await bal(getAddress(t.addr))) - before) / 10 ** d;
        if (got <= 0) throw new Error('swap confirmed but token balance did not increase');
        fails = 0;
        return { px: usd / got, qty: got, usd, hash: ref, router };
      } catch (e) {
        try {
          if (before !== undefined) {
            const got = Number((await bal(getAddress(t.addr))) - before) / 10 ** d;
            if (got > 0) {
              const spent = Number(usdcBefore - (await bal(USDC))) / 1e6;
              const useUsd = spent > 0 ? spent : usd;
              log(`Live: buy errored (${e.message}) but ${got} ${sym} arrived; recording the fill`, 'risk');
              return { px: useUsd / got, qty: got, usd: useUsd, hash: 'recovered', router: 'recovered' };
            }
          }
        } catch (e2) { /* fall through to failure */ }
        if (!o.scanner) guardFail(e); else log(`Live (scanner): trade failed: ${e.message}`, 'risk'); return null;
      }
    },

    async _sell(sym, qtyWanted, price, o = {}) {
      const t = T[sym], d = ok[sym].decimals;
      let usdcBefore, tokBefore, human;
      try {
        const have = await bal(getAddress(t.addr));
        let amt = BigInt(Math.floor(qtyWanted * 10 ** d));
        if (amt > have) amt = have;                      // never try to sell more than the wallet holds
        if (amt <= 0n) throw new Error('nothing to sell on-chain');
        human = Number(amt) / 10 ** d; tokBefore = have;
        usdcBefore = await bal(USDC);
        const { ref, router } = await swap(getAddress(t.addr), USDC, amt, d, 6, o.bps ?? t.bps, human * price * (1 - (o.dev ?? t.dev)), o.routers);
        const got = Number((await bal(USDC)) - usdcBefore) / 1e6;
        fails = 0;
        return { px: got / human, qty: human, usd: got, hash: ref, router };
      } catch (e) {
        try {
          if (usdcBefore !== undefined) {
            const gotUsd = Number((await bal(USDC)) - usdcBefore) / 1e6;
            const sold = Number(tokBefore - (await bal(getAddress(t.addr)))) / 10 ** d;
            if (gotUsd > 0 && sold > 0) {
              log(`Live: sell errored (${e.message}) but $${gotUsd.toFixed(2)} arrived; recording the fill`, 'risk');
              return { px: gotUsd / sold, qty: sold, usd: gotUsd, hash: 'recovered', router: 'recovered' };
            }
          }
        } catch (e2) { /* fall through to failure */ }
        if (!o.scanner) guardFail(e); else log(`Live (scanner): trade failed: ${e.message}`, 'risk'); return null;
      }
    },
  };
}

module.exports = { createLive, liveConfig, TOKENS, AUGUSTUS_V62, KYBER_ROUTER, DELTA };
