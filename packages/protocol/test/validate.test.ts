import { describe, expect, test } from "bun:test";
import {
  LIMITS,
  MessageType,
  ProtocolError,
  ProtocolErrorCode,
  assertValidMessage,
  createMessage,
  firstErrorCode,
  validateMessage,
  type QianmoMessage,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;

function sample(overrides: Partial<QianmoMessage> = {}): Record<string, unknown> {
  const base = createMessage({
    from: "qianmo://tokyo-1/planner",
    to: "qianmo://osaka-2/worker",
    type: MessageType.TaskRequest,
    payload: { goal: "summarise" },
    msgId: "m-1",
    traceId: "t-1",
    createdAt: NOW,
    ttlMs: 10_000,
  });
  return { ...base, ...overrides };
}

function codesOf(input: unknown, node?: string): readonly ProtocolErrorCode[] {
  const result = validateMessage(
    input,
    node === undefined ? { now: NOW } : { now: NOW, node },
  );
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("validateMessage — accepts", () => {
  test("a freshly created message", () => {
    const result = validateMessage(sample(), { now: NOW });
    expect(result.ok).toBe(true);
    expect(firstErrorCode(result)).toBeNull();
  });

  test("a message that has legitimately travelled", () => {
    expect(codesOf(sample({ hops: ["tokyo-1", "relay-3"] }), "osaka-2")).toEqual([]);
  });

  test("a message on its very last millisecond", () => {
    const result = validateMessage(sample({ createdAt: NOW - 10_000 }), { now: NOW });
    expect(result.ok).toBe(true);
  });

  test("every declared message type", () => {
    for (const type of Object.values(MessageType)) {
      expect(codesOf(sample({ type }))).toEqual([]);
    }
  });

  test("narrows the value on success", () => {
    const result = validateMessage(sample(), { now: NOW });
    if (!result.ok) throw new Error("expected ok");
    expect(result.message.type).toBe(MessageType.TaskRequest);
    expect(result.message.msgId).toBe("m-1");
  });
});

describe("validateMessage — structure", () => {
  test("rejects non-objects", () => {
    expect(codesOf(null)).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE]);
    expect(codesOf("a string")).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE]);
    expect(codesOf([])).toEqual([ProtocolErrorCode.E_BAD_ENVELOPE]);
  });

  test("rejects an unknown envelope version", () => {
    expect(codesOf({ ...sample(), v: 1 })).toContain(ProtocolErrorCode.E_BAD_VERSION);
  });

  test("rejects missing identifiers", () => {
    expect(codesOf({ ...sample(), msgId: "" })).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
    expect(codesOf({ ...sample(), traceId: 5 })).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
  });

  test("rejects bad addresses on either side", () => {
    expect(codesOf({ ...sample(), from: "tokyo-1/planner" })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    );
    expect(codesOf({ ...sample(), to: "qianmo://osaka-2" })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    );
  });

  test("rejects an unknown message type", () => {
    expect(codesOf({ ...sample(), type: "task.cancel" })).toContain(ProtocolErrorCode.E_BAD_TYPE);
  });

  test("rejects a missing payload key", () => {
    const { payload: _payload, ...withoutPayload } = sample();
    expect(codesOf(withoutPayload)).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
  });

  test("rejects non-positive timestamps and ttl", () => {
    expect(codesOf({ ...sample(), createdAt: 0 })).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
    expect(codesOf({ ...sample(), createdAt: Number.NaN })).toContain(
      ProtocolErrorCode.E_BAD_ENVELOPE,
    );
    expect(codesOf({ ...sample(), ttlMs: -1 })).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
  });

  test("rejects a malformed hop list", () => {
    expect(codesOf({ ...sample(), hops: "tokyo-1" })).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
    expect(codesOf({ ...sample(), hops: ["tokyo-1", 3] })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    );
    expect(codesOf({ ...sample(), hops: ["NOT A NODE"] })).toContain(
      ProtocolErrorCode.E_BAD_ADDRESS,
    );
  });

  test("reports every structural problem at once", () => {
    const codes = codesOf({ ...sample(), v: 3, msgId: "", to: "nope" });
    expect(codes).toContain(ProtocolErrorCode.E_BAD_VERSION);
    expect(codes).toContain(ProtocolErrorCode.E_BAD_ENVELOPE);
    expect(codes).toContain(ProtocolErrorCode.E_BAD_ADDRESS);
  });
});

describe("validateMessage — boundaries", () => {
  test("rejects an expired message with E_TTL_EXPIRED", () => {
    const expired = sample({ createdAt: NOW - 10_001 });
    expect(codesOf(expired)).toEqual([ProtocolErrorCode.E_TTL_EXPIRED]);
  });

  test("rejects an oversized message with E_TOO_LARGE", () => {
    const huge = sample({ payload: "x".repeat(LIMITS.maxMessageBytes + 1) });
    expect(codesOf(huge)).toEqual([ProtocolErrorCode.E_TOO_LARGE]);
  });

  test("honours an injected size limit", () => {
    const result = validateMessage(sample(), { now: NOW, maxMessageBytes: 10 });
    expect(firstErrorCode(result)).toBe(ProtocolErrorCode.E_TOO_LARGE);
  });

  test("rejects too many hops with E_TOO_MANY_HOPS", () => {
    const hops = Array.from({ length: LIMITS.maxHops + 1 }, (_, i) => `n${i}`);
    expect(codesOf(sample({ hops }))).toEqual([ProtocolErrorCode.E_TOO_MANY_HOPS]);
    const atLimit = Array.from({ length: LIMITS.maxHops }, (_, i) => `n${i}`);
    expect(codesOf(sample({ hops: atLimit }))).toEqual([]);
  });

  test("rejects a message that already visited this node (E_LOOP)", () => {
    const codes = codesOf(sample({ hops: ["tokyo-1", "relay-3"] }), "relay-3");
    expect(codes).toEqual([ProtocolErrorCode.E_LOOP]);
  });

  test("rejects duplicated hops even without a node hint", () => {
    expect(codesOf(sample({ hops: ["relay-3", "relay-3"] }))).toEqual([ProtocolErrorCode.E_LOOP]);
  });

  test("a node absent from hops is not a loop", () => {
    expect(codesOf(sample({ hops: ["tokyo-1"] }), "osaka-2")).toEqual([]);
  });
});

describe("assertValidMessage", () => {
  test("returns the message when valid", () => {
    const message = assertValidMessage(sample(), { now: NOW });
    expect(message.msgId).toBe("m-1");
  });

  test("throws a ProtocolError carrying the first code", () => {
    try {
      assertValidMessage(sample({ createdAt: NOW - 60_000 }), { now: NOW });
      throw new Error("expected assertValidMessage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.E_TTL_EXPIRED);
      expect((error as ProtocolError).issues.length).toBeGreaterThan(0);
    }
  });
});
