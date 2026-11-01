// Generate a disposable ed25519 NEAR key file (testnet burner) with Node's built-in crypto.
// Usage: node tools/keygen.mjs <account_id> <out.json>
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const [accountId, outPath] = process.argv.slice(2);
if (!accountId || !outPath) throw new Error("usage: keygen.mjs <account_id> <out.json>");
if (existsSync(outPath)) throw new Error(`refusing to overwrite ${outPath}`);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
const file = {
  account_id: accountId,
  public_key: "ed25519:" + base58(pub),
  private_key: "ed25519:" + base58(Buffer.concat([seed, pub])),
};
writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
console.log(file.public_key);
