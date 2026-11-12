// pumpfun-top5-forecast-01 entry (Node 22, standard library only, no network, fully deterministic).
//
// Model: per-coin log10(cap in SOL) trajectories are read from the marks, extrapolated to the answer-read horizon with
// a damped, shrunk recent velocity plus mean reversion toward the median of the current top 20, and a fixed-seed Monte
// Carlo over every candidate coin's predicted log-cap (independent per-coin noise plus one shared market shock) gives
// P(coin at place k) and the distribution of the cap at each place. Each place keeps part of its mass unnamed for the
// coins born after the cut and for the movers. Nothing about any coin is hardcoded: everything comes from the input.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Tunable constants, on one line so a backtest script can swap them.
const PARAMS = { velWindow: 4, velShrink: 0.8, velCap: 0.5, dampDiv: 4, revDiv: 6, youngPull: 0.05, termCap: 1.0, sigA: 0.25, sigB: 0.1, sigScale: 1.0, youngSig: 0.15, curveSig: 0.1, volCap: 0.2, extraScale: 2, shared0: 0.03, shared1: 0.07, nameSum: 0.68, minP: 0.005, sizeSum: 0.93, sizeKernel: 2, sizeMix: 0.2, sizeA: 0.2, sizeB: 0.1, placeShrink: 0.6, placeCap: 1.0, draws: 8000, candMean: 60, candCap: 30, candMax: 80, seed: 20261112 };
const P = PARAMS;
const MICRO = 1_000_000;

interface Row { rank: number; mint: string; market_cap_lamports: string | number; venue?: string; complete?: boolean; mayhem?: boolean; created_at?: string }
interface Mark { at: string; ok?: boolean; rows: Row[] | null }
interface Task { places: number; output: string; reads: string[]; size: { edges: number[] } }
interface Obs { t: number; y: number }
interface Coin { mint: string; obs: Obs[]; venue: string; lastT: number; lastY: number }

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as Task;
const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '');
const marks = lines.map((l) => JSON.parse(l) as Mark).filter((m) => m.ok !== false && Array.isArray(m.rows));
if (marks.length === 0) throw new Error('the history holds no ok mark');

const HOUR = 3_600_000;
const logCap = (lamports: string | number): number => Math.log10(Number(BigInt(lamports))) - 9;

// Per-coin series.
const coins = new Map<string, Coin>();
let lastMarkT = 0;
let lastRowsT = -Infinity;
for (const m of marks) {
  const t = Date.parse(m.at) / HOUR;
  lastMarkT = Math.max(lastMarkT, t);
  if (m.rows!.length === 0) continue;
  lastRowsT = Math.max(lastRowsT, t);
  for (const r of m.rows!) {
    const y = logCap(r.market_cap_lamports);
    if (!Number.isFinite(y)) continue;
    let c = coins.get(r.mint);
    if (c === undefined) { c = { mint: r.mint, obs: [], venue: r.venue ?? 'curve', lastT: t, lastY: y }; coins.set(r.mint, c); }
    c.obs.push({ t, y });
    c.venue = r.venue ?? c.venue;
    c.lastT = t;
    c.lastY = y;
  }
}
if (coins.size === 0) throw new Error('the history ranks no coin');

// Horizon: mean answer read minus the last mark, in hours (at least a minute).
const reads = (task.reads ?? []).map((s) => Date.parse(s) / HOUR).filter((x) => Number.isFinite(x));
const H = Math.max(reads.length > 0 ? reads.reduce((a, b) => a + b, 0) / reads.length - lastMarkT : 1, 1 / 60);

// Current coins: those ranked at the latest mark that ranked anything.
const current = [...coins.values()].filter((c) => c.lastT === lastRowsT);
const sortedLast = current.map((c) => c.lastY).sort((a, b) => b - a);
const top20 = sortedLast.slice(0, 20);
const med20 = top20.length > 0 ? (top20[Math.floor((top20.length - 1) / 2)]! + top20[Math.floor(top20.length / 2)]!) / 2 : sortedLast[0]!;

const damp = 1 / (1 + H / P.dampDiv);
const revW = H / (H + P.revDiv);
const sigBase = (P.sigA + P.sigB * Math.sqrt(H)) * P.sigScale;
const extraW = H / (H + P.extraScale);
const sharedSd = P.shared0 + P.shared1 * Math.sqrt(H);

