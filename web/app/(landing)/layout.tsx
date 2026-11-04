import type { ReactNode } from "react";

import { Footer } from "@/features/landing/Footer";
import { Header } from "@/features/landing/Header";

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header />
      {children}
      <Footer />
    </>
  );
}
