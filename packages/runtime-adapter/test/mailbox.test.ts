import { beforeEach, describe, expect, test } from "bun:test";
import { MessageType, createMessage, type QianmoMessage } from "@qianmo/protocol";
import { InMemoryMailbox } from "../src/index.ts";

function message(msgId: string): QianmoMessage {
  return createMessage({
    from: "qianmo://tokyo-1/planner",
    to: "qianmo://local/worker",
    type: MessageType.TaskRequest,
    payload: { msgId },
    msgId,
    createdAt: 1_000,
  });
}

let mailbox: InMemoryMailbox;

beforeEach(() => {
  mailbox = new InMemoryMailbox();
});

describe("InMemoryMailbox", () => {
  test("starts empty", () => {
    expect(mailbox.size).toBe(0);
    expect(mailbox.take()).toBeUndefined();
    expect(mailbox.peek()).toBeUndefined();
  });

  test("delivers and takes in FIFO order", () => {
    mailbox.deliver(message("a"));
    mailbox.deliver(message("b"));
    expect(mailbox.size).toBe(2);
    expect(mailbox.peek()?.msgId).toBe("a");
    expect(mailbox.take()?.msgId).toBe("a");
    expect(mailbox.take()?.msgId).toBe("b");
    expect(mailbox.size).toBe(0);
  });

  test("peek does not consume", () => {
    mailbox.deliver(message("a"));
    expect(mailbox.peek()?.msgId).toBe("a");
    expect(mailbox.size).toBe(1);
  });

  test("drain empties the queue and preserves order", () => {
    mailbox.deliver(message("a"));
    mailbox.deliver(message("b"));
    expect(mailbox.drain().map((m) => m.msgId)).toEqual(["a", "b"]);
    expect(mailbox.size).toBe(0);
    expect(mailbox.drain()).toEqual([]);
  });
});