interface Cand { mint: string; mean: number; sigma: number; lastY: number }
function forecastCoin(c: Coin): Cand {
  const pts = c.obs.slice(-P.velWindow);
  const n = pts.length;
  let v = 0;
  let resid = 0;
  if (n >= 2) {
    let sw = 0, st = 0, sy = 0;
    pts.forEach((p, i) => { const w = i + 1; sw += w; st += w * p.t; sy += w * p.y; });
    const tm = st / sw, ym = sy / sw;
    let num = 0, den = 0;
    pts.forEach((p, i) => { const w = i + 1; num += w * (p.t - tm) * (p.y - ym); den += w * (p.t - tm) ** 2; });
    const slope = den > 0 ? num / den : 0;
    v = Math.max(-P.velCap, Math.min(P.velCap, slope * (n / (n + 1)) * P.velShrink));
    if (n >= 3) {
      let sr = 0;
      pts.forEach((p, i) => { const w = i + 1; sr += w * (p.y - (ym + slope * (p.t - tm))) ** 2; });
      resid = Math.sqrt(sr / sw);
    }
  }
  const young = c.obs.length < 3;
  const term = Math.max(-P.termCap, Math.min(P.termCap, v * H * damp));
  const m0 = c.lastY + term;
  const w = Math.min(0.95, revW + (young ? P.youngPull : 0));
  const mean = m0 + w * (med20 - m0);
  const extra = (young ? P.youngSig : 0) + (c.venue === 'curve' ? P.curveSig : 0) + Math.min(P.volCap, resid);
  return { mint: c.mint, mean, sigma: sigBase + extra * extraW, lastY: c.lastY };
}
const cands = current.map(forecastCoin);

// Candidates: top candMean by predicted mean, top candCap by last observed cap, at most candMax in all.
const byMean = [...cands].sort((a, b) => b.mean - a.mean || (a.mint < b.mint ? -1 : 1));
const byLast = [...cands].sort((a, b) => b.lastY - a.lastY || (a.mint < b.mint ? -1 : 1));
const chosen = new Map<string, Cand>();
for (const c of byMean.slice(0, P.candMean)) chosen.set(c.mint, c);
for (const c of byLast.slice(0, P.candCap)) if (chosen.size < P.candMax) chosen.set(c.mint, c);
const C = [...chosen.values()].sort((a, b) => (a.mint < b.mint ? -1 : 1));
const nC = C.length;
const PLACES = task.places;

// Deterministic Monte Carlo.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(P.seed);
let spare: number | null = null;
function gauss(): number {
  if (spare !== null) { const s = spare; spare = null; return s; }
  const u = Math.max(rnd(), 1e-12), v = rnd();
  const r = Math.sqrt(-2 * Math.log(u));
  spare = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}

const edges = task.size.edges;
const nBins = edges.length + 1;
const binOf = (y: number): number => { let lo = 0, hi = edges.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (y >= edges[mid]!) lo = mid + 1; else hi = mid; } return lo; };

const placeCount = Array.from({ length: PLACES }, () => new Float64Array(nC));
const top5Count = new Float64Array(nC);
const binCount = Array.from({ length: PLACES }, () => new Float64Array(nBins));
const draw = new Float64Array(nC);
const idx = new Int32Array(nC);
const kPlaces = Math.min(PLACES, nC);
for (let d = 0; d < P.draws; d++) {
  const shock = gauss() * sharedSd;
  for (let i = 0; i < nC; i++) { draw[i] = C[i]!.mean + shock + gauss() * C[i]!.sigma; idx[i] = i; }
  // partial selection of the top kPlaces
  for (let k = 0; k < kPlaces; k++) {
    let best = k;
    for (let j = k + 1; j < nC; j++) if (draw[idx[j]!]! > draw[idx[best]!]!) best = j;
    const tmp = idx[k]!; idx[k] = idx[best]!; idx[best] = tmp;
    const ci = idx[k]!;
    placeCount[k]![ci]! += 1;
    top5Count[ci]! += 1;
    binCount[k]![binOf(draw[ci]!)]! += 1;
  }
}

