import { Hono } from "hono";
import { MAX_TRACKED, clientAddress, concurrencyLimit, rateLimiter } from "../src/limits";

const envFrom = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });

function limitedApp(trustProxyFrom: string[], perMinute = 2) {
  const app = new Hono();
  app.use(rateLimiter({ perMinute, trustProxyFrom }));
  app.get("/", (c) => c.text("ok"));
  return app;
}

test("X-Real-IP is trusted only from the proxy network", async () => {
  const app = limitedApp(["172.18.0.0/16"]);
  const viaProxy = (ip: string) => app.request("/", { headers: { "x-real-ip": ip } }, envFrom("::ffff:172.18.0.5"));
  expect((await viaProxy("1.1.1.1")).status).toBe(200);
  expect((await viaProxy("1.1.1.1")).status).toBe(200);
  expect((await viaProxy("1.1.1.1")).status).toBe(429);
  expect((await viaProxy("2.2.2.2")).status).toBe(200);
});

test("a forged X-Real-IP from outside the proxy network is ignored", async () => {
  const app = limitedApp(["172.18.0.0/16"]);
  const forged = (ip: string) => app.request("/", { headers: { "x-real-ip": ip } }, envFrom("203.0.113.9"));
  expect((await forged("1.1.1.1")).status).toBe(200);
  expect((await forged("2.2.2.2")).status).toBe(200);
  expect((await forged("3.3.3.3")).status).toBe(429);
});

test("the window resets after a minute", async () => {
  vi.useFakeTimers();
  try {
    const app = limitedApp([], 1);
    expect((await app.request("/", {}, envFrom("9.9.9.9"))).status).toBe(200);
    expect((await app.request("/", {}, envFrom("9.9.9.9"))).status).toBe(429);
    vi.advanceTimersByTime(60_001);
    expect((await app.request("/", {}, envFrom("9.9.9.9"))).status).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ["10.1.2.3", ["10.1.2.3"], "1.1.1.1"],
  ["10.1.2.3", ["10.0.0.0/8"], "1.1.1.1"],
  ["10.1.2.3", ["192.168.0.0/16"], "10.1.2.3"],
  ["::ffff:10.1.2.3", ["10.0.0.0/8"], "1.1.1.1"],
  [undefined, ["10.0.0.0/8"], "unknown"],
])("clientAddress(%s, %j) is %s", (socket, trust, expected) => {
  expect(clientAddress(socket, "1.1.1.1", trust)).toBe(expected);
});

test("a trusted proxy without X-Real-IP falls back to the socket", () => {
  expect(clientAddress("10.1.2.3", undefined, ["10.0.0.0/8"])).toBe("10.1.2.3");
});

test("the 17th request running at once is 503", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const app = new Hono();
  app.use(concurrencyLimit(16));
  app.get("/", async (c) => {
    await gate;
    return c.text("ok");
  });
  const running = Array.from({ length: 16 }, () => app.request("/"));
  await new Promise((r) => setTimeout(r, 10));
  const extra = await app.request("/");
  expect(extra.status).toBe(503);
  release();
  expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(16).fill(200));
  expect((await app.request("/")).status).toBe(200);
});

test("IPv6 clients share one bucket per /64, since one host can hold the whole /64", async () => {
  const app = limitedApp([], 2);
  const from = (ip: string) => app.request("/", {}, envFrom(ip));
  expect((await from("2001:db8:1:2::1")).status).toBe(200);
  expect((await from("2001:db8:1:2:ffff::9")).status).toBe(200);
  expect((await from("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(429);
  expect((await from("2001:db8:1:3::1")).status).toBe(200);
});

test.each([
  ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
  ["2001:DB8:0001:0002:ffff:0:0:9", "2001:db8:1:2::/64"],
  ["::1", "0:0:0:0::/64"],
  ["::ffff:10.1.2.3", "10.1.2.3"],
  ["10.1.2.3", "10.1.2.3"],
])("clientKey(%s) is %s", async (ip, key) => {
  const { clientKey } = await import("../src/limits");
  expect(clientKey(ip)).toBe(key);
});

test("the bucket map is bounded and evicts the oldest active identity", async () => {
  let at = 1_000_000;
  const limiter = rateLimiter({ perMinute: 60, trustProxyFrom: [], now: () => at });
  const app = new Hono();
  app.use(limiter);
  app.get("/", (c) => c.text("ok"));

  const ip = (i: number) => `10.0.${Math.floor(i / 256)}.${i % 256}`;
  for (let i = 0; i < MAX_TRACKED; i++) {
    expect((await app.request("/", {}, envFrom(ip(i)))).status).toBe(200);
  }
  expect(limiter.tracked()).toBe(MAX_TRACKED);

  // A new identity evicts the oldest bucket instead of being refused; memory stays at the cap.
  expect((await app.request("/", {}, envFrom("192.0.2.1"))).status).toBe(200);
  expect(limiter.tracked()).toBe(MAX_TRACKED);

  // The evicted identity starts a fresh window rather than being blocked for the rest of the minute.
  expect((await app.request("/", {}, envFrom(ip(0)))).status).toBe(200);
  expect(limiter.tracked()).toBe(MAX_TRACKED);
  at += 60_001;
  expect(limiter.tracked()).toBeLessThanOrEqual(MAX_TRACKED);
}, 30_000);
