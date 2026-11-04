import type { APIRequestContext } from "@playwright/test";

export const MOCK = "http://localhost:3199";

export async function useScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post(`${MOCK}/__scenario`, { data: { name } });
  if (!res.ok()) throw new Error(`scenario ${name}: ${res.status()}`);
}
