import type { QianmoMessage } from "@qianmo/protocol";
import type { Mailbox } from "./types.ts";

/**
 * Unbounded in-process FIFO mailbox.
 *
 * Reference implementation for tests and single-process nodes; a durable
 * mailbox will replace it once messages must survive a restart.
 */
export class InMemoryMailbox implements Mailbox {
  readonly #queue: QianmoMessage[] = [];

  deliver(message: QianmoMessage): void {
    this.#queue.push(message);
  }

  take(): QianmoMessage | undefined {
    return this.#queue.shift();
  }

  /** Oldest message without removing it. */
  peek(): QianmoMessage | undefined {
    return this.#queue[0];
  }

  /** Remove and return everything, oldest first. */
  drain(): readonly QianmoMessage[] {
    return this.#queue.splice(0, this.#queue.length);
  }

  get size(): number {
    return this.#queue.length;
  }
}
