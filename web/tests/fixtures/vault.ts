/** JSON exactly as the vault views return it (near-sdk serde: U128 as strings, u64 as numbers). */
export const policyJson = {
  cap_bps: 2500, epoch_cap_bps: 5000, cap_usdc: "15000000", epoch_cap_usdc: "30000000",
  cap_wnear: "5000000000000000000000000", epoch_cap_wnear: "10000000000000000000000000",
  cap_sell_bps: 5000, dust_wnear: "1000000000000000000000", max_risk_bps: 6000,
  epoch_len: 86400, cooldown: 600, slippage_bps: 100, price_max_age: 120, price_max_conf_bps: 100,
  ref_dev_bps: 200, decision_ttl: 300, abort_after_blocks: 300, stuck_after: 900, halt_after: 86400,
  max_execution_seconds: 60, ops_budget: "5000000", near_reserve: "3000000000000000000000000",
  tvl_cap: "1000000000", per_user_cap: "100000000", min_deposit: "1000000",
  max_mint_per_cycle: 20, timelock: 86400, open_deposits: true,
};
export const assetsJson = {
  usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  wnear: "wrap.near", rhea: "v2.ref-finance.near", pool_id: 4512, pool_fee_bps: 1, usdc_decimals: 6, wnear_decimals: 24,
};
export const rolesJson = { governor: "lead.near", keeper: "keeper.lead.near", guardian: "guardian.near" };
export const agentJson = {
  outlayer: "outlayer.near", wasm_url: "https://example.org/strategy.wasm", wasm_hash: "ab".repeat(32),
  secrets_profile: "p", secrets_owner: "lead.near", outlayer_deposit: "0", chain: "mainnet",
  commitment: "cd".repeat(32), reveal_after: 1800100000, max_instructions: 1, max_memory_mb: 1, build_target: "wasm32-wasip2",
};
export const inflightJson = {
  nonce: 9, token_in: "Usdc", token_out: "Wnear", amount_in: "12400000", min_amount_out: "4000000000000000000000000",
  amount_out: null, shares_snapshot: "96000000000000", shares_burned: "0", recovered: "0", stuck_since: 1000,
};
export const oracleJson = {
  "near.price": { price: "250000000", conf: "100000", expo: -8, publish_time: 1800000000 },
  "usdc.price": { price: "100000000", conf: "10000", expo: -8, publish_time: 1800000000 },
};

/** View answers keyed by method name, for a fake RPC. */
export const vaultViews: Record<string, unknown> = {
  stage: "Idle", inflight: null, policy: policyJson, assets: assetsJson, roles: rolesJson,
  book: { usdc: "96400000", wnear: "0" }, total_shares: "96000000000000", last_nonce: 41, ops_spent: "1250000",
  window_used: "0", is_frozen: false, is_halted: false, is_setup_done: true, selftest_passed: true,
  storage_balance_bounds: { min: "15000000000000000000000", max: null },
  agent: agentJson, revealed: null, keeper_change: null, guardian_change: null,
  oracle: { account: "pyth-oracle.near", near_id: "near.price", usdc_id: "usdc.price" },
  list_prices_no_older_than: oracleJson,
};
