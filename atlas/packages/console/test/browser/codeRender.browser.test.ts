// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Code's page draws rich text with the DOM, the server draws it as markup
 * (`view/richText.ts`); the two must come out the same (`qmo-local.md`
 * §4.5.5). In a real Chrome, each input goes both ways into one `<template>`
 * — the server's string through the HTML parser, the page's function
 * building nodes — and the two serializations must be equal, character for
 * character. The inputs are the edges the subset has rules for (fences, an
 * unclosed one, single, paired and cross-line backticks, every kind of `**`,
 * lists, markup, entities, quotes, Chinese and Japanese, blank and empty),
 * the two the HTML parser rewrites on the server's side (a carriage return,
 * a NUL), and a few hundred strings drawn at random from the characters that
 * matter. Skipped, with the reason printed, on a machine without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CODE_RENDER_JS } from '../../src/assets/codeRender.js'
import { renderRichText } from '../../src/view/richText.js'
import { Browser, skipReason, type Tab } from './cdp.js'

const SKIP = skipReason()
if (SKIP !== null) console.warn(`[code render browser tests] skipped: ${SKIP}`)

const FENCE = '```'

const CASES: readonly string[] = [
  '',
  '   ',
  '\n\n\t \n',
  '一句话',
  '第一行\n第二行',
  '一\n\n二',
  `看这个：\n${FENCE}ts\nconst a = 1\n${FENCE}`,
  `${FENCE}\n<script>alert(1)</script>`,
  `前面\n${FENCE}\n未闭合\n\n还在代码里`,
  `  ${FENCE}\n缩进的围栏\n  ${FENCE}\n后面`,
  `${FENCE}${FENCE}`,
  `${FENCE}\n${FENCE}`,
  '跑 `bun test **x**` 然后看 **结果**',
  '一个 ` 反引号，以及 ** 没闭合',
  '`a` 和 `b` 和 `',
  '跨行 `开头\n结尾` 不算',
  '``',
  '` `',
  '**粗**体 **不 ** ** 空** **a**b**c**',
  '****',
  '**`code`**',
  '`**not bold**`',
  '** 前有空格**',
  '**后有空格 **',
  '- 一\n- 二\n* 三\n   - 四\n    - 五',
  '-不是列表\n-\n- \n-  两个空格',
  '段落\n- 列表紧跟\n段落紧跟',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[链接](https://example.com) 和 https://example.com',
  '&amp; &lt; &#39; & < > " \'',
  '"双引号" \'单引号\' `"在代码里"`',
  '中文、日本語のテキスト、かな カナ、全角（括号）',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '回车\r\n换行\r\n- 列\r\n- 表',
  '单独的\r回车',
  'NUL\u0000字符`a\u0000b`',
  ' 不换行空格 ',
  ' 行分隔 段分隔',
  'emoji 🙂 `🙂` **🙂**',
  `- 列表里 \`代码\` 和 **粗**\n- ${FENCE}不是围栏`,
  `说明\n\n${FENCE}diff\n+ 加\n- 减\n${FENCE}\n\n- 一\n- 二\n\n**完**`,
]

/** A small seeded generator, so a failure names the same input every run. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const PIECES = [
  '`',
  '``',
  FENCE,
  '*',
  '**',
  '-',
  '- ',
  '* ',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n\n',
  '\r',
  '\r\n',
  '<',
  '>',
  '&',
  '"',
  "'",
  'a',
  'b',
  '字',
  '語',
  ' ',
  '\u0000',
]

function fuzz(count: number): readonly string[] {
  const next = random(20261024)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const length = 1 + Math.floor(next() * 24)
    let text = ''
    for (let j = 0; j < length; j++) {
      text += PIECES[Math.floor(next() * PIECES.length)] ?? ''
    }
    out.push(text)
  }
  return out
}

/** Both ways through one template, in the page: [server, page]. */
async function both(
  tab: Tab,
  inputs: readonly string[],
): Promise<readonly (readonly [string, string])[]> {
  const server = inputs.map(input => renderRichText(input))
  return await tab.evaluate<readonly (readonly [string, string])[]>(`(() => {
    const inputs = ${JSON.stringify(inputs)};
    const server = ${JSON.stringify(server)};
    const box = document.createElement('template');
    return inputs.map((input, i) => {
      box.innerHTML = server[i];
      const fromServer = box.innerHTML;
      box.innerHTML = '';
      window.qianmoCode.richText(box.content, input);
      return [fromServer, box.innerHTML];
    });
  })()`)
}

describe.skipIf(SKIP !== null)(
  'rich text in the page and on the server',
  () => {
    let browser: Browser
    let tab: Tab

    beforeAll(async () => {
      browser = await Browser.launch()
      tab = await browser.tab()
      await tab.evaluate(CODE_RENDER_JS)
    }, 30_000)

    afterAll(async () => {
      await browser?.close()
    }, 30_000)

    test('the listed edges come out the same, character for character', async () => {
      const results = await both(tab, CASES)
      for (const [index, [server, page]] of results.entries()) {
        expect([CASES[index], page]).toEqual([CASES[index], server])
      }
      // The empty mark is the server's, in every language.
      expect(results[0]?.[1]).toBe('<p class="turn-empty">（空）</p>')
      // Markup in the text stays text.
      const script = results[CASES.indexOf('<script>alert(1)</script>')]?.[1]
      expect(script).toBe(
        '<p class="turn-p">&lt;script&gt;alert(1)&lt;/script&gt;</p>',
      )
    }, 30_000)

    test('four hundred random strings of the characters that matter come out the same', async () => {
      const inputs = fuzz(400)
      const results = await both(tab, inputs)
      const differ = results
        .map(([server, page], index) => ({
          input: inputs[index],
          server,
          page,
        }))
        .filter(one => one.server !== one.page)
      expect(differ).toEqual([])
    }, 30_000)

    test('an answer drawn as it grows is the answer drawn whole, at every step, and keeps what is done', async () => {
      const essay = [
        '先看这里：',
        '',
        `${FENCE}ts\nconst a = 1\n\nconst b = 2\n${FENCE}`,
        '',
        '- 一\n- 二',
        '',
        '**完** 还有 `code`',
        '',
        `${FENCE}\n未闭合\n\n还在里面`,
      ].join('\n')
      const inputs = [...CASES, ...fuzz(300), essay]
      const differ = await tab.evaluate<unknown[]>(`(() => {
        const inputs = ${JSON.stringify(inputs)};
        const R = window.qianmoCode;
        const out = [];
        for (const input of inputs) {
          const live = document.createElement('div');
          const whole = document.createElement('div');
          let at = 0;
          let k = 0;
          while (at < input.length) {
            at = Math.min(input.length, at + 1 + (k++ % 7));
            const part = input.slice(0, at);
            R.grow(live, part);
            whole.textContent = '';
            R.richText(whole, part);
            if (live.innerHTML !== whole.innerHTML) {
              out.push({ input, at, live: live.innerHTML, whole: whole.innerHTML });
              break;
            }
          }
        }
        return out;
      })()`)
      expect(differ).toEqual([])
      const kept = await tab.evaluate<unknown>(`(() => {
        const R = window.qianmoCode;
        const live = document.createElement('div');
        R.grow(live, '第一段\\n\\n第二');
        const first = live.firstChild;
        R.grow(live, '第一段\\n\\n第二段继续\\n\\n- 列表');
        const same = live.firstChild === first;
        // Not a continuation (the turn changed): drawn afresh.
        R.grow(live, '另一句');
        const whole = document.createElement('div');
        R.richText(whole, '另一句');
        return { same, fresh: live.innerHTML === whole.innerHTML, count: live.childNodes.length };
      })()`)
      expect(kept).toEqual({ same: true, fresh: true, count: 1 })
    }, 30_000)

    test('the page builds only the subset’s elements, and no attribute but class', async () => {
      const tags = await tab.evaluate<readonly string[]>(`(() => {
      const box = document.createElement('template');
      const inputs = ${JSON.stringify([...CASES, ...fuzz(100)])};
      const seen = new Set();
      for (const input of inputs) {
        box.innerHTML = '';
        window.qianmoCode.richText(box.content, input);
        for (const el of box.content.querySelectorAll('*')) {
          seen.add(el.tagName.toLowerCase());
          for (const a of el.attributes) if (a.name !== 'class') seen.add('@' + a.name);
        }
      }
      return [...seen].sort();
    })()`)
      expect(tags).toEqual(['b', 'code', 'li', 'p', 'pre', 'ul'])
    }, 30_000)
  },
)