// Probabilities: keep p >= minP, scale each place to at most nameSum, round down to 6 decimals.
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let k = 0; k < kPlaces; k++) {
  let rows = C.map((c, i) => ({ mint: c.mint, p: placeCount[k]![i]! / P.draws })).filter((r) => r.p > 0);
  for (let iter = 0; iter < 8; iter++) {
    const sum = rows.reduce((a, r) => a + r.p, 0);
    const scale = sum > P.nameSum ? P.nameSum / sum : 1;
    const next = rows.map((r) => ({ mint: r.mint, p: r.p * scale })).filter((r) => r.p >= P.minP);
    const stable = next.length === rows.length;
    rows = next;
    if (stable) break;
  }
  rows.sort((a, b) => b.p - a.p || (a.mint < b.mint ? -1 : 1));
  for (const r of rows.slice(0, 100)) {
    const p = Math.floor(r.p * MICRO) / MICRO;
    if (p > 0) probabilities.push({ mint: r.mint, place: k + 1, p });
  }
}

// top5: highest predicted mean log-cap, tie-break by MC P(top 5).
const order = C.map((c, i) => ({ c, t5: top5Count[i]! })).sort((a, b) => b.c.mean - a.c.mean || b.t5 - a.t5 || (a.c.mint < b.c.mint ? -1 : 1));
const top5 = order.slice(0, PLACES).map((o) => o.c.mint);
if (top5.length < PLACES) console.error(`warning: only ${top5.length} coins seen, top5 is short`);

// Sizes: a mixture of (a) the MC distribution of the cap at each place, smoothed over neighbouring bins, and (b) a
// normal around the place-k cap series' own damped trend (the k-th largest cap at each mark is observable and carries
// the market-wide drift the per-coin model misses: new coins overtaking the leaders).
function wslope(pts: Obs[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  let sw = 0, st = 0, sy = 0;
  pts.forEach((p, i) => { const w = i + 1; sw += w; st += w * p.t; sy += w * p.y; });
  const tm = st / sw, ym = sy / sw;
  let num = 0, den = 0;
  pts.forEach((p, i) => { const w = i + 1; num += w * (p.t - tm) * (p.y - ym); den += w * (p.t - tm) ** 2; });
  return den > 0 ? num / den : 0;
}
const erf = (x: number): number => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const r = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? r : -r;
};
const cdf = (x: number, mean: number, sd: number): number => 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
const sizeSd = P.sizeA + P.sizeB * Math.sqrt(H);
const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let k = 0; k < kPlaces; k++) {
  // place-k series over the last marks that ranked at least k+1 coins
  const series: Obs[] = [];
  for (const m of marks) {
    if (m.rows!.length > k) series.push({ t: Date.parse(m.at) / HOUR, y: logCap(m.rows![k]!.market_cap_lamports) });
  }
  const pts = series.slice(-P.velWindow);
  const n = pts.length;
  const slope = Math.max(-P.placeCap, Math.min(P.placeCap, wslope(pts) * (n / (n + 1)) * P.placeShrink));
  const center = pts[n - 1]!.y + Math.max(-P.termCap, Math.min(P.termCap, slope * H * damp));
  const raw = binCount[k]!;
  const sm = new Float64Array(nBins);
  const sd = P.sizeKernel;
  const rad = Math.ceil(sd * 4);
  for (let b = 0; b < nBins; b++) {
    if (raw[b] === 0) continue;
    let norm = 0;
    for (let o = -rad; o <= rad; o++) norm += Math.exp(-0.5 * (o / sd) ** 2);
    for (let o = -rad; o <= rad; o++) {
      const j = b + o;
      if (j < 0 || j >= nBins) continue; // mass past the end bins is dropped (stays unnamed)
      sm[j]! += P.sizeMix * (raw[b]! / P.draws) * Math.exp(-0.5 * (o / sd) ** 2) / norm;
    }
  }
  for (let b = 0; b < nBins; b++) {
    const lo = b === 0 ? -Infinity : edges[b - 1]!;
    const hi = b === nBins - 1 ? Infinity : edges[b]!;
    const pLo = lo === -Infinity ? 0 : cdf(lo, center, sizeSd);
    const pHi = hi === Infinity ? 1 : cdf(hi, center, sizeSd);
    sm[b]! += (1 - P.sizeMix) * (pHi - pLo);
  }
  const sum = sm.reduce((a, x) => a + x, 0);
  const scale = sum > 0 ? P.sizeSum / sum : 0;
  for (let b = 0; b < nBins; b++) {
    const p = Math.floor(sm[b]! * scale * MICRO) / MICRO;
    if (p > 0) sizes.push({ place: k + 1, bin: b, p });
  }
}

writeFileSync(join(OUTPUT_DIR, task.output ?? 'forecast.json'), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
