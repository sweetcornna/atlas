// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 迁移与真机验收的 runbook 写到的东西，要在仓库里真的存在（P18.13）。
 *
 * 扫两处：`docs/dev/beta-env.md` §13 与 `demo/env/beta/README.md`「模型服务迁移与真机验收」。
 * 执行它的人（B 段）照着文档敲命令：一个改了名的脚本、一个拼错的开关、一个已经删掉的子命令，
 * 在文档里看不出来，到了舰队上才是一条「不认识的参数」。所以逐个核：
 *
 * ① 写到的仓库路径都在；裸写的 `*.sh` / `*.ts` 在 `demo/env/beta/` 或 `ops/` 下；
 * ② 每条命令行里调到的脚本，`--` 之前的开关在那个脚本（包装脚本连同它 exec 的 .ts）里出现过，
 *   `--` 之后的尾参在 resident / console 的参数解析里出现过；
 * ③ 登记助手表里写的子命令都是它认的子命令；
 * ④ 写到的环境变量名在源码里出现过；
 * ⑤ README 的轮配置样例，占位符换成合法值之后过得了 `parseConfig`（样例与代码同形）；
 * ⑥ 两处都没有写进真实拓扑（IP、舰队机器名）。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseConfig } from './ops/provider-acceptance'

const REPO = resolve(import.meta.dir, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** 从 `heading` 到下一个同级或更高级标题之前（代码块里 `# …` 开头的注释行不算标题）。 */
function section(rel: string, heading: string): string {
  const lines = read(rel).split('\n')
  const start = lines.findIndex(line => line.startsWith(heading))
  if (start === -1) throw new Error(`${rel} 里没有「${heading}」`)
  const level = /^#+/.exec(heading)?.[0].length ?? 2
  let fenced = false
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.startsWith('```')) fenced = !fenced
    if (fenced) continue
    const hashes = /^(#+) /.exec(line)?.[1]?.length
    if (hashes !== undefined && hashes <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const SECTIONS: Record<string, string> = {
  'beta-env.md §13': section(
    'docs/dev/beta-env.md',
    '## §13 模型服务迁移与真机验收',
  ),
  'README 迁移与验收': section(
    'demo/env/beta/README.md',
    '## 模型服务迁移与真机验收',
  ),
}
const ALL = Object.values(SECTIONS).join('\n')

/** 脚本 → 它的开关可能出现在哪些源文件里（包装脚本连同它 exec 的那一份）。 */
const SCRIPT_SOURCES: Record<string, readonly string[]> = {
  'model-apply-enroll.sh': ['demo/env/beta/ops/model-apply-enroll.sh'],
  'provider-acceptance.sh': [
    'demo/env/beta/ops/provider-acceptance.sh',
    'demo/env/beta/ops/provider-acceptance.ts',
  ],
  'beta-up.sh': ['demo/env/beta/beta-up.sh', 'demo/env/beta/common.sh'],
  'beta-down.sh': ['demo/env/beta/beta-down.sh'],
  'beta-deploy.sh': ['demo/env/beta/beta-deploy.sh'],
}
/** `--` 之后的尾参交给 resident / console。 */
const TAIL_SOURCES = [
  'src/cli/handlers/resident.ts',
  'src/cli/handlers/consoleArgs.ts',
]

/** 文档里的命令行：反引号里的一段，或代码块里的一行（`\` 续行并起来）。 */
function commandLines(text: string): string[] {
  const out: string[] = []
  for (const block of text.matchAll(/```(?:bash)?\n([\s\S]*?)```/g)) {
    const joined = (block[1] ?? '').replace(/\\\n\s*/g, ' ')
    for (const line of joined.split('\n')) {
      // 一行里 `&&` 串起来的几条命令各算一条。
      for (const part of line.replace(/#.*$/, '').split('&&')) out.push(part)
    }
  }
  for (const inline of text.matchAll(/`([^`\n]+)`/g)) out.push(inline[1] ?? '')
  return out
}

describe('迁移与真机验收 runbook 的引用', () => {
  test('两处都找得到，且不是空的', () => {
    for (const [name, body] of Object.entries(SECTIONS)) {
      expect({ name, long: body.length > 1000 }).toEqual({ name, long: true })
    }
  })

  test('写到的仓库路径都在', () => {
    const paths = new Set<string>()
    for (const match of ALL.matchAll(
      /\b((?:demo|docs|src|packages|scripts)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/g,
    )) {
      paths.add(match[1] ?? '')
    }
    expect(paths.size).toBeGreaterThan(3)
    const missing = [...paths].filter(path => !existsSync(join(REPO, path)))
    expect(missing).toEqual([])
  })

  test('裸写的脚本名都在 demo/env/beta/ 或 ops/ 下', () => {
    const names = new Set<string>()
    for (const match of ALL.matchAll(
      /(?<![/\w-])([a-z][a-z0-9-]*\.(?:sh|ts))\b/g,
    )) {
      names.add(match[1] ?? '')
    }
    expect(names).toContain('model-apply-enroll.sh')
    expect(names).toContain('provider-acceptance.sh')
    const missing = [...names].filter(
      name =>
        !existsSync(join(REPO, 'demo/env/beta', name)) &&
        !existsSync(join(REPO, 'demo/env/beta/ops', name)),
    )
    expect(missing).toEqual([])
  })

  test('每条命令行的开关都在对应脚本里，尾参都在 resident / console 的参数解析里', () => {
    const problems: string[] = []
    let checked = 0
    for (const line of commandLines(ALL)) {
      const script = Object.keys(SCRIPT_SOURCES).find(name =>
        line.includes(name),
      )
      if (script === undefined) continue
      const after = line.slice(line.indexOf(script) + script.length)
      const [own = '', tail = ''] = after.split(/\s--\s/, 2)
      const ownSource = (SCRIPT_SOURCES[script] ?? []).map(read).join('\n')
      const tailSource = TAIL_SOURCES.map(read).join('\n')
      for (const flag of own.match(/--[a-z][a-z0-9-]*/g) ?? []) {
        checked += 1
        if (!ownSource.includes(flag)) problems.push(`${script} ${flag}`)
      }
      for (const flag of tail.match(/--[a-z][a-z0-9-]*/g) ?? []) {
        checked += 1
        if (!tailSource.includes(`'${flag}'`)) problems.push(`尾参 ${flag}`)
      }
    }
    expect(checked).toBeGreaterThan(15)
    expect(problems).toEqual([])
  })

  test('登记助手表里写的子命令都是它认的', () => {
    const source = read('demo/env/beta/ops/model-apply-enroll.sh')
    const named = new Set<string>()
    for (const match of SECTIONS['README 迁移与验收']?.matchAll(
      /`((?:hub|node)-[a-z-]+|authorized-key|enroll)`/g,
    ) ?? []) {
      named.add(match[1] ?? '')
    }
    expect(named.size).toBeGreaterThanOrEqual(6)
    const missing = [...named].filter(
      sub => !new RegExp(`^\\s+${sub}\\) cmd_`, 'm').test(source),
    )
    expect(missing).toEqual([])
  })

  test('写到的环境变量名在源码里出现过', () => {
    const corpus = [
      'demo/env/beta/common.sh',
      'demo/env/beta/beta-up.sh',
      'demo/env/beta/ops/model-apply-enroll.sh',
      'demo/env/beta/ops/provider-acceptance.ts',
      'demo/env/beta/ops/provider-acceptance-node.ts',
    ]
      .map(read)
      .join('\n')
    const names = new Set<string>()
    for (const match of ALL.matchAll(/\b((?:QIANMO|OPENAI)_[A-Z0-9_]+)\b/g)) {
      names.add(match[1] ?? '')
    }
    expect(names).toContain('OPENAI_PROMPT_CACHE_DIAGNOSTICS')
    // OPENAI_API_KEY 是基座的键名，不是本包引入的；其余都要在这几个文件里。
    const missing = [...names].filter(
      name => name !== 'OPENAI_API_KEY' && !corpus.includes(name),
    )
    expect(missing).toEqual([])
  })

  test('README 的轮配置样例与 parseConfig 同形', () => {
    const readme = SECTIONS['README 迁移与验收'] ?? ''
    const sample = /```json\n([\s\S]*?)```/.exec(readme)?.[1]
    expect(sample).toBeDefined()
    const values: Record<string, string> = {
      '<控制台 URL>': 'https://console.example',
      '<ops 凭据文件>': '/home/ops/.qm/ops-credential',
      '<机器甲>': 'hub',
      '<机器乙>': 'node-a',
      '<ssh 目标>': 'alias-a',
      '<部署根>': '/srv/qianmo',
      '<内测根，可省>': '/srv/qianmo-beta',
      '<节点>': 'beta-1',
      '<agent>': 'planner',
      '<期望的档案>': 'luna',
      '<换过去的档案>': 'alt',
      '<标签的 40 位提交>': 'a'.repeat(40),
    }
    let text = sample ?? ''
    for (const [placeholder, value] of Object.entries(values)) {
      text = text.split(placeholder).join(value)
    }
    expect(text).not.toMatch(/<[^>]+>/)
    expect(() => parseConfig(JSON.parse(text) as unknown)).not.toThrow()
  })

  test('没有写进真实拓扑', () => {
    const ips = [...ALL.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)]
      .map(match => match[1] ?? '')
      .filter(ip => ip !== '127.0.0.1' && ip !== '0.0.0.0')
    expect(ips).toEqual([])
    expect(ALL).not.toMatch(/cornna-p\d|workbench-iap|sweetcornna/)
  })
})
