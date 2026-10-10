// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P6.3（章程 P-3）—— MCP 兼容子集核验：omp（oh-my-pi）作为 **MCP 客户端**，
 * 对着两个**第三方现成 server** 跑发现、调用与降级。
 *
 * ## 两个对端是谁
 *
 * - `@modelcontextprotocol/server-filesystem`（`@qianmo/node` 的
 *   devDependencies 精确 pin）
 * - `@modelcontextprotocol/server-memory`（同上）
 *
 * 两个都不是我们写的，也不是我们改的：它们从 npm 装进 `node_modules`，以
 * `<bun> <bin 入口>` 直接 spawn。本文件里唯一属于我们的"server"是
 * `fixtures/mcp-crash-server.ts`，它是**故障夹具**而不是交付物——没有哪个
 * 行为正常的 server 能按测试的要求在指定时刻自杀或装死，D3 与超时两条用例
 * 需要那样一个对端。区分见夹具文件顶部注释。
 *
 * ## 核验停在哪
 *
 * 停在 omp 的 `MCPManager`：配置走 omp 自己的发现链——每条用例把
 * `mcp.json` 写进隔离的 omp agent 目录（`ompAgentDir()`，即
 * `<QIANMO_CONFIG_DIR>/omp/agent`），再由 `discoverAndConnect` 读出、连上、
 * 列工具；调用走 `MCPTool.execute`，也就是 agent 循环执行 MCP 工具时的同一
 * 个入口。最后一条用例再启动真实 omp RPC 子进程，以本地脚本模型驱动两个
 * 第三方服务的工具调用，核对工具结果与落盘内容，不调用外部模型服务。
 *
 * ## 隔离
 *
 * omp 的目录解析在 `@oh-my-pi/pi-utils` 里，模块加载期冻结一次、
 * `setAgentDir` 时重建。所以 beforeAll 先把 `HOME`、`QIANMO_CONFIG_DIR`、
 * `PI_CONFIG_DIR`（取自 `ompSpawnEnv()`，与 qm 拉起 omp 子进程时同一条规则）
 * 指到临时目录、清掉 `OMP_ENV_SCRUB` 里那些会把状态挪走的变量，再
 * `setAgentDir(ompAgentDir())`；日志也显式改写到临时根下。开发机上的
 * `~/.omp`、`~/.qianmo`、`~/.claude` 一个都不读不写；omp 的外部工具配置
 * （`~/.claude.json` 之类）本就默认不读，HOME 换掉之后更是无从读起。
 *
 * ## 零 mock
 *
 * 本文件没有任何 `mock.module`，也不 spy。跨文件 mock 污染是
 * tests/integration 分片单进程模式下最贵的故障，而这里被测的恰好是"真的
 * 能不能连上真的进程"，任何替身都会把结论掏空。
 *
 * ## 脚手架纪律
 *
 * 分片内所有测试文件共用一个进程，所以：临时目录、环境变量、omp 的 agent
 * 目录与日志去向、`unhandledRejection` 监听器全部 beforeAll 设置、afterAll
 * 成对还原；每条用例新建的 `MCPManager` 都进 `liveManagers`，afterEach
 * 逐个 `disconnectAll()`，不让子进程跨用例存活。
 *
 * 时序断言遵守 a8b06a9 的教训：正向结论一律等真实事件/Promise，只有"某事
 * 不该发生"这类反向结论才睡一个固定窗口。
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { clearCache as clearFsCache } from '@oh-my-pi/pi-coding-agent/capability/fs'
import '@oh-my-pi/pi-coding-agent/discovery'
import type {
  CustomTool,
  CustomToolContext,
  CustomToolResult,
} from '@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types'
import type { MCPToolDetails } from '@oh-my-pi/pi-coding-agent/mcp'
import {
  MCPManager,
  type MCPLoadResult,
} from '@oh-my-pi/pi-coding-agent/mcp/manager'
import type { MCPServerConfig } from '@oh-my-pi/pi-coding-agent/mcp/types'
import type { TSchema } from '@oh-my-pi/pi-ai'
import { RpcClient } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client'
import { getConfigRootDir, logger, setAgentDir } from '@oh-my-pi/pi-utils'
import { ompArgv, ompSpawnEnv } from '@qianmo/node/omp/launch.ts'
import { OMP_ENV_SCRUB, ompAgentDir, ompConfigRoot } from '@qianmo/paths'

