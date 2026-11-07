import type { MetadataRoute } from "next";

import { config } from "@/config";
import { robotsFor } from "@/lib/seo/site";

export default function robots(): MetadataRoute.Robots {
  return robotsFor(config, process.env.VERCEL_ENV);
}
