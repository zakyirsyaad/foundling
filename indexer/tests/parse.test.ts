import { parseTransaction, sortEvents } from "../src/parse";

const VAULT = "vault.fdl-m12-0d1276.testnet";
const USDC = "usdc.fakes.testnet";
const TS = 1793544049283154057n; // ns

const ev = (event: string, data = "{}") => `EVENT_JSON:{"standard":"foundling","version":"1.0.0","event":"${event}","data":[${data}]}`;

function receipt(id: string, executor: string, status: Record<string, unknown>, logs: string[], height = 100, index = 0) {
  return {
    execution_outcome: {
      block_hash: "B",
      block_timestamp: Number(TS),
      block_height: height,
      index,
      id,
      outcome: { logs, receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: executor, status },
    },
    receipt: { receipt_id: id, receiver_id: executor, predecessor_id: "alice.testnet" },
  };
}

function tx(receipts: ReturnType<typeof receipt>[], hash = "TX1") {
  return {
    transaction: { hash, signer_id: "alice.testnet", receiver_id: VAULT },
    execution_outcome: receipt(hash, "alice.testnet", { SuccessReceiptId: "R1" }, []).execution_outcome,
    receipts,
  };
}

test("keeps only successful vault receipts with foundling logs", () => {
  const t = tx([
    receipt("R1", VAULT, { SuccessValue: "" }, [ev("cycle_started", `{"nonce":7}`), ev("decision_ready", `{"nonce":7}`)]),
    receipt("R2", VAULT, { Failure: { ActionError: {} } }, [ev("halted", `{"nonce":7}`)]),
    receipt("R3", USDC, { SuccessValue: "" }, [ev("minted")]),
  ]);
  const out = parseTransaction(VAULT, t);
  expect(out.map((e) => [e.name, e.logIndex, e.receiptId])).toEqual([
    ["cycle_started", 0, "R1"],
    ["decision_ready", 1, "R1"],
  ]);
  expect(out[0]).toMatchObject({ vaultId: VAULT, txHash: "TX1", blockHeight: 100n, receiptIndex: 0, nonce: 7n, account: null });
  expect(out[0]!.blockTime.getTime()).toBe(Number(TS / 1_000_000n));
});

test("accepts SuccessReceiptId receipts", () => {
  const out = parseTransaction(VAULT, tx([receipt("R1", VAULT, { SuccessReceiptId: "R9" }, [ev("frozen")])]));
  expect(out.map((e) => e.name)).toEqual(["frozen"]);
});

test("data:[] becomes an empty object and account is read from data", () => {
  const out = parseTransaction(
    VAULT,
    tx([receipt("R1", VAULT, { SuccessValue: "" }, [`EVENT_JSON:{"standard":"foundling","version":"1.0.0","event":"unfrozen","data":[]}`, ev("depositor_added", `{"account":"bob.testnet"}`)])]),
  );
  expect(out[0]!.data).toEqual({});
  expect(out[1]).toMatchObject({ account: "bob.testnet", nonce: null, data: { account: "bob.testnet" } });
});

test("ignores logs that are not foundling events without throwing", () => {
  const logs = [
    "plain text log",
    "EVENT_JSON:{not json",
    `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}`,
    `EVENT_JSON:{"standard":"foundling","version":"1.0.0","event":"bad","data":"x"}`,
    ev("halt_cleared"),
  ];
  const out = parseTransaction(VAULT, tx([receipt("R1", VAULT, { SuccessValue: "" }, logs)]));
  expect(out.map((e) => [e.name, e.logIndex])).toEqual([["halt_cleared", 4]]);
});

test("orders receipts in one block by outcome index, not by list position", () => {
  const t = tx([
    receipt("R2", VAULT, { SuccessValue: "" }, [ev("decision_ready", `{"nonce":1}`)], 101, 3),
    receipt("R1", VAULT, { SuccessValue: "" }, [ev("cycle_started", `{"nonce":1}`)], 101, 1),
    receipt("R0", VAULT, { SuccessValue: "" }, [ev("selftest")], 100, 9),
  ]);
  expect(parseTransaction(VAULT, t).map((e) => e.receiptId)).toEqual(["R0", "R1", "R2"]);
});

test("sortEvents orders events from several transactions", () => {
  const a = parseTransaction(VAULT, tx([receipt("A", VAULT, { SuccessValue: "" }, [ev("x"), ev("y")], 200, 0)], "TXA"));
  const b = parseTransaction(VAULT, tx([receipt("B", VAULT, { SuccessValue: "" }, [ev("z")], 150, 5)], "TXB"));
  expect(sortEvents([...a, ...b]).map((e) => e.name)).toEqual(["z", "x", "y"]);
});

test("rejects a transaction that does not match the FastNEAR shape", () => {
  expect(() => parseTransaction(VAULT, { receipts: "nope" } as never)).toThrow();
});