/** bunfig 的默认 timeout 是 10s，spawn 一个真 server 就能吃掉大半。 */
const CASE_TIMEOUT_MS = 60_000

const CRASH_FIXTURE_ENTRY = join(
  import.meta.dir,
  'fixtures/mcp-crash-server.ts',
)

/**
 * 第三方 server 的入口：从本文件往上逐级找 `node_modules/<pkg>`，取它
 * package.json 的 `bin`。一律 `process.execPath` + 入口绝对路径：
 * node_modules/.bin 下的 shebang 软链在不同安装布局下指向不同解释器，spawn
 * 失败时的报错还会伪装成协议错误。
 *
 * 用到时才解析：包没装（没跑过 `bun install`）只该让依赖它的用例失败，不该
 * 把只靠故障夹具的用例一起拖下水。
 */
function serverEntry(pkg: string): string {
  for (let dir = import.meta.dir; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', pkg, 'package.json')
    if (existsSync(manifest)) {
      const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        bin?: string | Record<string, string>
      }
      const entry = typeof bin === 'string' ? bin : Object.values(bin ?? {})[0]
      if (!entry) throw new Error(`${manifest} 没有声明 bin 入口`)
      return join(dirname(manifest), entry)
    }
    if (dir === dirname(dir)) break
  }
  throw new Error(
    `${pkg} 不在 node_modules 里：它是 @qianmo/node 的 devDependency，先跑 bun install`,
  )
}

const FS_SERVER = '@modelcontextprotocol/server-filesystem'
const MEMORY_SERVER = '@modelcontextprotocol/server-memory'

type McpTool = CustomTool<TSchema, MCPToolDetails>
type McpToolResult = CustomToolResult<MCPToolDetails>

/** 每条用例新建的 manager 都进这里，afterEach 逐个断开。 */
const liveManagers = new Set<MCPManager>()

const savedEnv = new Map<string, string | undefined>()
function overrideEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

let homeDir = ''
let qianmoRoot = ''
let sandboxDir = ''
let memoryDir = ''
let cliOnlyDir = ''
let memoryFile = ''
let cliOnlyFile = ''
let savedAgentDir = ''

const unhandledRejections: unknown[] = []
const collectUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason)
}

function stdioConfig(
  args: string[],
  extra: { env?: Record<string, string>; timeout?: number } = {},
): MCPServerConfig {
  return { type: 'stdio', command: process.execPath, args, ...extra }
}

function fsConfig(allowedDir: string, extra?: { timeout?: number }) {
  return stdioConfig([serverEntry(FS_SERVER), allowedDir], extra)
}

function memoryConfig(): MCPServerConfig {
  return stdioConfig([serverEntry(MEMORY_SERVER)], {
    // 不覆盖就往 node_modules 里写：memory server 的默认库路径是它自己的
    // dist 目录。
    env: { MEMORY_FILE_PATH: memoryFile },
  })
}

/**
 * 走生产入口做一次发现：把 `servers` 写成隔离 agent 目录下的 `mcp.json`，
 * 让 omp 自己的发现链读出来再连。`startupTimeoutMs: 0` 让发现等到每台
 * server 都连上或失败为止——默认的 250ms 窗口是为了不卡 TUI，会让慢一点的
 * server 在后台才登记工具，断言就成了抢跑。
 */
