// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff mcp` — the handoff as tools a model can call, over stdio MCP
 * (`handoff-p17-plan.md` §2 P17.3 本仓库).
 *
 * qmcode starts it for every thread from its built-in `[mcp_servers.qianmo]`
 * (fork `codex-rs/config/defaults.toml`), and once more for `/mcp`; Claude
 * Code starts it when the user ran `claude mcp add qianmo -- qm handoff mcp`.
 *
 * ## Tools
 *
 * Only tools whose back end is in this repository today; a tool that can
 * only fail wastes a model turn. The plan card's table grew with the
 * packages: `qianmo_send` with P17.5, `qianmo_pull` with P17.6.
 *
 * | Tool | Does | Back end |
 * | --- | --- | --- |
 * | `qianmo_status` | read-only: settings, session, last sync, the hub's tasks | `runStatus` |
 * | `qianmo_handoff` | pushes the work tree and session, registers the task | `runNow`, cut mode |
 * | `qianmo_task` | read-only: one task's state, brief and result | `runTask` |
 * | `qianmo_send` | one sentence for a task in the cloud, via the hub (P17.5) | `runSend` |
 * | `qianmo_pull` | brings a finished task home without overwriting anything (P17.6) | `runPull` |
 *
 * ## The call comes from inside a turn
 *
 * The model calls `qianmo_handoff` mid-turn, and that turn cannot end while
 * the tool waits for it. So the transcript is cut before the turn running —
 * qmcode at its `task_started`, Claude Code after the last complete turn —
 * and the answer says where (`runNow` with `whileRunning: 'cut'`).
 *
 * Which session: qmcode names its thread in every `tools/call` as
 * `params._meta.threadId` (`codex-rs/core/src/mcp_tool_call.rs`,
 * `with_mcp_tool_call_ids_meta`; seen on a local debug build of the fork,
 * 2026-10-03); when that thread has a rollout, it is the one. Otherwise — Claude Code, or a thread not on disk — the session last
 * reported from this directory (`sessions.json`, written by the hooks). The
 * environment's `CODEX_THREAD_ID` is not read: qmcode does not pass it to MCP
 * servers, and a Claude Code started from a qmcode shell inherits some other
 * thread's.
 *
 * ## Stateless, any number at once
 *
 * Nothing here is kept between calls or written by this module; every call
 * reads `projects.json`, `sessions.json` and the hub afresh. Two handoffs at
 * once — two threads, two instances — meet at `runNow`'s per-repository lock,
 * and the second answers 「另一份转交正在进行」.
 *
 * ## No environment in anything
 *
 * Claude Code hands its MCP servers its whole environment, model key
 * included. Answers carry the same lines `qm handoff` prints — ids, paths,
 * hashes, P17.4's reasons — and stderr only an error's message.
 *
 * ## Exit
 *
 * When stdin ends: wait for the calls in flight, including any read just
 * before EOF (up to {@link DRAIN_TIMEOUT_MS} in all), so their answers and
 * their `git` children finish, then exit 0.
 */

import type {
  CallToolResult,
  ListToolsResult,
  Tool,
} from '@modelcontextprotocol/server'
import { Server } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { FIELD_MAX_BYTES, isIsoInstant, isTaskId } from '@qianmo/handoff'
import {
  type HandoffCaller,
  type Output,
  runNow,
  runSend,
  runStatus,
  runTask,
} from './handoffNow.js'
import { runPull } from './handoffPull.js'
import { HandoffUserError, sleep } from './handoffStore.js'
import { buildVersion } from '../provenance.js'

/** How long a call in flight may keep the process after stdin ends. */
const DRAIN_TIMEOUT_MS = 30_000

const BRIEF_MAX = FIELD_MAX_BYTES.brief

