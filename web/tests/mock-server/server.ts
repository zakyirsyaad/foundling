/**
 * Test-only stand-in for NEAR RPC, the history API and 1Click, on one port.
 *   POST /rpc, GET /api/v1/*, * /1click/v0/*, POST /__scenario {"name": "..."}
 */
import http from "node:http";

import { handleApi } from "./api";
import { handleOneClick } from "./oneclick";
import { handleRpc } from "./rpc";
import { handleTx } from "./tx";
import { scenario } from "./scenarios";
import { type Scenario, send } from "./state";

const PORT = Number(process.env.MOCK_PORT ?? 3199);
let current: Scenario = scenario("normal");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "OPTIONS") return send(res, 204, undefined);
  const body = req.method === "GET" ? "" : await readBody(req);
  try {
    if (url.pathname === "/__scenario") {
      current = scenario(JSON.parse(body).name);
      return send(res, 200, { ok: current.name });
    }
    if (url.pathname === "/rpc") return handleRpc(res, current, body);
    if (url.pathname === "/__tx") return handleTx(res, current, body);
    if (url.pathname.startsWith("/api/")) return handleApi(res, current, url);
    if (url.pathname.startsWith("/1click/")) return handleOneClick(res, current, url, body);
    if (url.pathname === "/") return send(res, 200, { ok: true });
    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`mock server on ${PORT}`));
