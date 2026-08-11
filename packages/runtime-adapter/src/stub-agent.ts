import { assertValidMessage, formatAddress, withHop, type QianmoMessage } from "@qianmo/protocol";
import { InMemoryMailbox } from "./mailbox.ts";
import { InMemoryMemoryStore } from "./memory.ts";
import {
  AgentStateError,
  type AgentNode,
  type AgentState,
  type Mailbox,
  type MemoryStore,
  type NowFn,
} from "./types.ts";

export interface StubAgentNodeOptions {
  /** Agent name, the second segment of its address. */
  readonly name: string;
  /** Host node name, the first segment of its address. */
  readonly node?: string;
  readonly mailbox?: Mailbox;
  readonly memory?: MemoryStore;
  readonly now?: NowFn;
}

/**
 * Reference {@link AgentNode} with no real runtime behind it.
 *
 * It exists so the network layers (protocol, registry, routing) can be built
 * and tested before the actual agent base is wired in: messages are validated
 * for real, then parked in a mailbox instead of being executed.
 */
export class StubAgentNode implements AgentNode {
  readonly name: string;
  readonly node: string;
  readonly mailbox: Mailbox;
  readonly memory: MemoryStore;

  #state: AgentState = "stopped";
  readonly #wakeReasons: string[] = [];
  readonly #now: NowFn;

  constructor(options: StubAgentNodeOptions) {
    this.name = options.name;
    this.node = options.node ?? "local";
    this.mailbox = options.mailbox ?? new InMemoryMailbox();
    this.memory = options.memory ?? new InMemoryMemoryStore();
    this.#now = options.now ?? Date.now;
  }

  /** Full address of this agent, `qianmo://<node>/<name>`. */
  get address(): string {
    return formatAddress({ node: this.node, agent: this.name });
  }

  get state(): AgentState {
    return this.#state;
  }

  /** Every reason this agent was woken, oldest first. */
  get wakeReasons(): readonly string[] {
    return [...this.#wakeReasons];
  }

  async start(): Promise<void> {
    this.#state = "running";
  }

  async sleep(): Promise<void> {
    if (this.#state === "stopped") {
      throw new AgentStateError(`cannot sleep ${this.name}: agent is stopped`, this.#state);
    }
    this.#state = "sleeping";
  }

  async wake(reason: string): Promise<void> {
    if (this.#state === "stopped") {
      throw new AgentStateError(`cannot wake ${this.name}: agent is stopped`, this.#state);
    }
    this.#wakeReasons.push(reason);
    this.#state = "running";
  }

  async stop(): Promise<void> {
    this.#state = "stopped";
  }

  /**
   * Validate an inbound message and park it in the mailbox, waking the agent
   * first when it was asleep. The local node is appended to `hops` so the
   * stored envelope reflects the path it actually travelled.
   */
  async dispatch(message: QianmoMessage): Promise<void> {
    if (this.#state === "stopped") {
      throw new AgentStateError(
        `cannot dispatch to ${this.name}: agent is stopped`,
        this.#state,
      );
    }
    assertValidMessage(message, { node: this.node, now: this.#now() });

    if (this.#state === "sleeping") {
      await this.wake(`message:${message.type}`);
    }
    this.mailbox.deliver(withHop(message, this.node));
  }
}
