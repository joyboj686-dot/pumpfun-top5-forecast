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
   movers. Sizes: a mixture of the Monte Carlo cap distribution and a normal
   around each place's own observed cap trend (the k-th largest cap per mark,
   damped and shrunk), smoothed over neighbouring bins and summing to ~0.93.
6. `top5` is the 5 coins with the highest predicted log-cap.

## Honest caveats
The constants were tuned on a tiny backtest: the practice history truncated to
3 or 4 marks, scored against the later marks (horizon ~15 minutes). The
final's horizon is ~7-13 hours, so the long-horizon constants (damping,
reversion, sigma growth, the size spread) are priors, not fitted values. On
that backtest the model beats the house persistence baseline by about 2.5-3
nats; that says little about the final.
