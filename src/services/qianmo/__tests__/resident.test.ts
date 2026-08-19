import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Qianmo resident host boundary', () => {
  test('derives every persistent path through occConfigPath', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    expect(source).toContain("occConfigPath('resident', 'sessions.json')")
    expect(source).toContain(
      "occConfigPath('resident', agent, 'admission.ndjson')",
    )
    expect(source).not.toMatch(/homedir\(|\.qianmo['"`]/)
  })

  test('spawns ACP with the Qianmo identity and no daemon credential surface', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    // 钉源码而不是钉行为：这条路径会真的 spawn 一个子进程，测行为要起进程。
    // 钉的是「取自 identity.ts 的常量」而不是字面量——身份名只许在那一处拼写。
    expect(source).toContain('[IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE')
    expect(source).toContain("from '../../constants/identity.js'")
    expect(source).not.toMatch(/DAEMON_TOKEN|destroySandbox|execCommand/)
  })

  test('reads the requester context off the envelope already in the mailbox entry', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    // 钉源码同上：这条线要真跑得起 ACP 子进程。钉的是「contextId 从既有信封
    // 提取器里取」——协议、适配器、基座都不因多会话隔离而多传一个字段。
    expect(source).toContain('networkEnvelope(messages[0])?.contextId')
    // 会话不再是「每 agent 一条」写死在 binding 上，而是由 manager 按
    // (agent, contextId) 现解析——runtime 收的是 resolver 不是 sessionId。
    // 两条分开钉：中间可以插别的选项，「不再写死 sessionId」才是要点。
    expect(source).toContain('contextId: networkContextId,')
    expect(source).toContain('\n        sessions,\n')
    expect(source).toContain('pendingSessionIds(')
  })

  test('receipts the durable write and does not await the turn behind it', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'resident.ts'),
      'utf8',
    )

    // 钉源码而不是钉行为的理由同上；这里钉的是**顺序**，而顺序正是 H-3 的全部内容。
    // 行为侧另有集成用例（占门时第二条 5 s 内 Accepted），这条防的是把 await 加回去。
    const assertAt = source.indexOf('runtime.assertDeliverable(message)')
    const writeAt = source.indexOf('await this.#adapter.deliver(message')
    const turnAt = source.indexOf('this.#startTurn(runtime, message)')
    expect(assertAt).toBeGreaterThan(-1)
    expect(assertAt).toBeLessThan(writeAt)
    expect(writeAt).toBeLessThan(turnAt)
    // 轮询不带 await：回执欠的是「已落盘」，不是「已排上队」。
    expect(source).toContain('void runtime.deliver(message).catch(')
    expect(source).not.toContain('await runtime.deliver(')
    // 协议 ack 的发出点一行未动：仍然只挂在 onRead 上。
    expect(source).toContain(
      'onRead: (input, readAt) => this.#ackTask(input, readAt)',
    )
  })
})
