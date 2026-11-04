import type http from "node:http";

import { type Scenario, send } from "./state";


export function handleApi(res: http.ServerResponse, s: Scenario, url: URL): void {
  if (s.apiDown) return send(res, 503, { success: false, data: null, error: "down", meta: null });
  const routes = (s.extra.api ?? {}) as Record<string, unknown>;
  const data = routes[url.pathname];
  if (data === undefined) return send(res, 404, { success: false, data: null, error: "not found", meta: null });
  return send(res, 200, { success: true, data, error: null, meta: { cursor: null } });
}
