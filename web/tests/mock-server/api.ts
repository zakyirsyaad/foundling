import type http from "node:http";

import { type Scenario, send } from "./state";


export function handleApi(res: http.ServerResponse, s: Scenario, url: URL): void {
  if (s.apiDown) return send(res, 503, { success: false, data: null, error: "down", meta: null });
  const routes = (s.extra.api ?? {}) as Record<string, unknown>;
  const filter = url.searchParams.get("filter");
  const data = url.pathname === "/api/v1/cycles" && filter && filter !== "all" ? filterRows(routes[url.pathname], filter) : routes[url.pathname];
  if (data === undefined) return send(res, 404, { success: false, data: null, error: "not found", meta: null });
  return send(res, 200, { success: true, data, error: null, meta: { cursor: null } });
}

function filterRows(rows: unknown, filter: string): unknown {
  const list = rows as { events: { name: string }[] }[];
  const last = (r: { events: { name: string }[] }) => r.events.at(-1)?.name;
  if (filter === "executed") return list.filter((r) => last(r) === "executed");
  if (filter === "hold") return list.filter((r) => last(r) === "hold");
  return list.filter((r) => last(r) !== "executed" && last(r) !== "hold");
}
