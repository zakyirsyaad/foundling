import { notFound } from "next/navigation";

import { config } from "@/config";

/** Test build only: a page that must trip the forbidden-word check. */
export default function CopyFixture() {
  if (!config.testBuild) notFound();
  return <main>Earn a guaranteed APY.</main>;
}
