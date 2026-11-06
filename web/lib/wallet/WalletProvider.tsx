"use client";

import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

import { config } from "@/config";
import { pageNonce } from "./nonce";
import type { WalletApi } from "./types";

interface WalletState {
  wallet: WalletApi | null;
  account: string | null;
}

const WalletContext = createContext<WalletState>({ wallet: null, account: null });

async function load(nonce: string): Promise<WalletApi> {
  // Written out literally so the bundler drops the mock from a production build.
  if (process.env.NEXT_PUBLIC_TEST_BUILD === "1") {
    const { createMockWallet } = await import("@foundling/wallet-mock");
    return createMockWallet();
  }
  const { createWallet } = await import("./connector");
  return createWallet(config, pageNonce(nonce));
}

export function WalletProvider({ nonce, children }: { nonce: string; children: ReactNode }) {
  const [state, setState] = useState<WalletState>({ wallet: null, account: null });
  useEffect(() => {
    let off = () => {};
    let alive = true;
    load(nonce)
      .then((wallet) => {
        if (!alive) return;
        setState({ wallet, account: wallet.accountId() });
        off = wallet.onAccountChange((account) => setState({ wallet, account }));
      })
      .catch(() => {
        if (alive) setState({ wallet: null, account: null });
      });
    return () => {
      alive = false;
      off();
    };
  }, [nonce]);
  return <WalletContext.Provider value={state}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  return useContext(WalletContext);
}
