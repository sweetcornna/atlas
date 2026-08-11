/**
 * `@qianmo/runtime-adapter` — the seam between the Qianmo network and whatever
 * actually runs an agent.
 *
 * This milestone ships interfaces plus in-memory reference implementations;
 * the adapter for the real agent base lands after M0.
 */

export {
  AgentStateError,
  MEMORY_LAYERS,
  type AgentNode,
  type AgentState,
  type Mailbox,
  type MemoryLayer,
  type MemoryRecord,
  type MemoryStore,
  type NowFn,
} from "./types.ts";

export { InMemoryMailbox } from "./mailbox.ts";

export {
  InMemoryMemoryStore,
  colderLayer,
  type MemoryStoreOptions,
} from "./memory.ts";

export { StubAgentNode, type StubAgentNodeOptions } from "./stub-agent.ts";
