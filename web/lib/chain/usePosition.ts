"use client";

import { useCallback, useEffect, useState } from "react";

import { config } from "@/config";
import { createRpcClient } from "./rpc";
import type { Position, VaultSnapshot } from "./types";
import { readPosition } from "./vault";

const DEFAULT_GAS_PRICE = 100_000_000n;

/** The connected account's position and the current gas price, read from RPC only. */
export function usePosition(account: string | null, s: VaultSnapshot | null) {
  const [read, setRead] = useState<{ account: string; position: Position | null }>({ account: "", position: null });
  const [gasPrice, setGasPrice] = useState<bigint>(DEFAULT_GAS_PRICE);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!account || !s) return;
    let alive = true;
    const rpc = createRpcClient(config.rpcUrls);
    Promise.all([readPosition(rpc, s, account, config.usdcE), rpc.gasPrice()])
      .then(([position, g]) => {
        if (!alive) return;
        setRead({ account, position });
        setGasPrice(g);
      })
      .catch(() => {
        if (alive) setRead({ account, position: null });
      });
    return () => {
      alive = false;
    };
  }, [account, s, tick]);
  // A position read for another account is never shown for this one.
  const position = account && s && read.account === account ? read.position : null;
  return { position, gasPrice, reload };
}
