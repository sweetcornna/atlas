import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryMemoryStore, MEMORY_LAYERS, colderLayer } from "../src/index.ts";

let clock = 1_000;
let store: InMemoryMemoryStore;

beforeEach(() => {
  clock = 1_000;
  store = new InMemoryMemoryStore({ now: () => clock });
});

describe("layers", () => {
  test("are ordered hottest to coldest", () => {
    expect(MEMORY_LAYERS).toEqual(["working", "project", "baseline"]);
  });

  test("colderLayer walks one step down and stops at baseline", () => {
    expect(colderLayer("working")).toBe("project");
    expect(colderLayer("project")).toBe("baseline");
    expect(colderLayer("baseline")).toBeNull();
  });
});

describe("InMemoryMemoryStore", () => {
  test("put then get round-trips with provenance", () => {
    const record = store.put("working", "goal", { text: "ship M0" });
    expect(record.layer).toBe("working");
    expect(record.updatedAt).toBe(1_000);
    expect(store.get("working", "goal")?.value).toEqual({ text: "ship M0" });
  });

  test("layers are isolated", () => {
    store.put("working", "k", "hot");
    store.put("baseline", "k", "cold");
    expect(store.get("working", "k")?.value).toBe("hot");
    expect(store.get("baseline", "k")?.value).toBe("cold");
    expect(store.get("project", "k")).toBeUndefined();
  });

  test("put overwrites and restamps", () => {
    store.put("working", "k", 1);
    clock = 2_000;
    const updated = store.put("working", "k", 2);
    expect(updated.value).toBe(2);
    expect(updated.updatedAt).toBe(2_000);
    expect(store.size("working")).toBe(1);
  });

  test("delete removes a record", () => {
    store.put("project", "k", 1);
    expect(store.delete("project", "k")).toBe(true);
    expect(store.delete("project", "k")).toBe(false);
    expect(store.get("project", "k")).toBeUndefined();
  });

  test("archive moves a whole layer one step colder", () => {
    store.put("working", "a", 1);
    store.put("working", "b", 2);
    clock = 3_000;

    expect(store.archive("working")).toBe(2);
    expect(store.keys("working")).toEqual([]);
    expect(store.keys("project")).toEqual(["a", "b"]);

    const moved = store.get("project", "a");
    expect(moved?.value).toBe(1);
    expect(moved?.layer).toBe("project");
    expect(moved?.updatedAt).toBe(3_000);
  });

  test("archive cascades working -> project -> baseline", () => {
    store.put("working", "a", 1);
    store.archive("working");
    store.archive("project");
    expect(store.keys("baseline")).toEqual(["a"]);
    expect(store.get("baseline", "a")?.layer).toBe("baseline");
  });

  test("archiving baseline is a no-op", () => {
    store.put("baseline", "a", 1);
    expect(store.archive("baseline")).toBe(0);
    expect(store.keys("baseline")).toEqual(["a"]);
  });

  test("archiving an empty layer moves nothing", () => {
    expect(store.archive("working")).toBe(0);
  });

  test("archive overwrites a colliding key in the colder layer", () => {
    store.put("project", "k", "old");
    store.put("working", "k", "new");
    expect(store.archive("working")).toBe(1);
    expect(store.get("project", "k")?.value).toBe("new");
  });
});
