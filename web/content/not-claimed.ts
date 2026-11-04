/**
 * "What we don't claim", from SPEC §1. This is the one block the forbidden-word check skips,
 * because it names those words to disclaim them.
 */
export const NOT_CLAIMED: readonly string[] = [
  "Returns or alpha.",
  "That the vault is proven, trustless, fully decentralised or non-custodial. You still trust Intel TDX and NVIDIA, the Phala host, the OutLayer operator and its full-access key, NEAR AI Cloud, the Rhea aggregate oracle and the DAO that can upgrade it at once, the Rhea contracts and their DAO, the USDC contract and its issuer, and whoever holds the governor key.",
  "Independent oversight of the team.",
  "Protection from MEV.",
  "Perfect privacy. Trades are visible on chain and reveal the rules a little at a time.",
  "That the TEE proves the strategy is correct or makes money.",
  "That replay proves execution. It checks the rules against the recorded inputs.",
  "That the contract has no bugs. There is no third-party audit and no upgrade; a bug is answered with a new vault.",
];
