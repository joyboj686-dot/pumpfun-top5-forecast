# pumpfun-top5-forecast

Forecasts the top 5 new pump.fun Solana coins by market cap 24 hours after the
competition opening, from the house's 10-minute market-cap snapshots.

`main.ts` (Node 22, standard library only) reads `$MAKEFUN_INPUT_DIR`
(`history.ndjson`, `task.json`) and writes `$MAKEFUN_OUTPUT_DIR/forecast.json`:
per-coin log-cap trajectories are fitted over the marks, extrapolated to the
answer-read horizon with mean reversion, and a deterministic Monte Carlo over
the coins' predicted caps yields per-place probabilities and per-place size
distributions. No coin mint is hardcoded; everything is computed from the
input at grade time.