async function discover(
  servers: Record<string, MCPServerConfig>,
): Promise<{ manager: MCPManager; result: MCPLoadResult }> {
  await writeFile(
    join(ompAgentDir(), 'mcp.json'),
    JSON.stringify({ mcpServers: servers }, null, 2),
  )
  // omp 的 capability 层缓存读过的文件；每条用例换了 mcp.json，必须清。
  clearFsCache()
  const manager = new MCPManager(sandboxDir)
  liveManagers.add(manager)
  const result = await manager.discoverAndConnect({ startupTimeoutMs: 0 })
  return { manager, result }
}

function serverTools(manager: MCPManager, server: string): McpTool[] {
  return manager.getTools().filter(t => t.mcpServerName === server)
}

function toolNamed(manager: MCPManager, name: string): McpTool {
  const tools = manager.getTools()
  const tool = tools.find(t => t.name === name)
  if (!tool) {
    throw new Error(
      `tool "${name}" not found (got: ${tools.map(t => t.name).join(', ')})`,
    )
  }
  return tool
}

/**
 * `MCPTool` 只拿 context 去解析 `local://` 这类内部 URL 参数；这里的参数都
 * 是普通路径和文本，空 context 就是最小而诚实的那个。
 */
const TOOL_CONTEXT = {} as CustomToolContext

let callSeq = 0
function execute(
  tool: McpTool,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  callSeq += 1
  return tool.execute(
    `p63-call-${callSeq}`,
    args as never,
    undefined,
    TOOL_CONTEXT,
  )
}

/**
 * 把一次 MCP 调用的结果压成文本。omp 把 server 的 content block 原样转成
 * text block；若 server 另回了 `structuredContent` 且它不在已有文本里，再
 * 追加一个 JSON 代码块。两路都在 content 里，所以拼起来查就够了。
 */
function resultText(result: McpToolResult): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n')
}

/** 成功调用的文本；业务错误或传输错误都直接炸，带上 omp 的诊断文本。 */
async function callTool(
  tool: McpTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await execute(tool, args)
  if (result.isError) {
    throw new Error(`${tool.name} failed:\n${resultText(result)}`)
  }
  return resultText(result)
}

/**
 * 取回 `structuredContent` 里某个字段的原文。逐字节比对必须拿到字段本身，
 * 拿渲染后的文本比对等于顺带断言了 omp 的渲染写法。
 */
async function structuredField(
  tool: McpTool,
  args: Record<string, unknown>,
  field: string,
): Promise<string> {
  const result = await execute(tool, args)
  if (result.isError) {
    throw new Error(`${tool.name} failed:\n${resultText(result)}`)
  }
  const value = result.details?.structuredContent?.[field]
  if (typeof value !== 'string') {
    throw new Error(
      `structuredContent 里没有字符串字段 "${field}"：${resultText(result).slice(0, 200)}`,
    )
  }
  return value
}

beforeAll(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'qianmo-p63-home-'))
  qianmoRoot = await mkdtemp(join(tmpdir(), 'qianmo-p63-root-'))
  // realpath：macOS 的 /var/folders 是到 /private/var/folders 的软链，而
  // filesystem server 对命令行目录和 roots 都做 realpath 归一化，不先解开
  // 的话"允许目录"断言会比对到两个不同写法的同一个目录。
  sandboxDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-fs-')))
  memoryDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-mem-')))
  cliOnlyDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-cli-')))
  memoryFile = join(memoryDir, 'memory.jsonl')
  cliOnlyFile = join(cliOnlyDir, 'cli-only.txt')
  await writeFile(cliOnlyFile, 'only reachable via the command-line dir\n')

  // 先记下 omp 当前的 agent 目录，afterAll 原样装回。
  savedAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(getConfigRootDir(), 'agent')

  overrideEnv('HOME', homeDir)
  overrideEnv('QIANMO_CONFIG_DIR', qianmoRoot)
  for (const key of Object.keys(OMP_ENV_SCRUB)) overrideEnv(key, undefined)
  // 与 qm 拉起 omp 子进程同一条规则：PI_CONFIG_DIR 是相对 HOME 的路径，
  // 指回 `<QIANMO_CONFIG_DIR>/omp`。
  overrideEnv('PI_CONFIG_DIR', ompSpawnEnv().PI_CONFIG_DIR)
  // 这两个变量对每台 server 的 `timeout` 和发现窗口有进程级优先权；开发机
  // 上要是设了，超时类断言就测的不是配置里写的那个数。
  overrideEnv('OMP_MCP_TIMEOUT_MS', undefined)
  overrideEnv('OMP_MCP_STARTUP_TIMEOUT_MS', undefined)
  // setAgentDir 会顺手写 PI_CODING_AGENT_DIR，先登记以便还原。
  overrideEnv('PI_CODING_AGENT_DIR', process.env.PI_CODING_AGENT_DIR)
  setAgentDir(ompAgentDir())
  await mkdir(ompAgentDir(), { recursive: true })
  logger.setTransports({ file: join(ompConfigRoot(), 'logs') })
  clearFsCache()

  process.on('unhandledRejection', collectUnhandledRejection)
})

