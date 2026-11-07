import type { Metadata } from "next";

import { NOT_FOUND } from "@/content/seo";
import { Footer } from "@/features/landing/Footer";
import { Header } from "@/features/landing/Header";
import { NotFoundView } from "@/features/landing/NotFoundView";

/** Next adds noindex to a 404 itself; this replaces its default page, which carried a second <title>. */
export const metadata: Metadata = { title: NOT_FOUND.title };

export default function NotFound() {
  return (
    <>
      <Header />
      <NotFoundView />
      <Footer />
    </>
  );
}
