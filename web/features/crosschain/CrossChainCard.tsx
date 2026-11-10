"use client";

import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import Link from "next/link";
import { useEffect, useReducer, useState } from "react";

import { Status } from "@/components/fm/Status";
import { config } from "@/config";
import type { ChainId } from "@/config/deployment";
import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { depositAmount } from "@/lib/crosschain/amount";
import { isEvmAddress } from "@/lib/crosschain/evm";
import { flowReducer, initialFlow } from "@/lib/crosschain/flow";
import { quoteProblems } from "@/lib/crosschain/signature";
import { type StoredSwap, blockingSwap } from "@/lib/crosschain/store";
import { formatUnits, parseU128, parseUnits } from "@/lib/format/units";
import { STATUS } from "@/lib/status/table";
import type { Step } from "@/lib/wallet/useTx";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { depositGate } from "@/lib/vault/deposit";
import { ConnectButton } from "@/features/vault/ConnectButton";
import { NearNeed } from "@/features/portfolio/NearNeed";
import { type BuildCtx, buildTx } from "@/lib/wallet/calls";
import { useOneClickSwap } from "./useOneClickSwap";

const USDC_DECIMALS = 6;
const WRONG_TOKEN: Record<ChainId, string> = { base: "USDbC is not the token asked for.", arb: "USDC.e is not the token asked for.", eth: "" };
type Quote = OneClickQuoteResponse & { quote: Record<string, string | undefined> };

/** A base-unit amount from a 1Click answer, or null when it is missing or not a whole-number string. */
function readAmount(v: unknown): bigint | null {
  try {
    return parseU128(v);
  } catch {
    return null;
  }
}

