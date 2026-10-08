// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 动作账本（P15.9，`tenancy-m1.md` §6）的宿主面：文件、接线、`--verify-actions`。
 *
 * **这里只搬字节、只接线。**行格式、严格读、「坏一行就整本停用」、脱敏全在包里
 * （`packages/console/src/actionLedger.ts`），那样每一条 fail-closed 规矩都能用
 * 一个普通对象测到。文件纪律照抄账号库那一份（`consoleAccountsStore.ts` 的
 * `FileLedger`：目录 0700、文件 0600、`O_APPEND | O_NOFOLLOW`、每行 fsync、读也
 * 不跟符号链接），这里只在它上面加一个**文件指纹**：控制台在运行中靠它发现
 * 「账本被别人动过」，而不必每个请求都把整本读一遍。
 *
 * **路径不在这里拼**：它从 `consoleArgs.ts` 来，派生自 `occConfigPath()`
 * （CLAUDE.md §1.1②）。
 */

import { lstatSync, type BigIntStats } from 'node:fs'
import {
  ActionLedger,
  verifyActionLedger,
  type ActionLedgerStore,
  type ActionLedgerVerdict,
} from '@qianmo/console'
import { FileLedger } from './consoleAccountsStore.js'

/**
 * 账号库的文件面，外加指纹。
 *
 * 指纹取设备号、inode、大小和纳秒级修改时间：内容改了、文件被换了、被截了，
 * 至少有一项会变。有一个盲区写在这里：**同样大小的原地改写**只能靠修改时间看见，
 * 而它按文件系统的时钟节拍走（Linux 上是几毫秒一跳），紧跟在本进程一次写之后的
 * 那一跳之内改，指纹不动——这种改动由下一次 `list`（每次整本严格读）和
 * `--verify-actions` 抓到，只是不在下一次写之前。连 mtime 一起改回去就是中枢
 * 失陷，`tenancy-m1.md` §1.4 写明不防。
 *
 * **文件被换掉（inode 变了）不是「指纹变了」，是这个句柄废了**：追加用的 fd
 * 还指着原来那个 inode，换上来的文件内容哪怕一字不差，之后的每一行也都会写进
 * 一个已经不在路径上的文件里、谁也读不到。所以那种情况 {@link stamp} 直接抛，
 * 账本据此停用，重启控制台才会重新打开。
 */
export class FileActionLedger extends FileLedger implements ActionLedgerStore {
  /** 追加句柄指着的那个文件（设备号:inode），第一次追加之后才有。 */
  #held: string | null = null

  override append(line: string): void {
    super.append(line)
    if (this.#held === null) {
      const stats = lstatSync(this.path, { bigint: true })
      this.#held = `${stats.dev}:${stats.ino}`
    }
  }

  stamp(): string | null {
    let stats: BigIntStats
    try {
      stats = lstatSync(this.path, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    // 符号链接不跟。给一个永远对不上的指纹，账本就会去整本重读，而读那一侧
    // 带 O_NOFOLLOW，会直接拒绝它。
    if (stats.isSymbolicLink()) return 'symlink'
    const identity = `${stats.dev}:${stats.ino}`
    if (this.#held !== null && identity !== this.#held) {
      throw new Error('文件被换掉了：追加句柄还指着原来那一个')
    }
    return `${identity}:${stats.size}:${stats.mtimeNs}`
  }
}

/**
 * 开账本。和账号库一样，**坏了也不让控制台起不来**：账本自己停用（写操作 503、
 * 操作记录拒读），告警进 stderr，横幅上照直写出原因。
 *
 * `secrets` 是绝不能落进账本的原值——宿主传两枚控制台 token，万一有人把它们
 * 敲进了 URL 路径，break-glass 那一行记下的是 `***`。
 */
export function openConsoleActionLedger(options: {
  readonly path: string
  readonly secrets: readonly string[]
  readonly onAlarm?: (line: string) => void
}): ActionLedger {
  return new ActionLedger({
    store: new FileActionLedger(options.path),
    secrets: options.secrets,
    onAlarm:
      options.onAlarm ??
      (line => {
        process.stderr.write(`${line}\n`)
      }),
  })
}

/**
 * `qm console --verify-actions`：读一遍账本，打出判定，返回退出码。
 *
 * 形状照抄 `qm audit --verify`（`qianmoAudit.ts`）：四态 `absent / empty /
 * intact / broken`，`intact` 字段只在「有链且没毛病」时为真；**退出码只由
 * 「发现了问题」驱动**——账本坏了或读不出来是 1，一本还没建立的账不是一个发现，
 * 是 0。那正是它能进 cron 的原因。
 *
 * 不用 `qm audit --verify` 本身，是因为两者的行不是一个形状：那条命令按
 * `AuditRecord` 的规范形算摘要，会把一本完好的动作账本判成断链（理由见
 * `actionLedger.ts` 的模块注释）。
 */
export function runActionLedgerVerify(
  path: string,
  write: (text: string) => void = text => {
    process.stdout.write(text)
  },
): number {
  let verdict: ActionLedgerVerdict
  try {
    verdict = verifyActionLedger(new FileActionLedger(path).read())
  } catch (error) {
    verdict = {
      chain: 'broken',
      actions: 0,
      issue: {
        line: 0,
        reason: `读不出来（${error instanceof Error ? error.message : String(error)}）`,
      },
    }
  }
  const summary = {
    path,
    ...verdict,
    intact: verdict.chain === 'intact' || verdict.chain === 'empty',
  }
  write(`${JSON.stringify(summary, null, 2)}\n`)
  return verdict.chain === 'broken' ? 1 : 0
}
