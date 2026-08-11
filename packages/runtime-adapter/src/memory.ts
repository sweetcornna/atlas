import {
  MEMORY_LAYERS,
  type MemoryLayer,
  type MemoryRecord,
  type MemoryStore,
  type NowFn,
} from "./types.ts";

/** The layer records fall into when `from` is archived; `null` when coldest. */
export function colderLayer(from: MemoryLayer): MemoryLayer | null {
  const index = MEMORY_LAYERS.indexOf(from);
  return MEMORY_LAYERS[index + 1] ?? null;
}

export interface MemoryStoreOptions {
  readonly now?: NowFn;
}

/**
 * Three-layer memory held in process.
 *
 * Archiving pushes a whole layer one step colder, which is how a finished
 * task's working set becomes project context, and project context eventually
 * becomes baseline knowledge.
 */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #layers = new Map<MemoryLayer, Map<string, MemoryRecord>>();
  readonly #now: NowFn;

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    for (const layer of MEMORY_LAYERS) {
      this.#layers.set(layer, new Map<string, MemoryRecord>());
    }
  }

  get(layer: MemoryLayer, key: string): MemoryRecord | undefined {
    return this.#layer(layer).get(key);
  }

  put(layer: MemoryLayer, key: string, value: unknown): MemoryRecord {
    const record: MemoryRecord = { key, value, layer, updatedAt: this.#now() };
    this.#layer(layer).set(key, record);
    return record;
  }

  /** Remove one record; `true` when it existed. */
  delete(layer: MemoryLayer, key: string): boolean {
    return this.#layer(layer).delete(key);
  }

  archive(fromLayer: MemoryLayer): number {
    const target = colderLayer(fromLayer);
    if (target === null) return 0;

    const source = this.#layer(fromLayer);
    const destination = this.#layer(target);
    const now = this.#now();
    let moved = 0;
    for (const record of source.values()) {
      destination.set(record.key, {
        key: record.key,
        value: record.value,
        layer: target,
        updatedAt: now,
      });
      moved += 1;
    }
    source.clear();
    return moved;
  }

  keys(layer: MemoryLayer): readonly string[] {
    return [...this.#layer(layer).keys()];
  }

  size(layer: MemoryLayer): number {
    return this.#layer(layer).size;
  }

  #layer(layer: MemoryLayer): Map<string, MemoryRecord> {
    const bucket = this.#layers.get(layer);
    if (bucket === undefined) throw new Error(`unknown memory layer: ${layer}`);
    return bucket;
  }
}
