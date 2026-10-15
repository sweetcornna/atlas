// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  discordMarkdown,
  extractMedia,
  isSilence,
  plainText,
  slackMrkdwn,
  splitMessage,
  tablesToBullets,
  telegramMarkdownV2,
} from '../../src/channels/text.js'

describe('silence', () => {
  test('empty or exactly a marker, edge punctuation allowed', () => {
    for (const reply of [
      '',
      '  ',
      '[SILENT]',
      'silent',
      'NO_REPLY',
      '*NO_REPLY*',
      ' [no_reply]. ',
    ])
      expect(`${reply} ${isSilence(reply)}`).toBe(`${reply} true`)
    for (const reply of ['我会保持 [SILENT]', 'SILENTLY', '好'])
      expect(`${reply} ${isSilence(reply)}`).toBe(`${reply} false`)
  })
})

describe('splitMessage', () => {
  test('short text is one chunk without markers', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello'])
  })

  test('splits on lines, numbers the chunks, stays within the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const chunks = splitMessage(text, 60)
    expect(chunks.length).toBeGreaterThan(2)
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(60)
      expect(chunk.endsWith(`(${index + 1}/${chunks.length})`)).toBe(true)
    }
    const joined = chunks
      .map(chunk => chunk.replace(/ \(\d+\/\d+\)$/, ''))
      .join('\n')
    expect(joined.split('\n').filter(Boolean)).toEqual(text.split('\n'))
  })

  test('a fence split across chunks is closed and reopened with its language', () => {
    const code = Array.from({ length: 20 }, (_, i) => `print(${i})`).join('\n')
    const chunks = splitMessage(
      `看这段：\n\`\`\`python\n${code}\n\`\`\`\n完`,
      80,
    )
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const fences = chunk
        .split('\n')
        .filter(line => line.trim().startsWith('```')).length
      expect(fences % 2).toBe(0)
    }
    expect(chunks[1]!.startsWith('```python\n')).toBe(true)
  })

  test('never splits a surrogate pair', () => {
    const chunks = splitMessage('😀'.repeat(40), 31)
    for (const chunk of chunks)
      expect(chunk.replace(/ \(\d+\/\d+\)$/, '')).toMatch(/^(😀)+$/u)
  })
})

describe('formats', () => {
  test('tables become bullets outside code', () => {
    const table = '| 名称 | 状态 |\n| --- | --- |\n| p3 | 在线 |\n| p5 | 离线 |'
    expect(tablesToBullets(table)).toBe(
      '**p3**\n• 状态: 在线\n\n**p5**\n• 状态: 离线',
    )
    expect(tablesToBullets(`\`\`\`\n${table}\n\`\`\``)).toBe(
      `\`\`\`\n${table}\n\`\`\``,
    )
    expect(discordMarkdown(table)).toContain('**p3**')
  })

  test('Telegram MarkdownV2 escapes everything but the markup it writes', () => {
    expect(telegramMarkdownV2('**加粗** 和 *斜体* v1.2!')).toBe(
      '*加粗* 和 _斜体_ v1\\.2\\!',
    )
    expect(telegramMarkdownV2('# 标题')).toBe('*标题*')
    expect(telegramMarkdownV2('[文档](https://a.b/c_(d))')).toBe(
      '[文档](https://a.b/c_(d\\))',
    )
    expect(telegramMarkdownV2('`a_b` 与 a_b')).toBe('`a_b` 与 a\\_b')
    expect(telegramMarkdownV2('```js\nx = `y`\n```')).toBe(
      '```js\nx = \\`y\\`\n```',
    )
  })

  test('Slack mrkdwn', () => {
    expect(slackMrkdwn('**粗** *斜* [链接](https://x.y) a<b')).toBe(
      '*粗* _斜_ <https://x.y|链接> a&lt;b',
    )
    expect(slackMrkdwn('## 小结')).toBe('*小结*')
  })

  test('plain text keeps code and addresses, drops markers', () => {
    expect(
      plainText(
        '## 结果\n**完成** 了，见 [报告](https://r.s/1)\n```sh\nls -la\n```',
      ),
    ).toBe('结果\n完成 了，见 报告（https://r.s/1）\nls -la')
    expect(plainText('`npm i` 然后 *运行*')).toBe('npm i 然后 运行')
  })

  test('MEDIA lines are counted and removed', () => {
    expect(extractMedia('无附件')).toEqual({ text: '无附件', dropped: 0 })
    expect(extractMedia('看图\nMEDIA: /a.png\n\n\nMEDIA:/b.pdf\n结束')).toEqual(
      { text: '看图\n\n结束', dropped: 2 },
    )
  })
})