const usdc = (v: string | undefined) => {
  const n = readAmount(v);
  return n === null ? "—" : `${formatUnits(n, USDC_DECIMALS, 6)} USDC`;
};

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function CrossChainCard({ s, p, unreadable, run, busy, ctx = null, gasPrice = 0n }: { s: VaultSnapshot; p: Position | null; unreadable: boolean; run: (steps: Step[]) => void; busy: boolean; ctx?: BuildCtx | null; gasPrice?: bigint }) {
  const { account } = useWallet();
  const x = useOneClickSwap(unreadable);
  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const [chainId, setChainId] = useState<ChainId>(x.oc.chains.find((c) => c.enabled)?.id ?? "base");
  const [amountText, setAmountText] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [dry, setDry] = useState<Quote | null>(null);
  const [txHash, setTxHash] = useState("");
  const [lookup, setLookup] = useState("");
  const [lookupResult, setLookupResult] = useState<string | null>(null);

  useEffect(() => {
    if (account && flow.step === "connect") dispatch({ type: "connected", account });
    else if (flow.boundAccount !== account) dispatch({ type: "account-changed", account });
  }, [account, flow.step, flow.boundAccount]);

  useEffect(() => {
    if (x.status) dispatch({ type: "status", status: x.status.status });
  }, [x.status]);

  const chain = x.oc.chains.find((c) => c.id === chainId)!;
  const gate = depositGate(s, p, unreadable);
  const remainingCap = p && s.policy.perUserCap > p.netDeposit ? s.policy.perUserCap - p.netDeposit : 0n;
  const blocking = account ? blockingSwap(x.swaps, account, x.nowMs) : null;
  let amount: bigint | null = null;
  try {
    amount = amountText.trim() ? parseUnits(amountText, USDC_DECIMALS) : null;
  } catch {
    amount = null;
  }
  const refundOk = isEvmAddress(refundTo);

  async function getQuote() {
    if (!account || amount === null) return;
    try {
      const { res, problem } = await x.quote({ chain, amount, recipient: account, refundTo }, true);
      if (problem) return dispatch({ type: "problem", message: problem });
      const issues = quoteProblems(res, { minDeposit: s.policy.minDeposit, remainingUserCap: remainingCap });
      if (issues.length) return dispatch({ type: "problem", message: issues.includes("below-min") ? "The USDC that would arrive is below the vault's minimum deposit." : "The USDC that would arrive is more than this account can still deposit." });
      setDry(res as Quote);
      dispatch({ type: "quoted", chain: chain.id });
    } catch (err) {
      dispatch({ type: "problem", message: `1Click did not give a quote: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  async function getAddress() {
    if (!account || amount === null || depositGate(s, p, unreadable).reasons.length) return;
    // Another tab may have got an address since this one passed the quote step.
    if (blockingSwap(x.listSwaps(), account, Date.now())) return dispatch({ type: "problem", message: "Another swap for this account may still be waiting for funds. Check it below before asking for a new address." });
    try {
      const { req, res, problem } = await x.quote({ chain, amount, recipient: account, refundTo }, false);
      if (problem) return dispatch({ type: "problem", message: problem });
      const q = res as Quote;
      // The address closes at quote.deadline (signed); never later than what was asked for.
      const deadlineMs = Math.min(Date.parse(String(q.quote.deadline)), Date.parse(req.deadline));
      const stamp = Date.parse(String(res.timestamp));
      if (!Number.isFinite(deadlineMs) || !Number.isFinite(stamp) || !q.quote.depositAddress) return dispatch({ type: "problem", message: "1Click's answer had no usable deadline or address, so none is shown." });
      const swap = { depositAddress: String(q.quote.depositAddress), recipient: account, chainId: chain.id, deadlineMs, createdAtMs: Date.now(), final: null, txHashes: [], declaredNotSent: false };
      x.save(swap);
      x.setLive({ swap, request: req, signed: res, anchor: { responseTimestampMs: stamp, perfAtReceipt: performance.now(), dateAtReceipt: Date.now() }, needsReanchor: false, confirmNotSent: false });
      dispatch({ type: "address-verified", swap });
    } catch (err) {
      dispatch({ type: "problem", message: `1Click did not give an address: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const live = x.live;
  const liveChain = live ? x.oc.chains.find((c) => c.id === live.swap.chainId) : undefined;
  const earlier = x.swaps.filter((w) => w.recipient === account && w.depositAddress !== live?.swap.depositAddress);
  const raw = (x.status?.raw ?? {}) as { swapDetails?: { amountOut?: string; refundedAmount?: string; refundReason?: string; depositedAmount?: string } };
  const st = x.status?.status;
  const finalStatus: StoredSwap["final"] = st === "SUCCESS" || st === "REFUNDED" || st === "FAILED" ? st : null;
  const { save, setLive } = x;
  useEffect(() => {
    if (!live || !finalStatus || live.swap.final === finalStatus) return;
    const swap = { ...live.swap, final: finalStatus };
    save(swap);
    setLive({ ...live, swap });
  }, [finalStatus, live, save, setLive]);

  return (
    <section aria-labelledby="crosschain-title" className="grid gap-4 rounded-lg border p-5" data-step={flow.step}>
      <h2 id="crosschain-title" className="text-lg font-semibold">From another chain</h2>
      <p className="text-[13px] text-muted-foreground">Send USDC from Base, Arbitrum or Ethereum through 1Click (NEAR Intents). It lands in your own NEAR account first; nothing enters the vault until you sign the deposit.</p>
      {x.down ? <p role="status">Deposits from another chain are not available right now: 1Click did not answer. Deposits of USDC on NEAR are not affected.</p> : null}
      {flow.problem ? <p role="alert">{flow.problem}</p> : null}

      {flow.step === "connect" ? (
        <div className="grid gap-2"><p>Connect a NEAR wallet first. The swap is made for that account.</p><ConnectButton /></div>
      ) : null}

      {flow.step === "quote" && !x.down ? (
        gate.reasons.length ? (
          <p>{gate.reasons.includes("unreadable") ? "The vault is not readable right now, so no quote is asked for." : "The vault is not taking deposits right now, so no quote is asked for."}</p>
        ) : blocking ? (
          <div className="grid gap-2">
            <p>A {x.oc.chains.find((c) => c.id === blocking.chainId)?.label ?? ""} swap for this account, started {new Date(blocking.createdAtMs).toLocaleString()}, may still be waiting for funds. A second quote now risks a second send.</p>
            <button type="button" className="justify-self-start rounded-md border border-input px-3 py-1.5" onClick={() => x.save({ ...blocking, declaredNotSent: true })}>I have not sent anything to it</button>
          </div>
        ) : (
          <div className="grid gap-3">
            <fieldset className="flex flex-wrap gap-2">
              <legend className="fm-label mb-1">Chain</legend>
              {x.oc.chains.map((c) => (
                <label key={c.id} className={`rounded-md border px-3 py-1.5 ${c.enabled ? "" : "opacity-50"}`}>
                  <input type="radio" name="chain" value={c.id} disabled={!c.enabled} checked={chainId === c.id} onChange={() => setChainId(c.id)} /> {c.label}{c.enabled ? "" : " · not available yet"}
                </label>
              ))}
            </fieldset>
            <label className="grid gap-1"><span className="fm-label">USDC to send</span><input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} className="mono rounded-md border border-input bg-transparent px-3 py-2" /></label>
            <div className="grid gap-1">
              <label className="grid gap-1">
                <span className="fm-label">Refund address on {chain.label}</span>
                <input value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} className="mono rounded-md border border-input bg-transparent px-3 py-2" aria-invalid={refundTo !== "" && !refundOk} aria-describedby="refund-help" />
              </label>
              <div id="refund-help" className="grid gap-1">
                {refundTo !== "" && !refundOk ? <span className="text-[13px] text-danger">Not a valid EVM address. Check it, including upper and lower case.</span> : null}
                <span className="text-[13px] text-muted-foreground">Use an address you control on {chain.label}. Not an exchange address, and not a contract wallet that may not exist on other chains.</span>
              </div>
            </div>
            {chain.id === "eth" ? <p className="text-[13px]">Network fees on Ethereum can be more than a small deposit.</p> : null}
            <button type="button" disabled={amount === null || !refundOk} onClick={getQuote} className="justify-self-start rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">Get a quote</button>
          </div>
        )
      ) : null}

      {flow.step === "prepare" && dry ? (
        <div className="grid gap-3">
          <dl className="grid gap-1 text-[13px] sm:grid-cols-2">
            <div><dt className="fm-label">Arrives (about)</dt><dd className="mono">{usdc(dry.quote.amountOut)}</dd></div>
            <div><dt className="fm-label">Arrives at least</dt><dd className="mono">{usdc(dry.quote.minAmountOut)}</dd></div>
            <div><dt className="fm-label">Send at least</dt><dd className="mono">{usdc(dry.quote.minAmountIn)}</dd></div>
            <div><dt className="fm-label">Fees</dt><dd className="mono">refund {usdc(dry.quote.refundFee)} · withdraw {usdc(dry.quote.withdrawFee)}</dd></div>
          </dl>
          {p && (!p.registered.vault || !p.registered.usdc) ? (
            <div className="grid gap-2">
              {ctx ? <NearNeed txs={[...(!p.registered.vault ? [buildTx("register_vault", {}, ctx)] : []), ...(!p.registered.usdc ? [buildTx("register_usdc", {}, ctx)] : [])]} near={p.balances.near} gasPrice={gasPrice} /> : null}
              <p>Before any money moves, register this account{!p.registered.vault ? " with the vault (one-time, non-refundable)" : ""}{!p.registered.usdc ? " and with USDC on NEAR" : ""}.</p>
              <button type="button" disabled={busy} onClick={() => run([...(!p.registered.vault ? [{ name: "register_vault" as const, args: {} }] : []), ...(!p.registered.usdc ? [{ name: "register_usdc" as const, args: {} }] : [])])} className="justify-self-start rounded-md border border-input px-3 py-1.5">Register</button>
            </div>
          ) : (
            <button type="button" onClick={() => dispatch({ type: "prepared" })} className="justify-self-start rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground">Continue</button>
          )}
        </div>
      ) : null}

      {flow.step === "send" && !live ? (
        <div className="grid gap-2">
          <p>The next quote is final: prices can move, so the numbers may change. Check them before you send.</p>
          <p className="text-[13px]">By sending you accept the <Link href="/terms#cross-chain" className="underline underline-offset-4">terms for deposits from another chain</Link>.</p>
          <button type="button" onClick={getAddress} className="justify-self-start rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground">Get the deposit address</button>
        </div>
      ) : null}

      {live && flow.step !== "wait" ? (
        <div className="grid gap-2" data-testid="address-block" data-view={x.view}>
          {x.view === "show" ? (
            <>
              <p>Send USDC on <strong>{config.oneClick?.chains.find((c) => c.id === live.swap.chainId)?.label}</strong> to</p>
              <p className="mono break-all text-[15px]" data-testid="deposit-address">{live.swap.depositAddress}</p>
              <p className="mono text-[13px]">Token {x.tokens?.find((t) => t.assetId === liveChain?.originAsset)?.contractAddress ?? liveChain?.originAsset} · send {usdc((live.signed as Quote).quote.amountIn)} · at least {usdc((live.signed as Quote).quote.minAmountIn)}</p>
              <p className="text-[13px]" data-testid="send-before">Send before {new Date(live.swap.deadlineMs - x.margin).toLocaleTimeString()} · {Math.max(0, Math.floor((x.rem - x.margin) / 60_000))} min left</p>
              {WRONG_TOKEN[live.swap.chainId] ? <p className="text-[13px]">{WRONG_TOKEN[live.swap.chainId]}</p> : null}
            </>
          ) : x.view === "do-not-send" ? (
            <p role="alert" className="font-medium">Do not send to this address any more. Funds that arrive after it closes may be lost.</p>
          ) : live.confirmNotSent ? (
            <div className="grid gap-2">
              <p>Already sent? Paste the tx hash below. If you have not sent anything yet, say so to see the address again.</p>
              <button type="button" className="justify-self-start rounded-md border border-input px-3 py-1.5" onClick={() => x.setLive({ ...live, confirmNotSent: false })}>I have not sent anything yet</button>
            </div>
          ) : live.needsReanchor ? (
            <div className="grid gap-2">
              <p>The address is hidden until the remaining time is checked again.</p>
              <button type="button" disabled={unreadable} className="justify-self-start rounded-md border border-input px-3 py-1.5" onClick={() => void x.reanchor()}>Check the time</button>
            </div>
          ) : (
            <p>The address is hidden while 1Click cannot confirm the status of the swap.</p>
          )}
          <label className="grid gap-1"><span className="fm-label">Origin tx hash (optional, speeds things up)</span><input value={txHash} onChange={(e) => setTxHash(e.target.value.trim())} className="mono rounded-md border border-input bg-transparent px-3 py-2" /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!txHash} className="rounded-md border border-input px-3 py-1.5" onClick={() => void x.client.submit(txHash, String(live.swap.depositAddress)).then(
              () => {
                const swap = { ...live.swap, txHashes: live.swap.txHashes.includes(txHash) ? live.swap.txHashes : [...live.swap.txHashes, txHash] };
                x.save(swap);
                x.setLive({ ...live, swap });
              },
              (err: unknown) => dispatch({ type: "problem", message: `1Click did not take the tx hash: ${err instanceof Error ? err.message : String(err)}` }),
            )}>Submit tx hash</button>
            <button type="button" className="rounded-md border border-input px-3 py-1.5" onClick={() => download(`1click-quote-${live.swap.depositAddress}.json`, live.signed)}>Download the signed quote</button>
          </div>
        </div>
      ) : null}

      {live && x.status ? (
        <p className="flex items-center gap-2" data-testid="swap-status">
          {x.status.status in STATUS.oneclick ? <Status group="oneclick" word={x.status.status} /> : <span className="mono text-[13px]">{x.status.status === "not-found" ? "Waiting for your transfer" : "Status unknown"}</span>}
          {st === "INCOMPLETE_DEPOSIT" ? <span className="text-[13px]">Less than the minimum arrived. Send the rest before the time runs out, or 1Click refunds it after the deadline.</span> : null}
        </p>
      ) : null}

      {flow.step === "wait" && live ? (
        st === "SUCCESS" ? (
          (() => {
            const out = readAmount(raw.swapDetails?.amountOut ?? "0");
            if (out === null) return <p>1Click says the swap succeeded, but this page could not read the amount that arrived. Check the USDC in your NEAR account before you deposit it.</p>;
            const d = depositAmount(out, p?.balances.usdc ?? 0n, remainingCap, s.policy.minDeposit);
            if (account !== live.swap.recipient) return <p>Connect <span className="mono">{live.swap.recipient}</span> to deposit the USDC that arrived.</p>;
            if (d.belowMin) return <p>{usdc(out.toString())} arrived in your NEAR account. That is below the minimum deposit, so it stays there.</p>;
            return (
              <div className="grid gap-2">
                <p>{usdc(out.toString())} arrived in your NEAR account.{d.excess > 0n ? ` ${usdc(d.excess.toString())} stays there, over what this account can deposit.` : ""}</p>
                <button type="button" disabled={busy} onClick={() => run([{ name: "deposit", args: { amount: d.amount.toString() } }])} className="justify-self-start rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground">Deposit {usdc(d.amount.toString())}</button>
              </div>
            );
          })()
        ) : st === "REFUNDED" ? (
          <p>1Click refunded the swap to <span className="mono">{live.request.refundTo}</span>{readAmount(raw.swapDetails?.refundedAmount) !== null ? `: ${usdc(raw.swapDetails?.refundedAmount)}` : ""}{raw.swapDetails?.refundReason ? ` (${raw.swapDetails.refundReason})` : ""}.</p>
        ) : st === "FAILED" ? (
          <p>The swap failed. No refund is promised here. Contact 1Click support with your origin tx hash and the signed quote you downloaded.</p>
        ) : (
          <p>1Click is processing the swap.</p>
        )
      ) : null}

      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted-foreground">Look up a swap by deposit address</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="Deposit address" value={lookup} onChange={(e) => setLookup(e.target.value.trim())} className="mono rounded-md border border-input bg-transparent px-3 py-1.5" />
          <button type="button" disabled={!lookup} className="rounded-md border border-input px-3 py-1.5" onClick={() => void x.client.status(lookup).then((r) => setLookupResult(r === "not-found" ? "Not known to 1Click yet." : r.status), () => setLookupResult("1Click did not answer."))}>Look up</button>
          {lookupResult ? <span data-testid="lookup-result">{lookupResult}</span> : null}
        </div>
      </details>
      {earlier.length ? (
        <ul className="grid gap-1 text-[13px]" aria-label="Earlier swaps">
          {earlier.map((w) => (
            <li key={`${w.depositAddress}-${w.createdAtMs}`} className="mono">{w.chainId} · {w.final ?? "in progress"} · {w.txHashes[0] ?? "no tx hash yet"}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