const TOOLS: Tool[] = [
  {
    name: 'qianmo_status',
    title: '接力状态',
    description:
      '查看当前仓库的接力状态：登记信息、转交时会带上的会话、最近一次同步、中枢上本项目的接力任务。只读。',
    inputSchema: { type: 'object', properties: {} },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'qianmo_handoff',
    title: '转交云端',
    description:
      '把当前工作转交给云端继续。有副作用：把工作区（含未提交、未跟踪且未被忽略的文件）的影子提交和当前会话记录推送到中枢，并在中枢登记一个接力任务；不改本地分支、暂存区和文件。' +
      '会话截到最后一个完整回合，调用本工具的这个回合不在其中，所以目标、已完成、剩余要写全。' +
      '中枢确认数据已落地并登记后才返回「已落地，可以关机」和任务号；否则返回失败原因，此时不能关机。' +
      '只在用户要求把工作交给云端时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '云端要完成的目标',
          minLength: 1,
          maxLength: BRIEF_MAX,
        },
        done: {
          type: 'string',
          description: '已经完成的部分；没有就给空字符串',
          maxLength: BRIEF_MAX,
        },
        remaining: {
          type: 'string',
          description: '还剩下的工作；没有就给空字符串',
          maxLength: BRIEF_MAX,
        },
        deadline: {
          type: 'string',
          description:
            '截止时间，UTC，如 2026-11-20T02:00:00Z；不给为 24 小时后',
        },
      },
      required: ['goal', 'done', 'remaining'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'qianmo_task',
    title: '接力任务',
    description:
      '查一个接力任务：状态、目标与简报、派发的节点、云端完成后的结果摘要。不给 taskId 时查本项目最近的一个。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '任务号，qianmo_handoff 或 qianmo_status 给出的那个',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'qianmo_send',
    title: '给云端的话',
    description:
      '给已经转交到云端、还没结束的接力任务追加一句话。有副作用：中枢记下这句话，节点接手任务后转过去，进入云端正在跑的回合（没有回合在跑时开一个新回合）。' +
      '任务已结束时返回失败原因。只在用户要给云端补充说明或改主意时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '任务号，qianmo_handoff 或 qianmo_status 给出的那个',
        },
        text: {
          type: 'string',
          description: '要转给云端的话',
          minLength: 1,
          maxLength: BRIEF_MAX,
        },
      },
      required: ['taskId', 'text'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'qianmo_pull',
    title: '接回本机',
    description:
      '把云端已经完成的接力任务接回本机。有副作用：从中枢取回结果；转交以来本机没动过时当前分支快进到云端结果，动过时结果放到新分支 qianmo/<taskId>-return 并列出差异，本机文件一个都不改；qmcode 会话放回本机会话目录；中枢记为已接回。' +
      '不给 taskId 时接本项目最近一个完成的任务。任务还在云端或失败时返回原因。只在用户要把云端结果拿回来时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: '任务号，qianmo_handoff 或 qianmo_status 给出的那个',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
]

function answer(lines: readonly string[], isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    ...(isError ? { isError: true } : {}),
  }
}

/** A thread id as qmcode writes one; anything else is not a thread. */
const THREAD_ID = /^[A-Za-z0-9-]{1,128}$/

function callerOf(meta: unknown): HandoffCaller {
  const thread =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>).threadId
      : undefined
  return {
    thread:
      typeof thread === 'string' && THREAD_ID.test(thread) ? thread : undefined,
    inThreadShell: false,
  }
}

type Arguments = Readonly<Record<string, unknown>>

function briefText(args: Arguments, name: string, nonEmpty: boolean): string {
  const value = args[name]
  if (typeof value !== 'string') {
    throw new HandoffUserError(`参数 ${name} 必须是字符串`)
  }
  if (nonEmpty && value.trim() === '') {
    throw new HandoffUserError(`参数 ${name} 不能为空`)
  }
  if (Buffer.byteLength(value) > BRIEF_MAX) {
    throw new HandoffUserError(`参数 ${name} 超过 ${BRIEF_MAX} 字节`)
  }
  return value
}

async function handOff(
  cwd: string,
  args: Arguments,
  caller: HandoffCaller,
  output: Output,
): Promise<void> {
  const goal = briefText(args, 'goal', true)
  const done = briefText(args, 'done', false)
  const remaining = briefText(args, 'remaining', false)
  const deadline = args.deadline
  if (deadline !== undefined && !isIsoInstant(deadline)) {
    throw new HandoffUserError(
      '参数 deadline 要写成 UTC 时间，如 2026-11-20T02:00:00Z',
    )
  }
  await runNow(
    cwd,
    {
      goal,
      done,
      remaining,
      ...(deadline === undefined ? {} : { deadline }),
    },
    output,
    { whileRunning: 'cut', caller },
  )
}