afterEach(async () => {
  for (const manager of liveManagers) {
    await manager.waitForPendingConnections()
    await manager.disconnectAll()
  }
  liveManagers.clear()
})

afterAll(async () => {
  process.off('unhandledRejection', collectUnhandledRejection)

  // 先还原 HOME/PI_CONFIG_DIR，setAgentDir 重建的解析器才指回原处；它会
  // 删掉 profile 变量、改写 PI_CODING_AGENT_DIR，所以之后再还原一遍。
  restoreEnv()
  setAgentDir(savedAgentDir)
  restoreEnv()
  savedEnv.clear()
  logger.setTransports({ file: true })
  clearFsCache()

  for (const dir of [homeDir, qianmoRoot, sandboxDir, memoryDir, cliOnlyDir]) {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('P6.3 MCP 兼容子集：第三方 server 的发现与调用', () => {
  test(
    '① filesystem server 的工具被发现，并带上 omp 侧的 MCP 元信息',
    async () => {
      const { manager, result } = await discover({ fs: fsConfig(sandboxDir) })

      expect(result.errors.size).toBe(0)
      expect(result.connectedServers).toEqual(['fs'])
      expect(manager.getConnectionStatus('fs')).toBe('connected')

      const names = manager.getTools().map(t => t.name)
      expect(names).toContain('mcp__fs_read_text_file')
      expect(names).toContain('mcp__fs_write_file')
      expect(names).toContain('mcp__fs_list_directory')

      const fsTools = serverTools(manager, 'fs')
      expect(fsTools.length).toBeGreaterThanOrEqual(3)
      expect(fsTools).toHaveLength(manager.getTools().length)
      for (const tool of fsTools) {
        expect(tool.name.startsWith('mcp__fs_')).toBe(true)
        expect((tool.parameters as { type?: string }).type).toBe('object')
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '② filesystem 写—读闭环：MCP 通道读回逐字节相等，node:fs 直读再证一次',
    async () => {
      const { manager } = await discover({ fs: fsConfig(sandboxDir) })

      const target = join(sandboxDir, 'p63-round-trip.txt')
      const payload = '阡陌 P6.3 round trip\nsecond line\ttab\n'

      const wrote = await callTool(toolNamed(manager, 'mcp__fs_write_file'), {
        path: target,
        content: payload,
      })
      expect(wrote).toContain('p63-round-trip.txt')

      const readBack = await structuredField(
        toolNamed(manager, 'mcp__fs_read_text_file'),
        { path: target },
        'content',
      )
      expect(readBack).toBe(payload)

      // 第二重证据：绕开整条 MCP 通道直读同一路径。只信 read_text_file 的
      // 话，一个把写入丢进内存的 server 也能让用例变绿。
      expect(await readFile(target, 'utf8')).toBe(payload)
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '③ roots 互操作：omp 通告的 roots 整体顶掉 server 命令行上的允许目录',
    async () => {
      // 这台 server 的命令行只给了 cliOnlyDir，而 omp 声明了 roots 能力，
      // 并用 MCPManager 的 cwd（= sandboxDir）回答 `roots/list`。filesystem
      // server 的 `updateAllowedDirectoriesFromRoots` 是**替换**而不是合并。
      const { manager, result } = await discover({
        fsroots: fsConfig(cliOnlyDir),
      })
      expect(result.connectedServers).toEqual(['fsroots'])

      // server 在收到 `initialized` 之后才异步发 `roots/list` 并替换目录，
      // 而 omp 的连接在那之前就 resolve 了：等到替换真的发生（正向结论等
      // 真实事件），只设上限防止死等。
      let allowed = ''
      const deadline = Date.now() + 10_000
      do {
        allowed = await callTool(
          toolNamed(manager, 'mcp__fsroots_list_allowed_directories'),
          {},
        )
        if (allowed.includes(sandboxDir)) break
        await new Promise(done => setTimeout(done, 50))
      } while (Date.now() < deadline)
      expect(allowed).toContain(sandboxDir)
      expect(allowed).not.toContain(cliOnlyDir)

      // 顶掉是真的顶掉：命令行上那个目录里的文件已经读不到了。业务错误以
      // isError 结果回来，omp 不抛。
      const denied = await execute(
        toolNamed(manager, 'mcp__fsroots_read_text_file'),
        { path: cliOnlyFile },
      )
      expect(denied.isError).toBe(true)
      expect(resultText(denied)).toMatch(/access denied|allowed directories/i)

      // 而 roots 给的目录可以读。
      const reachable = join(sandboxDir, 'p63-roots-reachable.txt')
      await writeFile(reachable, 'reachable through roots\n')
      expect(
        await structuredField(
          toolNamed(manager, 'mcp__fsroots_read_text_file'),
          { path: reachable },
          'content',
        ),
      ).toBe('reachable through roots\n')
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '④ memory server 的工具被发现',
    async () => {
      const { manager, result } = await discover({ mem: memoryConfig() })

      expect(result.errors.size).toBe(0)
      expect(result.connectedServers).toEqual(['mem'])

      const names = manager.getTools().map(t => t.name)
      expect(names).toContain('mcp__mem_create_entities')
      expect(names).toContain('mcp__mem_read_graph')
      expect(names).toContain('mcp__mem_search_nodes')

      for (const tool of serverTools(manager, 'mem')) {
        expect(tool.name.startsWith('mcp__mem_')).toBe(true)
        expect((tool.parameters as { type?: string }).type).toBe('object')
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑤ memory 写—读闭环：create → read_graph 命中 → JSONL 落在我们指定的路径',
    async () => {
      const { manager } = await discover({ mem: memoryConfig() })

      await callTool(toolNamed(manager, 'mcp__mem_create_entities'), {
        entities: [
          {
            name: 'qianmo-node-alpha',
            entityType: 'qianmo-node',
            observations: ['P6.3 conformance run'],
          },
        ],
      })

      const graph = await callTool(
        toolNamed(manager, 'mcp__mem_read_graph'),
        {},
      )
      expect(graph).toContain('qianmo-node-alpha')
      expect(graph).toContain('P6.3 conformance run')

      const found = await callTool(
        toolNamed(manager, 'mcp__mem_search_nodes'),
        {
          query: 'qianmo-node-alpha',
        },
      )
      expect(found).toContain('qianmo-node-alpha')

      // 落盘证据，并且落在 mcp.json 里 env 指定的位置——默认路径在
      // node_modules 里，那既污染依赖目录又会让两次跑批互相看见对方的数据。
      const jsonl = await readFile(memoryFile, 'utf8')
      expect(jsonl).toContain('qianmo-node-alpha')
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑥ 两个 server 同时在线：工具前缀各归各，写入互不串扰',
    async () => {
      const { manager, result } = await discover({
        fs: fsConfig(sandboxDir),
        mem: memoryConfig(),
      })
      expect(result.errors.size).toBe(0)
      expect([...result.connectedServers].sort()).toEqual(['fs', 'mem'])

      const fsNames = serverTools(manager, 'fs').map(t => t.name)
      const memNames = serverTools(manager, 'mem').map(t => t.name)
      expect(fsNames.length).toBeGreaterThan(0)
      expect(memNames.length).toBeGreaterThan(0)
      expect(fsNames.every(n => n.startsWith('mcp__fs_'))).toBe(true)
      expect(memNames.every(n => n.startsWith('mcp__mem_'))).toBe(true)
      expect(fsNames.length + memNames.length).toBe(manager.getTools().length)

      const marker = 'crosstalk-marker-6c1f'
      const crossFile = join(sandboxDir, 'p63-crosstalk.txt')
      await callTool(toolNamed(manager, 'mcp__fs_write_file'), {
        path: crossFile,
        content: marker,
      })
      await callTool(toolNamed(manager, 'mcp__mem_create_entities'), {
        entities: [
          {
            name: 'crosstalk-entity',
            entityType: 'probe',
            observations: ['written while the filesystem server was live'],
          },
        ],
      })

      expect(await readFile(crossFile, 'utf8')).toBe(marker)
      const jsonl = await readFile(memoryFile, 'utf8')
      expect(jsonl).toContain('crosstalk-entity')
      expect(jsonl).not.toContain(marker)

      // 反过来也查一遍：memory 的库没有落进 filesystem 的沙箱。
      const listing = await callTool(
        toolNamed(manager, 'mcp__fs_list_directory'),
        { path: sandboxDir },
      )
      expect(listing).toContain('p63-crosstalk.txt')
      expect(listing).not.toContain('memory.jsonl')
    },
    CASE_TIMEOUT_MS,
  )
})

describe('P6.3 降级：server 不可用时不崩溃', () => {
  test(
    '⑦ D1 进程根本不存在：发现流程照常 resolve，坏 server 记错，同批健康 server 不受影响',
    async () => {
      const { manager, result } = await discover({
        ghost: {
          type: 'stdio',
          command: join(sandboxDir, 'definitely-not-an-executable'),
          args: [],
        },
        fs: fsConfig(sandboxDir),
      })

      expect(result.errors.get('ghost') ?? '').toMatch(
        /ENOENT|spawn|no such file/i,
      )
      expect(result.connectedServers).not.toContain('ghost')
      expect(manager.getConnectionStatus('ghost')).toBe('disconnected')
      expect(serverTools(manager, 'ghost')).toHaveLength(0)

      // 降级的判据不是"坏的那个坏了"，是"坏的那个没有拖垮好的那个"。
      expect(result.connectedServers).toContain('fs')
      expect(result.errors.has('fs')).toBe(false)
      expect(
        serverTools(manager, 'fs').some(
          t => t.name === 'mcp__fs_read_text_file',
        ),
      ).toBe(true)
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑧ D2 启动即退出：走传输层 EOF 快路而不是超时兜底',
    async () => {
      // 真的 filesystem server，只是命令行给了一个不存在的允许目录——它自己
      // 会在 connect 之前 process.exit(1)。连接超时显式给 5000ms：omp 默认
      // 是 30s，用默认值的话"快"与"慢"之间隔得太远，判据就没有分辨力了。
      const startedAt = Date.now()
      const { result } = await discover({
        suicide: fsConfig(join(sandboxDir, 'never-created-directory'), {
          timeout: 5000,
        }),
        fs: fsConfig(sandboxDir),
      })
      const elapsedMs = Date.now() - startedAt

      expect(result.errors.has('suicide')).toBe(true)
      expect(result.connectedServers).not.toContain('suicide')
      // 具体错误文本只钉 omp 自己的分类（EOF），不钉 server 的措辞。要钉的
      // 是**快**——兜底是 5000ms，落在 4000ms 以内就说明走的是子进程退出
      // 后的 EOF，而不是等到超时。
      expect(result.errors.get('suicide') ?? '').toMatch(
        /exited|closed stdout|before responding/i,
      )
      expect(elapsedMs).toBeLessThan(4000)

      expect(result.connectedServers).toContain('fs')
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑨ D3 在飞调用时对端被杀：调用以错误结果收场而不挂死，再次调用自动重连',
    async () => {
      const { manager, result } = await discover({
        crash: stdioConfig([CRASH_FIXTURE_ENTRY]),
      })
      expect(result.connectedServers).toEqual(['crash'])
      const firstConnection = manager.getConnection('crash')
      expect(firstConnection).toBeDefined()

      const ping = toolNamed(manager, 'mcp__crash_ping')
      expect(await callTool(ping, {})).toContain('pong')

      // `die` 不回包、直接退进程：在飞的请求必须以"连接断了"收场。omp 不
      // 抛异常，而是交回一个 isError 结果；EOF 属于可重试错误，MCPTool 会
      // 重连并重放一次，重放的 `die` 再杀一次新进程，结论仍是错误结果。
      const died = await execute(toolNamed(manager, 'mcp__crash_die'), {})
      expect(died.isError).toBe(true)
      expect(resultText(died)).toMatch(/failure: (eof|closed)/)

      // 自愈：同一个 Tool 对象再调一次。它手里那条连接已经死了，可重试错误
      // 触发 manager 的 reconnectServer，重新拉起进程后重放。
      expect(await callTool(ping, {})).toContain('pong')

      // 重连出来的是新连接对象，manager 记的是活的那条。
      await manager.waitForPendingConnections()
      expect(manager.getConnectionStatus('crash')).toBe('connected')
      expect(manager.getConnection('crash')).not.toBe(firstConnection)
      expect(
        await callTool(toolNamed(manager, 'mcp__crash_ping'), {}),
      ).toContain('pong')

      // 反向结论（"没有漏网的 rejection"）才睡固定窗口：unhandledRejection
      // 是下一个 microtask checkpoint 之后才派发的，等的是它不出现。
      await Bun.sleep(250)
      expect(unhandledRejections).toEqual([])
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑩ 逐 server 的 timeout 生效：装死的工具在约定时间被掐断',
    async () => {
      // omp 的默认请求超时是 30s；要让一个装死的 server 可控而快速地失败，
      // 逐 server 配 `timeout`（mcp.json 里的字段，同时管连接和请求）。
      const { manager, result } = await discover({
        slow: stdioConfig([CRASH_FIXTURE_ENTRY], { timeout: 3000 }),
      })
      expect(result.connectedServers).toEqual(['slow'])

      const startedAt = Date.now()
      const hung = await execute(toolNamed(manager, 'mcp__slow_hang'), {})
      const elapsedMs = Date.now() - startedAt

      expect(hung.isError).toBe(true)
      expect(resultText(hung)).toMatch(/failure: timeout/)
      expect(resultText(hung)).toMatch(/timeout after 3000ms/i)
      expect(elapsedMs).toBeGreaterThanOrEqual(2500)
      expect(elapsedMs).toBeLessThan(10_000)

      // 超时不是连接断了：不重连，连接还是原来那条，还能接着用。
      expect(manager.getConnectionStatus('slow')).toBe('connected')
    },
    CASE_TIMEOUT_MS,
  )
})

/**
 * 假模型：一个最小的 OpenAI chat-completions 流式服务，按对话里已有的工具
 * 结果条数走固定剧本——先调 filesystem 的 write_file，再调 memory 的
 * create_entities，最后给一句文字收尾。工具名从请求的 `tools` 里按后缀找，
 * 不写死前缀，所以 omp 怎么给 MCP 工具起名都不影响剧本。
 */
function startScriptedModel(sandbox: string): {
  readonly port: number
  readonly requests: unknown[]
  stop(): void
} {
  const requests: unknown[] = []
  const target = join(sandbox, 'p63-agent-wrote.txt')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({
          object: 'list',
          data: [{ id: 'scripted', object: 'model', owned_by: 'test' }],
        })
      }
      if (!url.pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as {
        messages?: { role: string }[]
        tools?: { function?: { name?: string } }[]
      }
      requests.push(body)
      const offered = (body.tools ?? []).map(t => t.function?.name ?? '')
      const results = (body.messages ?? []).filter(
        m => m.role === 'tool',
      ).length
      const find = (suffix: string) => offered.find(n => n.endsWith(suffix))
      let delta: Record<string, unknown>
      let finish = 'tool_calls'
      const call = (name: string | undefined, args: object) => ({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${results}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      })
      if (results === 0) {
        delta = call(find('fs_write_file'), {
          path: target,
          content: 'written by the agent through MCP\n',
        })
      } else if (results === 1) {
        delta = call(find('memory_create_entities'), {
          entities: [
            {
              name: 'p63',
              entityType: 'check',
              observations: ['agent was here'],
            },
          ],
        })
      } else {
        delta = { role: 'assistant', content: 'both servers answered' }
        finish = 'stop'
      }
      const base = {
        id: 'chatcmpl-scripted',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'scripted',
      }
      const chunks = [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
      return new Response(
        `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return {
    port: server.port as number,
    requests,
    stop: () => void server.stop(true),
  }
}

describe('P6.3 整机链路：qm 拉起的 omp 子进程自己做 MCP 客户端', () => {
  test('⑪ omp --mode rpc 读隔离根下的 mcp.json，经假模型调用两个第三方 server 的工具', async () => {
    const model = startScriptedModel(sandboxDir)
    await writeFile(
      join(ompAgentDir(), 'models.yml'),
      [
        'providers:',
        '  scripted:',
        `    baseUrl: http://127.0.0.1:${model.port}/v1`,
        '    auth: none',
        '    api: openai-completions',
        '    models:',
        '      - id: scripted',
        '        name: Scripted',
        '        reasoning: false',
        '',
      ].join('\n'),
    )
    await writeFile(
      join(ompAgentDir(), 'mcp.json'),
      JSON.stringify({
        mcpServers: { fs: fsConfig(sandboxDir), memory: memoryConfig() },
      }),
    )
    await writeFile(
      join(ompAgentDir(), 'config.yml'),
      'tools:\n  xdev: false\n',
    )
    // 与 qm 常驻宿主拉起 omp 子进程同一套：ompArgv + ompSpawnEnv，状态全
    // 在 QIANMO_CONFIG_DIR/omp 下，cwd 是智能体自己的工作区。
    const [bun, ...entry] = ompArgv([])
    const client = new RpcClient({
      command: [bun as string, ...entry],
      cwd: sandboxDir,
      env: ompSpawnEnv({ OMP_MCP_STARTUP_TIMEOUT_MS: '0' }),
      provider: 'scripted',
      model: 'scripted',
      args: ['--no-session'],
    })
    try {
      await client.start()
      const events = await client.promptAndWait(
        'write a file, then remember it',
        undefined,
        25_000,
      )
      const tools = events.flatMap(e =>
        e.type === 'tool_execution_end'
          ? [{ name: e.toolName, isError: e.isError === true }]
          : [],
      )
      expect(tools.map(t => t.isError)).toEqual([false, false])
      expect(tools[0]?.name).toMatch(/fs_write_file$/)
      expect(tools[1]?.name).toMatch(/memory_create_entities$/)

      // 落盘为证：server 真的收到了调用，而不只是模型说它收到了。
      expect(
        await readFile(join(sandboxDir, 'p63-agent-wrote.txt'), 'utf8'),
      ).toBe('written by the agent through MCP\n')
      expect(await readFile(memoryFile, 'utf8')).toContain('agent was here')
      expect(model.requests).toHaveLength(3)
    } finally {
      await client.stop()
      model.stop()
    }
  }, 120_000)
})
