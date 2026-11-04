"use client";

import { useCallback, useEffect, useState } from "react";

import { config } from "@/config";
import { createRpcClient } from "./rpc";
import type { Position, VaultSnapshot } from "./types";
import { readPosition } from "./vault";

/** The connected account's position and the current gas price, read from RPC only. */
export function usePosition(account: string | null, s: VaultSnapshot | null) {
  const [position, setPosition] = useState<Position | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint>(100_000_000n);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!account || !s) {
      setPosition(null);
      return;
    }
    let alive = true;
    const rpc = createRpcClient(config.rpcUrls);
    Promise.all([readPosition(rpc, s, account, config.usdcE), rpc.gasPrice()])
      .then(([p, g]) => {
        if (!alive) return;
        setPosition(p);
        setGasPrice(g);
      })
      .catch(() => {
        if (alive) setPosition(null);
      });
    return () => {
      alive = false;
    };

  }, [account, s, tick]);
  return { position, gasPrice, reload };
}
