"use client";

import { useEffect, useRef, useState } from "react";

import { config } from "@/config";
import { createRpcClient } from "./rpc";
import type { VaultSnapshot } from "./types";
import { acceptSnapshot, readVaultSnapshot } from "./vault";
import { dataAge } from "@/lib/vault/overview";

export const REFRESH_MS = 10_000;

/**
 * Live vault state in the browser: refresh every 10 s while the tab is visible, one RPC client per
 * refresh, never moving back to an older block. `fresh` turns true after a read succeeds.
 */
export function useVaultSnapshot(initial: VaultSnapshot | null) {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(initial);
  const [failed, setFailed] = useState(initial === null);
  const [now, setNow] = useState(() => (initial ? initial.fetchedAtMs : 0));
  const busy = useRef(false);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      if (busy.current || document.visibilityState !== "visible") return;
      busy.current = true;
      try {
        const next = await readVaultSnapshot(createRpcClient(config.rpcUrls), config.vaultId);
        if (!alive) return;
        setSnapshot((prev) => acceptSnapshot(prev, next));
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      } finally {
        busy.current = false;
        if (alive) setNow(Date.now());
      }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const unreadable = snapshot === null || (failed && dataAge(snapshot, now).unreadable);
  return { snapshot, unreadable, fresh: !failed && snapshot !== null };
}
