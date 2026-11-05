import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const here = join(__dirname, "..");
const read = (f: string) => readFileSync(join(here, f), "utf8");

interface Service { image?: string; build?: unknown; ports?: string[]; networks?: string[]; mem_limit?: string; cpus?: number; environment?: Record<string, string>; read_only?: boolean; user?: string }
// Compose applies YAML merge keys (`<<: *own`); the parser must too.
const compose = parse(read("compose.yml"), { merge: true }) as { services: Record<string, Service>; networks: Record<string, { internal?: boolean; ipam?: { config: { subnet: string }[] } }> };
const services = Object.entries(compose.services);
const DIGEST = /@sha256:[0-9a-f]{64}$/;

test("postgres publishes no port and sits on the db network only", () => {
  const pg = compose.services.postgres!;
  expect(pg.ports).toBeUndefined();
  expect(pg.networks).toEqual(["db"]);
});

test("only caddy publishes ports, and only 80 and 443", () => {
  const published = services.filter(([, s]) => s.ports).map(([n]) => n);
  expect(published).toEqual(["caddy"]);
  expect(compose.services.caddy!.ports).toEqual(["80:80", "443:443"]);
});

test("every service has a memory limit, and every pulled image is pinned to a digest", () => {
  for (const [name, s] of services) {
    expect(s.mem_limit, name).toMatch(/^\d+m$/);
    if (s.image) expect(s.image, name).toMatch(DIGEST);
    else expect(s.build, name).toBeDefined();
  }
});

test("limits match the plan", () => {
  const s = compose.services;
  expect([s.caddy!.mem_limit, s.api!.mem_limit, s.worker!.mem_limit, s.postgres!.mem_limit]).toEqual(["128m", "256m", "512m", "512m"]);
  expect([s.api!.cpus, s.worker!.cpus]).toEqual([0.5, 1]);
});

test("the worker is not on the edge network, and the db network has no way out", () => {
  expect(compose.services.worker!.networks).not.toContain("edge");
  expect(compose.services.api!.networks).toEqual(["edge", "db"]);
  expect(compose.networks.db!.internal).toBe(true);
});

test("the API trusts X-Real-IP only from the edge subnet", () => {
  const subnet = compose.networks.edge!.ipam!.config[0]!.subnet;
  expect(compose.services.api!.environment!.TRUST_PROXY_FROM).toBe(subnet);
});

test("our own containers run read-only", () => {
  for (const name of ["api", "worker", "migrate"]) expect(compose.services[name]!.read_only, name).toBe(true);
});

test("every Dockerfile pins its base images to digests and ends as a non-root user", () => {
  for (const f of ["Dockerfile.api", "Dockerfile.worker"]) {
    const text = read(f);
    const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    expect(froms.length, f).toBeGreaterThan(0);
    for (const image of froms.filter((i) => i !== "scratch")) expect(image, `${f} ${image}`).toMatch(DIGEST);
    const users = [...text.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1), f).toBe("node");
  }
});

test("the worker builds foundling-verify with the fetch feature at VERIFIER_COMMIT", () => {
  const text = read("Dockerfile.worker");
  expect(text).toMatch(/^ARG VERIFIER_COMMIT$/m);
  expect(text).toMatch(/cargo build --release --locked --features fetch/);
  const build = compose.services.worker!.build as { args: Record<string, string>; additional_contexts: Record<string, string> };
  expect(build.args.VERIFIER_COMMIT).toBe("${VERIFIER_COMMIT}");
  expect(build.additional_contexts["verifier-src"]).toBe("https://github.com/zakyirsyaad/foundling.git#${VERIFIER_COMMIT}");
});

test("Caddy proxies api.<domain> with X-Real-IP and HSTS", () => {
  const caddy = read("Caddyfile");
  expect(caddy).toMatch(/^api\.\{\$DOMAIN\} \{/m);
  expect(caddy).toMatch(/reverse_proxy api:8080/);
  expect(caddy).toMatch(/header_up X-Real-IP \{remote_host\}/);
  expect(caddy).toMatch(/Strict-Transport-Security "max-age=\d+/);
});

test(".env.example names every variable and holds no value", () => {
  const lines = read(".env.example").split("\n").filter((l) => l && !l.startsWith("#"));
  const names = lines.map((l) => l.split("=")[0]);
  for (const l of lines) expect(l, l).toMatch(/^[A-Z_]+=$/);
  for (const n of ["DOMAIN", "DATABASE_URL_READER", "DATABASE_URL_WRITER", "ACTIVE_VAULT_ID", "CHAIN", "OBS_SOURCE", "RPC_URLS", "ARCHIVAL_RPC_URLS", "FASTNEAR_API_KEY", "WEB_ORIGIN", "VERIFIER_COMMIT"]) {
    expect(names, n).toContain(n);
  }
  const used = new Set([...read("compose.yml").matchAll(/\$\{([A-Z_]+)(?::-[^}]*)?\}/g)].map((m) => m[1]));
  for (const n of used) expect(names, `compose uses ${n}`).toContain(n);
});

test("the build context never ships secrets or local state", () => {
  const ignore = readFileSync(join(here, "..", ".dockerignore"), "utf8").split("\n");
  for (const p of [".env", "**/.env*", "keys/", "**/*.key", "**/*.pem", "node_modules/", ".git/", ".superpowers/", "**/target/"]) expect(ignore, p).toContain(p);
});