/** One `tools/call`, answered in the lines `qm handoff` prints. */
async function callTool(
  cwd: string,
  name: string,
  args: Arguments,
  meta: unknown,
): Promise<CallToolResult> {
  const lines: string[] = []
  const output: Output = {
    out: line => lines.push(line),
    err: line => lines.push(line),
  }
  const caller = callerOf(meta)
  const failed =
    name === 'qianmo_handoff'
      ? '转交没有完成'
      : name === 'qianmo_send'
        ? '话没有送出'
        : name === 'qianmo_pull'
          ? '接回没有完成'
          : '查询没有完成'
  try {
    switch (name) {
      case 'qianmo_status':
        try {
          await runStatus(cwd, { wait: false }, output, caller)
        } catch (error) {
          // The local half is worth having when the hub cannot be asked.
          if (!(error instanceof HandoffUserError) || lines.length === 0) {
            throw error
          }
          lines.push(`任务    （${error.message}）`)
        }
        return answer(lines)
      case 'qianmo_handoff':
        await handOff(cwd, args, caller, output)
        return answer(lines)
      case 'qianmo_task': {
        const taskId = args.taskId
        if (taskId !== undefined && !isTaskId(taskId)) {
          throw new HandoffUserError('参数 taskId 不是任务号')
        }
        await runTask(cwd, taskId === undefined ? {} : { taskId }, output)
        return answer(lines)
      }
      case 'qianmo_send': {
        const taskId = args.taskId
        if (!isTaskId(taskId)) {
          throw new HandoffUserError('参数 taskId 不是任务号')
        }
        const text = briefText(args, 'text', true)
        await runSend(cwd, { taskId, text }, output)
        return answer(lines)
      }
      case 'qianmo_pull': {
        const taskId = args.taskId
        if (taskId !== undefined && !isTaskId(taskId)) {
          throw new HandoffUserError('参数 taskId 不是任务号')
        }
        const code = await runPull(
          cwd,
          {
            ...(taskId === undefined ? {} : { taskId }),
            ...(caller.thread === undefined
              ? {}
              : { callerThread: caller.thread }),
          },
          output,
        )
        return answer(lines, code !== 0)
      }
      default:
        return answer([`没有工具 ${name}`], true)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof HandoffUserError)) {
      process.stderr.write(`qm handoff mcp: ${name}: ${message}\n`)
    }
    return answer([...lines, `${failed}：${message}`], true)
  }
}

function buildServer(cwd: string, inFlight: Set<Promise<unknown>>): Server {
  const server = new Server(
    { name: 'qianmo-handoff', version: buildVersion() },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(
    'tools/list',
    async (): Promise<ListToolsResult> => ({ tools: TOOLS }),
  )
  server.setRequestHandler('tools/call', ({ params }) => {
    const call = callTool(
      cwd,
      params.name,
      params.arguments ?? {},
      params._meta,
    )
    inFlight.add(call)
    void call.finally(() => inFlight.delete(call))
    return call
  })
  return server
}

/** The `qm handoff mcp` entry: serves until stdin ends. */
export function runHandoffMcp(cwd: string = process.cwd()): void {
  const inFlight = new Set<Promise<unknown>>()
  // A fresh Server per factory call, never a captured one (`serveStdio` may
  // close a probe instance and ask again; see `computerUse/mcpServer.ts`).
  const handle = serveStdio(() => buildServer(cwd, inFlight), {
    onerror: error => {
      process.stderr.write(`qm handoff mcp: ${error.message}\n`)
    },
  })
  let ending = false
  const end = async (): Promise<void> => {
    if (ending) return
    ending = true
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    // A request read just before EOF may not have reached its handler yet.
    await sleep(50)
    while (inFlight.size > 0 && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise(done => {
          timer = setTimeout(done, deadline - Date.now())
        }),
      ])
      clearTimeout(timer)
    }
    // The answers are written after the handlers settle; let them out.
    await sleep(50)
    await handle.close().catch(() => {})
    process.stdout.write('', () => process.exit(0))
  }
  process.stdin.on('end', () => void end())
  process.stdin.on('close', () => void end())
}
