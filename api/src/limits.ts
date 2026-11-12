/** Abuse limits for the public API (WEBSITE §5): per-address rate, global concurrency, and the trusted proxy rule. */
import type { Context, MiddlewareHandler } from "hono";
import { failure } from "./envelope";

const WINDOW_MS = 60_000;
/** Bounds the limiter's memory under a spray of addresses. */
export const MAX_TRACKED = 10_000;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

const unmap = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

function inRange(ip: string, rule: string): boolean {
  const [base, bits] = rule.split("/");
  if (bits === undefined) return unmap(ip) === unmap(base!);
  const a = ipv4ToInt(unmap(ip));
  const b = ipv4ToInt(base!);
  const prefix = Number(bits);
  if (a === null || b === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** `X-Real-IP` counts only when the socket peer is the proxy; anyone else could forge it. */
export function clientAddress(socket: string | undefined, realIp: string | undefined, trustProxyFrom: string[]): string {
  if (!socket) return "unknown";
  if (realIp && trustProxyFrom.some((rule) => inRange(socket, rule))) return realIp.trim();
  return unmap(socket);
}

type NodeEnv = { incoming?: { socket?: { remoteAddress?: string } } };
export const socketAddress = (c: Context): string | undefined => (c.env as NodeEnv | undefined)?.incoming?.socket?.remoteAddress;

/** The eight hextets of an IPv6 address, or null when it is not one. */
function hextets(ip: string): string[] | null {
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => h.replace(/^0+(?=.)/, ""));
}

/**
 * The bucket a client counts against. An IPv6 host usually holds a whole /64, so every address in it is one
 * client; IPv4 (and IPv4-mapped IPv6) is one address.
 */
export function clientKey(address: string): string {
  const ip = unmap(address);
  if (!ip.includes(":")) return ip;
  const h = hextets(ip);
  return h ? `${h.slice(0, 4).join(":")}::/64` : ip;
}

export function rateLimiter(opts: { perMinute: number; trustProxyFrom: string[]; now?: () => number }): MiddlewareHandler & { tracked: () => number } {
  const windows = new Map<string, { start: number; count: number }>();
  const now = opts.now ?? Date.now;

  /** Drops expired windows, then evicts the oldest active bucket until one slot is free. */
  const makeRoom = (at: number) => {
    for (const [k, w] of windows) if (at - w.start >= WINDOW_MS) windows.delete(k);
    while (windows.size >= MAX_TRACKED) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
  };

  const limiter: MiddlewareHandler = async (c, next) => {
    const at = now();
    const key = clientKey(clientAddress(socketAddress(c), c.req.header("x-real-ip"), opts.trustProxyFrom));
    const w = windows.get(key);
    if (w && at - w.start < WINDOW_MS) {
      if (++w.count > opts.perMinute) {
        c.header("retry-after", String(Math.ceil((w.start + WINDOW_MS - at) / 1000)));
        return failure(c, 429, "too many requests");
      }
    } else {
      if (w) windows.delete(key);
      makeRoom(at);
      windows.set(key, { start: at, count: 1 });
    }
    await next();
  };

  return Object.assign(limiter, { tracked: () => windows.size });
}

export function concurrencyLimit(max: number): MiddlewareHandler {
  let running = 0;
  return async (c, next) => {
    if (running >= max) return failure(c, 503, "busy, try again shortly");
    running++;
    try {
      await next();
    } finally {
      running--;
    }
  };
}
