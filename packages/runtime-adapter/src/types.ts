import type { QianmoMessage } from "@qianmo/protocol";

/** Injectable time source; defaults to `Date.now` everywhere. */
export type NowFn = () => number;

/**
 * Lifecycle of a resident agent.
 *
 * `sleeping` is the cost-saving state: the agent keeps its identity and
 * memory but consumes no compute until something wakes it.
 */
export type AgentState = "running" | "sleeping" | "stopped";

/** The seam every runtime (stub today, real base later) must implement. */
export interface AgentNode {
  /** Agent name, unique within its host node. */
  readonly name: string;
  readonly state: AgentState;
  /** Bring the agent up. No-op when already `running`. */
  start(): Promise<void>;
  /** Suspend the agent, keeping its mailbox and memory. */
  sleep(): Promise<void>;
  /** Resume a sleeping agent; `reason` is recorded for observability. */
  wake(reason: string): Promise<void>;
  /** Shut the agent down; it must be started again before use. */
  stop(): Promise<void>;
  /** Hand an inbound message to the agent. */
  dispatch(message: QianmoMessage): Promise<void>;
}

/** FIFO inbox sitting between the network and an agent. */
export interface Mailbox {
  /** Enqueue a message. */
  deliver(message: QianmoMessage): void;
  /** Dequeue the oldest message, or `undefined` when empty. */
  take(): QianmoMessage | undefined;
  readonly size: number;
}

/**
 * The three memory layers of a resident agent, hottest first:
 * `working` (current task), `project` (this project's accumulated context),
 * `baseline` (long-lived, cross-project knowledge).
 */
export type MemoryLayer = "working" | "project" | "baseline";

/** Memory layers ordered from hottest to coldest. */
export const MEMORY_LAYERS: readonly MemoryLayer[] = Object.freeze([
  "working",
  "project",
  "baseline",
]);

/** One stored value plus its provenance. */
export interface MemoryRecord {
  readonly key: string;
  readonly value: unknown;
  readonly layer: MemoryLayer;
  readonly updatedAt: number;
}

/** Layered store an agent reads from and writes to. */
export interface MemoryStore {
  get(layer: MemoryLayer, key: string): MemoryRecord | undefined;
  put(layer: MemoryLayer, key: string, value: unknown): MemoryRecord;
  /**
   * Move every record from `fromLayer` down to the next colder layer,
   * returning how many were moved. Archiving `baseline` is a no-op.
   */
  archive(fromLayer: MemoryLayer): number;
  keys(layer: MemoryLayer): readonly string[];
}

/** Raised when an operation is illegal for the agent's current state. */
export class AgentStateError extends Error {
  readonly state: AgentState;

  constructor(message: string, state: AgentState) {
    super(message);
    this.name = "AgentStateError";
    this.state = state;
  }
}
