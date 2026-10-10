// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Qianmo resident host boundary', () => {
  test('derives every persistent path through qianmoConfigPath', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/host/resident.ts'),
      'utf8',
    )

    expect(source).toContain("qianmoConfigPath('resident', 'sessions.json')")
    expect(source).toContain(
      "qianmoConfigPath('resident', agent, 'admission.ndjson')",
    )
    expect(source).not.toMatch(/homedir\(|\.qianmo['"`]/)
  })

  test('the process pool receives the host memory root and owns child environment isolation', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/host/resident.ts'),
      'utf8',
    )
    const pool = readFileSync(
      join(import.meta.dir, '../../src/host/residentOmp.ts'),
      'utf8',
    )
    expect(source).toContain('memoryRoot: this.#memoryRoot')
    expect(pool).toContain('residentOmpEnvironment(')
    expect(pool).toContain('cwd: owner.cwd')
    expect(source).not.toMatch(/DAEMON_TOKEN|destroySandbox|execCommand/)
  })

  test('reads the requester context off the envelope already in the mailbox entry', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/host/resident.ts'),
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
      join(import.meta.dir, '../../src/host/resident.ts'),
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
    // P18.3 给这次轮询套了一层计数（热切换的空闲判定），仍然是 void、不 await。
    expect(source).toContain(
      'void this.#trackPoll(runtime.deliver(message)).catch(',
    )
    expect(source).not.toContain('await runtime.deliver(')
    // 协议 ack 的发出点一行未动：仍然只挂在 onRead 上。
    expect(source).toContain(
      'onRead: (input, readAt) => this.#ackTask(input, readAt)',
    )
  })

  test('hands the transport its L0 and L1 materials, and nothing of its own', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../src/host/resident.ts'),
      'utf8',
    )

    // 钉源码同上（起一台真常驻节点才能测到这条线，代价与它证明的东西不相称）。
    // 钉的是三件东西**原样透传**给 startTransportServer：TLS 材料、证书 notAfter、
    // 握手签名身份。这一层不许自己拼 TLS 选项——三件套的不可拆分性写在
    // `mutualTlsServerOptions` 里，在这里再拼一次就等于给了第二个拼错的机会。
    expect(source).toContain('tls: this.#options.tls')
    expect(source).toContain(
      'certificateNotAfter: this.#options.certificateNotAfter',
    )
    expect(source).toContain('signing: this.#options.handshakeSigning')
    // 找的是「有没有在这里拼一份 TLS 选项」，不是「有没有提到这两个名字」——
    // 上面那段选项注释正当地提到它们，而 `requestCert: true` 只可能出自一次
    // 手拼。
    expect(source).not.toContain('requestCert: true')
    expect(source).not.toContain('rejectUnauthorized: true')
    // 私钥不经过这一层的任何日志、事件或提示面。
    expect(source).not.toContain('privateKey')
  })
})
