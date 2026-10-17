// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A working chat face for host tests (channels, background tasks): sessions,
 * transcripts, sends that get a task id, and agent replies, notices and host
 * notes the test writes. No module mocking.
 */

import type {
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleResult,
} from '@qianmo/console'

export class FakeChat implements ChatPort {
  readonly records = new Map<string, ChatTranscript>()
  readonly sent: ChatSendInput[] = []
  readonly opened: string[] = []
  readonly notes: { sessionId: string; text: string }[] = []
  readonly #listeners = new Set<(update: ChatUpdate) => void>()

  constructor(readonly agents: readonly string[]) {}

  async targets() {
    return {
      ok: true as const,
      value: this.agents.map(address => ({
        address,
        node: address.split('/')[2]!,
        agent: address.split('/')[3]!,
        endpoint: 'ws://127.0.0.1:1',
        status: 'online',
        dialable: true,
      })),
    }
  }

  async sessions() {
    return {
      ok: true as const,
      value: [...this.records.values()].map(record => record.session),
    }
  }

  async open(target: string) {
    this.opened.push(target)
    const session: ChatSession = {
      id: crypto.randomUUID(),
      target,
      node: 'n',
      agent: 'a',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 0,
      preview: '',
    }
    this.records.set(session.id, { session, turns: [] })
    return { ok: true as const, value: session }
  }

  async transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>> {
    const record = this.records.get(sessionId)
    return record
      ? { ok: true, value: record }
      : { ok: false, failure: { code: 'not_found', message: 'gone' } }
  }

  async send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    this.sent.push(input)
    const turn: ChatTurn = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      text: input.text,
      author: 'operator',
      at: Date.now(),
      state: 'delivered',
      taskId: crypto.randomUUID(),
    }
    this.#add(turn)
    return { ok: true, value: turn }
  }

  #add(turn: ChatTurn): void {
    const record = this.records.get(turn.sessionId)!
    this.records.set(turn.sessionId, {
      ...record,
      turns: [...record.turns, turn],
    })
    for (const listener of this.#listeners)
      listener({ sessionId: turn.sessionId, revision: 1 })
  }

  /** The task id of the last line sent into a session. */
  lastTask(sessionId: string): string {
    return [...this.records.get(sessionId)!.turns]
      .reverse()
      .find(turn => turn.author === 'operator')!.taskId!
  }

  reply(
    sessionId: string,
    text: string,
    state: 'done' | 'failed' = 'done',
    extra: Partial<ChatTurn> = {},
  ): void {
    this.#add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: Date.now(),
      text,
      state,
      taskId: this.lastTask(sessionId),
      ...extra,
    })
  }

  /**
   * A timeout for the last line: the node's own (`remote`, with the
   * `remoteTerminal` mark) or the chat face's local guess after its deadline.
   */
  timeout(sessionId: string, remote: boolean): void {
    this.#add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: Date.now(),
      text: remote
        ? 'resident task deadline expired'
        : '这一轮在任务期限内没有回复。',
      state: 'failed',
      code: 'E_TASK_TIMEOUT',
      taskId: this.lastTask(sessionId),
      ...(remote ? { remoteTerminal: true as const } : {}),
    })
  }

  notice(sessionId: string, text: string): void {
    this.#add({
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: Date.now(),
      text,
      state: 'done',
      variant: 'notice',
      noticeSource: 'agent',
      causeTaskId: this.lastTask(sessionId),
    })
  }

  async note(
    sessionId: string,
    text: string,
  ): Promise<ConsoleResult<ChatTurn>> {
    if (!this.records.has(sessionId))
      return { ok: false, failure: { code: 'not_found', message: 'gone' } }
    this.notes.push({ sessionId, text })
    const turn: ChatTurn = {
      id: crypto.randomUUID(),
      sessionId,
      author: 'agent',
      at: Date.now(),
      text,
      state: 'done',
      variant: 'notice',
      noticeSource: 'task',
    }
    this.#add(turn)
    return { ok: true, value: turn }
  }

  /** Lines sent into a session, oldest first. */
  sentTo(sessionId: string): ChatSendInput[] {
    return this.sent.filter(one => one.sessionId === sessionId)
  }

  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}
