const tally = (pass: number, skip: number, fail: number, state = "done") => ({ pass, skip, fail, state });

export const CYCLES = [
  { nonce: "41", started_at: "2026-11-11T09:00:00Z", finished_at: "2026-11-11T09:02:00Z", events: [{ name: "cycle_started" }, { name: "decision" }, { name: "executed" }], amount_in: "12400000", amount_out: "4950000000000000000000000", tx_hashes: ["4fT9aQ1mZk2Lx8pRwY3vN6cB7dE5gH2jK9sU1oP4qW6r", "5gU1bR2nAm3My9qSxZ4wQ7dC8eF6hJ3kL1tV2pQ5rX7s"], verifier: tally(6, 1, 0), obs_recheck: tally(2, 0, 0) },
  { nonce: "40", started_at: "2026-11-11T08:00:00Z", finished_at: "2026-11-11T08:00:30Z", events: [{ name: "cycle_started" }, { name: "decision" }, { name: "hold", code: "NO_DECISION" }], amount_in: null, amount_out: null, tx_hashes: ["6hV2cS3oBn4Nz1rTyA5xP8eD9fG7jK4mM2uW3qR6sY8t"], verifier: tally(4, 1, 0), obs_recheck: tally(2, 0, 0) },
  { nonce: "39", started_at: "2026-11-11T07:00:00Z", finished_at: "2026-11-11T07:00:40Z", events: [{ name: "cycle_started" }, { name: "decision" }, { name: "rejected", code: "PRICE_WIDE" }], amount_in: null, amount_out: null, tx_hashes: ["7iW3dT4pCo5Pa2sUzB6yQ9fE1gH8kL5nN3vX4rS7tZ9u"], verifier: tally(4, 1, 0), obs_recheck: null },
];

export const NAV = [
  { nonce: "1", at: "2026-11-01T00:00:00Z", book: { usdc: "96000000", wnear: "0" }, total_shares: "96000000000000", oracle: null },
  { nonce: "20", at: "2026-11-06T00:00:00Z", book: { usdc: "96200000", wnear: "0" }, total_shares: "96000000000000", oracle: null },
  { nonce: "41", at: "2026-11-11T00:00:00Z", book: { usdc: "96400000", wnear: "0" }, total_shares: "96000000000000", oracle: null },
];

export const API_ROUTES: Record<string, unknown> = {
  "/api/v1/status": { position: "201", heartbeat_at: "2026-11-11T09:03:00Z", tip_lag: "2" },
  "/api/v1/nav": NAV,
  "/api/v1/cycles": CYCLES,
  "/api/v1/cycles/41": CYCLES[0],
  "/api/v1/cycles/40": CYCLES[1],
  "/api/v1/cycles/39": CYCLES[2],
  "/api/v1/proofs/41": { verifier: tally(6, 1, 0), obs_recheck: tally(2, 0, 0), replay: "sealed" },
};
