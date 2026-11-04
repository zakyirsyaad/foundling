import path from "node:path";

import type { DeploymentConfig } from "@/config/deployment";
import { type Claim, loadClaims } from "./claims";

/** The repo-root claims.json that README also uses; a test build reads the fixture instead. */
export function webClaims(cfg: DeploymentConfig): Claim[] {
  const root = process.cwd();
  const fixture = cfg.testBuild || process.env.FOUNDLING_BUNDLE_CHECK === "1";
  const file = fixture ? path.join(root, "tests", "fixtures", "claims.json") : path.join(root, "..", "claims.json");
  return loadClaims(file);
}
