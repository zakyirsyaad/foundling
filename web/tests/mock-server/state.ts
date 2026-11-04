/** Scenario switches shared by the mock RPC, API and 1Click routes. */
export type Scenario = { name: string; views: Record<string, unknown>; perAccount: Record<string, Record<string, unknown>>; accessKeys: number; rpcDown: boolean; apiDown: boolean; oneClickDown: boolean; extra: Record<string, unknown> };

import type http from "node:http";

export function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
