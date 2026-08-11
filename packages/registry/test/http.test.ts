import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryRegistry,
  ManualClock,
  RegistryErrorCode,
  startRegistryServer,
  type RegistryServerHandle,
} from "../src/index.ts";

const TTL = 90_000;
const ENDPOINT = "qianmo://tokyo-1/planner";

let clock: ManualClock;
let registry: InMemoryRegistry;
let server: RegistryServerHandle;

beforeAll(() => {
  clock = new ManualClock(1_000);
  registry = new InMemoryRegistry({ ttlMs: TTL, clock });
  // Port 0: let the OS pick a free port so tests never collide.
  server = startRegistryServer(0, { registry });
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  registry.clear();
  clock.set(1_000);
});

async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return parsed as Record<string, unknown>;
}

function post(path: string, payload?: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
}

describe("registry http api v0", () => {
  test("binds a real, non-zero port", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toContain(String(server.port));
  });

  test("POST /v0/agents creates an agent (201) then refreshes it (200)", async () => {
    const created = await post("/v0/agents", {
      name: "planner",
      endpoint: ENDPOINT,
      capabilities: ["plan"],
    });
    expect(created.status).toBe(201);
    const createdBody = await body(created);
    expect(createdBody["name"]).toBe("planner");
    expect(createdBody["capabilities"]).toEqual(["plan"]);
    expect(createdBody["expiresAt"]).toBe(1_000 + TTL);

    const refreshed = await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });
    expect(refreshed.status).toBe(200);
  });

  test("POST /v0/agents rejects a bad body with 400", async () => {
    const noJson = await post("/v0/agents");
    expect(noJson.status).toBe(400);

    const badName = await post("/v0/agents", { name: "Bad Name", endpoint: ENDPOINT });
    expect(badName.status).toBe(400);
    const errorBody = await body(badName);
    const error = errorBody["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RegistryErrorCode.E_BAD_REQUEST);

    const badEndpoint = await post("/v0/agents", { name: "planner", endpoint: "nope" });
    expect(badEndpoint.status).toBe(400);
  });

  test("POST /v0/agents returns 409 on an endpoint clash", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });
    const clash = await post("/v0/agents", {
      name: "planner",
      endpoint: "qianmo://osaka-2/planner",
    });
    expect(clash.status).toBe(409);
    const error = (await body(clash))["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RegistryErrorCode.E_CONFLICT);
  });

  test("GET /v0/agents lists live agents", async () => {
    await post("/v0/agents", { name: "worker", endpoint: "qianmo://osaka-2/worker" });
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });

    const response = await fetch(`${server.url}/v0/agents`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const agents = (await body(response))["agents"] as ReadonlyArray<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a["name"])).toEqual(["planner", "worker"]);
  });

  test("GET /v0/agents/:name resolves or 404s", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });

    const hit = await fetch(`${server.url}/v0/agents/planner`);
    expect(hit.status).toBe(200);
    expect((await body(hit))["endpoint"]).toBe(ENDPOINT);

    const miss = await fetch(`${server.url}/v0/agents/ghost`);
    expect(miss.status).toBe(404);
    const error = (await body(miss))["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(RegistryErrorCode.E_NOT_FOUND);
  });

  test("POST /v0/agents/:name/heartbeat extends the lease, 404 when unknown", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });
    clock.advance(30_000);

    const beat = await post("/v0/agents/planner/heartbeat");
    expect(beat.status).toBe(200);
    const beatBody = await body(beat);
    expect(beatBody["lastHeartbeatAt"]).toBe(31_000);
    expect(beatBody["expiresAt"]).toBe(31_000 + TTL);

    const missing = await post("/v0/agents/ghost/heartbeat");
    expect(missing.status).toBe(404);
  });

  test("DELETE /v0/agents/:name returns 204 then 404", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });

    const gone = await fetch(`${server.url}/v0/agents/planner`, { method: "DELETE" });
    expect(gone.status).toBe(204);

    const again = await fetch(`${server.url}/v0/agents/planner`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("expired agents disappear from the HTTP surface too", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });
    clock.advance(TTL + 1);

    const resolved = await fetch(`${server.url}/v0/agents/planner`);
    expect(resolved.status).toBe(404);

    const listed = (await body(await fetch(`${server.url}/v0/agents`)))["agents"];
    expect(listed).toEqual([]);
  });

  test("unknown routes 404 and wrong methods 405", async () => {
    expect((await fetch(`${server.url}/v1/agents`)).status).toBe(404);
    expect((await fetch(`${server.url}/v0/nodes`)).status).toBe(404);
    expect((await fetch(`${server.url}/v0/agents/planner/unknown`)).status).toBe(404);

    const wrongMethod = await fetch(`${server.url}/v0/agents`, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");

    const wrongHeartbeat = await fetch(`${server.url}/v0/agents/planner/heartbeat`);
    expect(wrongHeartbeat.status).toBe(405);
  });

  test("GET /v0/health reports the live agent count", async () => {
    await post("/v0/agents", { name: "planner", endpoint: ENDPOINT });
    const health = await body(await fetch(`${server.url}/v0/health`));
    expect(health["status"]).toBe("ok");
    expect(health["agents"]).toBe(1);
  });
});
