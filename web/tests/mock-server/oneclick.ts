import type http from "node:http";

import { type Scenario, send } from "./state";


export function handleOneClick(res: http.ServerResponse, s: Scenario, _url: URL, _body: string): void {
  if (s.oneClickDown) return send(res, 503, { message: "down" });
  return send(res, 404, { message: "not configured in this scenario" });
}
