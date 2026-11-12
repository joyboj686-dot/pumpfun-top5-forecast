# pumpfun-top5-forecast

Forecasts the top 5 new pump.fun Solana coins by market cap 24 hours after the
competition opening, from the house's 10-minute market-cap snapshots.

`main.ts` (Node 22, standard library only, no network) reads
`$MAKEFUN_INPUT_DIR` (`history.ndjson`, `task.json`) and writes
`$MAKEFUN_OUTPUT_DIR/forecast.json`. No coin mint is hardcoded; everything is
computed from the input at grade time, and the output is byte-identical across
runs (fixed-seed PRNG).

## Model
1. Each coin's log10(cap in SOL) series is built from the marks. The horizon H
   is the mean answer-read time minus the last mark, read from `task.json`.
2. Predicted log-cap at the horizon = last value + a recent velocity term
   (weighted slope over the last 4 marks, shrunk, capped, damped by
   `1/(1+H/4)`) + mean reversion toward the median of the current top 20
   (weight `H/(H+6)`, a little more for coins seen fewer than 3 times).
3. Per-coin sigma grows with `sqrt(H)`, with extra for young coins, curve-venue
   coins and coins with a volatile history. One shared market shock is added to
   every coin in each draw.
4. A deterministic Monte Carlo (8000 draws, up to 80 candidate coins) gives
   P(coin at place k) and the distribution of the cap at each place.
5. Probabilities: coins with p >= 0.005 per place, scaled so each place names
   at most ~0.68, leaving the rest unnamed for coins born after the cut and for
   movers. Sizes (v2): a normal around each place's own observed cap trend (the
   k-th largest cap per mark, damped, no longer shrunk), summing to ~0.95. v1
   mixed in 20% of the Monte Carlo cap distribution, but backtests showed the MC
   part is too wide and dilutes the size score, so v2 uses the trend normal
   alone. The per-coin sigma base is 0.28 (v1: 0.25) and the candidate set is
   80 coins by predicted mean (v1: 60).
6. `top5` is the 5 coins with the highest predicted log-cap.

## Honest caveats
The constants were tuned on a tiny backtest: the practice history truncated to
3 or 4 marks, scored against the later marks (horizon ~15-50 minutes). The
final's horizon is ~10 hours, so the long-horizon constants (damping,
reversion, sigma growth, the size spread) are priors, not fitted values. On
that backtest v2 beats v1 on both protocols (4-mark: -30.09 vs -30.36; 3-mark:
-44.76 vs -47.55) and beats the house persistence baseline on both. The 3-mark
gain is large, the 4-mark gain is small, so the honest projection is that v2
plausibly reaches the paid top 20 but top 10 is not credibly supported by
these backtests alone.
