import { beforeEach, describe, expect, test } from "bun:test";
import {
  MessageType,
  ProtocolError,
  ProtocolErrorCode,
  createMessage,
  type QianmoMessage,
} from "@qianmo/protocol";
import { AgentStateError, InMemoryMailbox, StubAgentNode } from "../src/index.ts";

const NOW = 1_700_000_000_000;

function inbound(overrides: Partial<QianmoMessage> = {}): QianmoMessage {
  return {
    ...createMessage({
      from: "qianmo://tokyo-1/planner",
      to: "qianmo://local/worker",
      type: MessageType.TaskRequest,
      payload: { goal: "summarise" },
      msgId: "m-1",
      createdAt: NOW,
      ttlMs: 10_000,
      hops: ["tokyo-1"],
    }),
    ...overrides,
  };
}

let mailbox: InMemoryMailbox;
let agent: StubAgentNode;

beforeEach(() => {
  mailbox = new InMemoryMailbox();
  agent = new StubAgentNode({ name: "worker", node: "local", mailbox, now: () => NOW });
});

describe("lifecycle", () => {
  test("starts stopped and exposes its address", () => {
    expect(agent.state).toBe("stopped");
    expect(agent.name).toBe("worker");
    expect(agent.address).toBe("qianmo://local/worker");
  });

  test("start -> sleep -> wake walks the state machine", async () => {
    await agent.start();
    expect(agent.state).toBe("running");

    await agent.sleep();
    expect(agent.state).toBe("sleeping");

    await agent.wake("scheduled");
    expect(agent.state).toBe("running");
    expect(agent.wakeReasons).toEqual(["scheduled"]);
  });

  test("start is idempotent and stop returns to stopped", async () => {
    await agent.start();
    await agent.start();
    expect(agent.state).toBe("running");
    await agent.stop();
    expect(agent.state).toBe("stopped");
  });

  test("a stopped agent cannot sleep or wake", async () => {
    await expectAgentStateError(() => agent.sleep());
    await expectAgentStateError(() => agent.wake("nudge"));
  });
});

describe("dispatch", () => {
  test("parks a valid message in the mailbox and records the hop", async () => {
    await agent.start();
    await agent.dispatch(inbound());

    expect(mailbox.size).toBe(1);
    const stored = mailbox.take();
    expect(stored?.msgId).toBe("m-1");
    expect(stored?.hops).toEqual(["tokyo-1", "local"]);
  });

  test("wakes a sleeping agent and notes why", async () => {
    await agent.start();
    await agent.sleep();
    expect(agent.state).toBe("sleeping");

    await agent.dispatch(inbound({ type: MessageType.Wake }));

    expect(agent.state).toBe("running");
    expect(agent.wakeReasons).toEqual(["message:wake"]);
    expect(mailbox.size).toBe(1);
  });

  test("refuses delivery while stopped", async () => {
    await expectAgentStateError(() => agent.dispatch(inbound()));
    expect(mailbox.size).toBe(0);
  });

  test("rejects a message that already visited this node (E_LOOP)", async () => {
    await agent.start();
    await expectProtocolError(
      () => agent.dispatch(inbound({ hops: ["tokyo-1", "local"] })),
      ProtocolErrorCode.E_LOOP,
    );
    expect(mailbox.size).toBe(0);
  });

  test("rejects an expired message (E_TTL_EXPIRED)", async () => {
    await agent.start();
    await expectProtocolError(
      () => agent.dispatch(inbound({ createdAt: NOW - 20_000 })),
      ProtocolErrorCode.E_TTL_EXPIRED,
    );
    expect(mailbox.size).toBe(0);
  });

  test("rejects a structurally invalid message", async () => {
    await agent.start();
    await expectProtocolError(
      () => agent.dispatch(inbound({ to: "not-an-address" })),
      ProtocolErrorCode.E_BAD_ADDRESS,
    );
  });

  test("keeps its own mailbox and memory when none are injected", async () => {
    const solo = new StubAgentNode({ name: "solo", node: "local", now: () => NOW });
    await solo.start();
    await solo.dispatch(inbound({ to: "qianmo://local/solo" }));
    expect(solo.mailbox.size).toBe(1);

    solo.memory.put("working", "last", "m-1");
    expect(solo.memory.get("working", "last")?.value).toBe("m-1");
  });
});

async function expectAgentStateError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentStateError);
    return;
  }
  throw new Error("expected an AgentStateError");
}

async function expectProtocolError(
  run: () => Promise<unknown>,
  code: ProtocolErrorCode,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ProtocolError with code ${code}`);
}
