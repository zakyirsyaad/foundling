import type { MetadataRoute } from "next";

import { config } from "@/config";
import { sitemapFor } from "@/lib/seo/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapFor(config, process.env.VERCEL_ENV);
}
