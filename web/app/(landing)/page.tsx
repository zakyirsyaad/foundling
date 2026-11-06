import { config } from "@/config";
import { Home } from "@/features/landing/Home";
import { getSnapshot } from "@/lib/chain/source";
import { webClaims } from "@/lib/claims-source";
import { keysLine } from "@/lib/proof/keysLine";

export const revalidate = 45;

export default async function HomePage() {
  const result = await getSnapshot("landing");
  return <Home claims={webClaims(config)} keysLine={keysLine(result.ok ? result.source : null, config.network)} />;
}
