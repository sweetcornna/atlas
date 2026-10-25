// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything the conversation front says, in each language it speaks
 * (`i18n.ts`).
 *
 * One interface, one table per language, so a key missing from a language
 * is a type error rather than a blank on the page. What the agents and the
 * people write is never translated; neither are names, addresses, model ids,
 * task and trace ids, or the brand.
 *
 * The page script's own words travel to the browser with the page
 * ({@link frontClientText}); the rest is drawn on the server.
 */

import type { Lang } from '../i18n.js'

/** What a step's verb or tool is called, by kind of work (`front.ts`). */
interface ActivityWords {
  readonly thinking: string
  readonly read: string
  readonly search: string
  readonly edit: string
  readonly run: string
  readonly fetch: string
  readonly computer: string
  readonly browser: string
  readonly mail: string
  readonly calendar: string
  readonly connectors: string
  readonly file: string
  readonly generate: string
  readonly memory: string
  /** Between the words and what they act on. */
  readonly colon: string
  readonly failed: string
}

/** The keyboard help's rows, by what the keys do. */
interface KeyWords {
  readonly send: string
  readonly newline: string
  /** ⌘N: the main agent's conversation, until 开始一项工作 takes it (P37.17 B). */
  readonly mainAgent: string
  readonly search: string
  readonly side: string
  readonly panel: string
  readonly close: string
  readonly help: string
  readonly quick: string
  readonly settings: string
}

export interface FrontText {
  readonly agents: string
  readonly rosterDown: string
  readonly noAgents: string
  readonly manageNodes: string
  readonly working: string
  readonly mainTag: string
  readonly noMatch: string
  readonly online: string
  readonly notConnected: string
  readonly notInRoster: string
  readonly noLongerListed: string
  readonly notConnectedForChat: string
  readonly newChat: string
  readonly changeLook: string
  changeLookOf(name: string): string
  readonly copyAddress: string
  readonly nodeDetails: string
  readonly modelSettings: string
  readonly messageChain: string
  actionsFor(name: string): string

  readonly chats: string
  readonly chatScope: string
  readonly thisAgent: string
  readonly all: string
  readonly chatList: string
  readonly historyWindows: readonly [string, string, string, string]
  readonly noChats: string
  readonly chatHistory: string

  subAgentsWorking(count: number): string
  workingInBackground(count: number): string
  more(count: number): string

  readonly sent: string
  readonly delivered: string
  receipt(id: string): string
  readonly receiptUnknown: string
  readonly awaitingDelivery: string
  /** A line sent while the agent works on an earlier one. */
  readonly queuedNext: string
  readonly read: string
  readonly unread: string
  readonly failed: string
  readonly trace: string
  /** The short task id a reply carries. */
  readonly task: string
  readonly copyReply: string

  stepsDone(count: number): string
  stepsRunning(count: number): string
  readonly details: string
  readonly resent: string
  readonly activity: ActivityWords

  readonly agentInfo: string
  readonly address: string
  readonly node: string
  readonly status: string
  readonly chatChannel: string
  readonly connected: string
  readonly thisChat: string
  chatStats(turns: number, started: string): string
  readonly chat: string

  readonly roleAdmin: string
  readonly roleView: string
  readonly me: string
  readonly accountMenu: string
  readonly changeMyLook: string
  readonly appearance: string
  readonly themeSystem: string
  readonly themeLight: string
  readonly themeDark: string
  readonly accent: string
  readonly accentCustom: string
  /** The preset theme colours' names, by preset (`accent.ts`). */
  readonly accentNames: Readonly<Record<string, string>>
  readonly accentCustomAria: string
  readonly language: string
  readonly signOut: string
  readonly skipToBox: string
  readonly collapseSide: string
  readonly expandSide: string
  readonly closeSide: string
  readonly search: string
  readonly jumpToLatest: string
  readonly message: string
  readonly placeholder: string
  readonly localCommands: string
  readonly commands: string
  readonly voiceInput: string
  readonly send: string
  readonly commandWords: Readonly<Record<string, string>>
  readonly keyboardTitle: string
  /** What each shortcut in the keyboard help does (`front.ts`, `keyboardHelp`). */
  readonly keys: KeyWords
  readonly close: string

  /**
   * The two faces of the front and the switch between them (`qmo-app.md`
   * §1): 对话 at `/app`, 智能体 at `/`.
   */
  readonly faces: string
  readonly faceChat: string
  readonly faceAgents: string

  /**
   * The two modes over the side list (P37.13, qmo-local.md §3.6): Work is the
   * conversations, Code the work on this computer. The two words are the
   * modes' names and stay as they are in every language.
   */
  readonly modes: string
  readonly work: string
  readonly code: string
  /** The settings card: every management area, over the page. */
  readonly settings: string
  readonly settingsSearch: string
  readonly closeSettings: string
  /** The settings card's skip link, past its list to the area. */
  readonly skipToArea: string
  /** The desktop app's own settings window, from the card. */
  readonly desktopApp: string
  /** `/code`: its side list, and what its page says in a browser. */
  readonly newCodeSession: string
  readonly codeSessions: string
  readonly noCodeSessions: string
  readonly codeInApp: string
  /** A local session's box: the first line, and every line after it (P37.14a). */
  readonly codeFirst: string
  readonly codeReply: string
  readonly folder: string
  readonly agentWord: string
  readonly rescan: string
  /** Remote, held off until P37.15: why it cannot be turned on. */
  readonly remoteLater: string
  /** 跳过权限确认 asks once more, in a line under the box. */
  readonly bypassLine: string
  readonly confirm: string
  /** The changes panel (Git). */
  readonly changes: string
  readonly refresh: string
  /** The Work face without a conversation: no channel, or an identity that may not hold one. */
  readonly noChatChannel: string
  readonly noChatRole: string
  /** `/app`'s side list: every conversation, by calendar day. */
  readonly recents: string
  readonly dayGroups: readonly [string, string, string, string]
  readonly noConversations: string
  /**
   * P37.17: an agent's conversations other than the reader's one with it
   * (its ⋯, a dialog), read here and not written in, and the way back.
   */
  readonly otherChats: string
  readonly readOnly: string
  backTo(name: string): string
  /** Over a new conversation, by the reader's hour: morning, afternoon, evening. */
  readonly greetings: readonly [string, string, string]
  readonly pickAgent: string
  readonly openInAgents: string
  sessionActions(title: string): string
  /** The thin line at the top while the network is gone. */
  readonly offline: string
  readonly loading: string
  /** The dot by the panel button while an agent works a computer or browser. */
  readonly computerInUse: string
  /** 快速输入 (`/app/quick`). */
  readonly quickEntry: string
  readonly switchAgent: string

  /** 模型 and 权限模式 under the composer's line (`frontTools.ts`). */
  readonly model: string
  readonly modelAuto: string
  readonly modelAutoNote: string
  readonly effort: string
  readonly effortLevels: Readonly<
    Record<
      | 'inherit'
      | 'off'
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max',
      string
    >
  >
  readonly permission: string
  readonly permModes: Readonly<
    Record<'off' | 'accept-edits' | 'auto' | 'full-access', string>
  >
  readonly permNotes: Readonly<
    Record<'off' | 'accept-edits' | 'auto' | 'full-access', string>
  >
  readonly permDefaults: string
  readonly bypassTitle: string
  readonly bypassBody: string
  readonly bypassConfirm: string
  readonly cancel: string

  /** The session panel on the right (`frontPanel.ts`). */
  readonly sessionPanel: string
  readonly closePanel: string
  readonly panelEmpty: string
  readonly backgroundTasks: string
  tasksRunning(count: number): string
  tasksWaiting(count: number): string
  tasksDone(count: number): string
  readonly tasksEmpty: string
  readonly taskStatus: Readonly<
    Record<
      | 'scheduled'
      | 'queued'
      | 'running'
      | 'interrupted'
      | 'completion_pending'
      | 'needs_input_pending'
      | 'needs_input'
      | 'completed'
      | 'cancelled',
      string
    >
  >
  readonly taskState: string
  readonly taskAsk: string
  readonly taskResult: string
  readonly taskProgress: string
  readonly taskError: string
  readonly openWorker: string
  readonly stop: string
  readonly cloudComputer: string
  readonly cloudComputerNote: string
  ago(at: number, now: number): string
}

/** What the page script says, sent with the page as data. */
interface FrontClientText {
  readonly messageTo: string
  readonly unavailable: string
  /** The composer under a conversation read here and not written in (P37.17). */
  readonly readOnly: string
  readonly opening: string
  readonly pickAgent: string
  readonly noSession: string
  readonly sending: string
  /** The line just sent while the agent works on an earlier one. */
  readonly queuedNext: string
  /** A permission mode just switched: the lead before its name. */
  readonly switchedTo: string
  readonly notWired: string
  readonly opsOnly: string
  /** The hub's default mode; `{mode}` is its name. */
  readonly defaultOn: string
  /** A person turned the agent off: the default stays off. */
  readonly defaultHeld: string
  readonly stopping: string
  readonly stopped: string
  readonly sent: string
  readonly sentRetrying: string
  /** A line whose send failed, kept in the conversation with 重试 (P37.13). */
  readonly notDelivered: string
  readonly retry: string
  /** `/code`: the agents on this computer (`qmo agents --json`). */
  readonly scanning: string
  readonly noLocalAgents: string
  readonly agentReady: string
  readonly agentNotReady: string
  readonly newReply: string
  readonly seeChat: string
  readonly polling: string
  readonly disconnected: string
  readonly copied: string
  readonly copyFailed: string
  readonly voiceUnavailable: string
  /** Leads of a failed open and send; Chinese uses the runtime's own line. */
  readonly openFailed?: string
  readonly sendFailed?: string
  readonly voiceLang: string
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A gap in whole units, and whether it is ahead (a node's clock running fast). */
function gap(
  at: number,
  now: number,
): {
  readonly unit: 's' | 'm' | 'h' | 'd' | 'now'
  readonly n: number
  readonly ahead: boolean
} {
  const delta = now - at
  const size = Math.abs(delta)
  const ahead = delta < 0
  if (!Number.isFinite(size) || size < SECOND)
    return { unit: 'now', n: 0, ahead }
  if (size < MINUTE) return { unit: 's', n: Math.floor(size / SECOND), ahead }
  if (size < HOUR) return { unit: 'm', n: Math.floor(size / MINUTE), ahead }
  if (size < DAY) return { unit: 'h', n: Math.floor(size / HOUR), ahead }
  return { unit: 'd', n: Math.floor(size / DAY), ahead }
}

const ZH: FrontText = {
  agents: '智能体',
  rosterDown: '名册不可达',
  noAgents: '暂无智能体',
  manageNodes: '管理节点',
  working: '执行中',
  mainTag: '主',
  noMatch: '无匹配',
  online: '在线',
  notConnected: '未接入',
  notInRoster: '不在名册',
  noLongerListed: '已不在名册',
  notConnectedForChat: '未接入对话',
  newChat: '新对话',
  changeLook: '换形象',
  changeLookOf: name => `换形象 · ${name}`,
  copyAddress: '复制地址',
  nodeDetails: '节点详情',
  modelSettings: '模型设置',
  messageChain: '消息链',
  actionsFor: name => `${name} 的操作`,
  chats: '会话',
  chatScope: '会话范围',
  thisAgent: '当前智能体',
  all: '全部',
  chatList: '会话列表',
  historyWindows: ['24 小时内', '7 天内', '30 天内', '更早'],
  noChats: '暂无会话',
  chatHistory: '会话记录',
  subAgentsWorking: n => `子智能体执行中 · ${n}`,
  workingInBackground: n => `后台执行 · ${n}`,
  more: n => `另有 ${n} 条`,
  sent: '已发出',
  delivered: '已投递',
  receipt: id => `回执 ${id}`,
  receiptUnknown: '回执未知',
  awaitingDelivery: '待投递',
  queuedNext: '排队中 · 下一步时送达',
  read: '已读',
  unread: '未读',
  failed: '失败',
  trace: '链',
  task: '任务',
  copyReply: '复制这条回复',
  stepsDone: n => `已执行 · ${n} 步`,
  stepsRunning: n => `进行中 · ${n} 步`,
  details: '详情',
  resent: '重发',
  activity: {
    thinking: '思考中',
    read: '读',
    search: '搜',
    edit: '改',
    run: '执行',
    fetch: '取',
    computer: '操作电脑',
    browser: '操作浏览器',
    mail: '邮件',
    calendar: '日程',
    connectors: '连接器',
    file: '传文件',
    generate: '生成',
    memory: '记忆',
    colon: '：',
    failed: '失败',
  },
  agentInfo: '智能体信息',
  address: '地址',
  node: '节点',
  status: '状态',
  chatChannel: '对话通道',
  connected: '已接入',
  thisChat: '本会话',
  chatStats: (turns, started) => `${turns} 轮 · 开始于 ${started}`,
  chat: '对话',
  roleAdmin: '管理',
  roleView: '只读',
  me: '我',
  accountMenu: '账号与外观',
  changeMyLook: '换我的形象',
  appearance: '外观',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  accent: '主题色',
  accentCustom: '自定义',
  accentNames: {
    ink: '墨',
    sage: '青',
    indigo: '黛',
    clay: '赭',
    plum: '紫',
    gold: '金',
  },
  accentCustomAria: '自定义主题色',
  language: '语言 · Language',
  signOut: '退出',
  skipToBox: '跳到输入框',
  collapseSide: '收起侧栏',
  expandSide: '展开侧栏',
  closeSide: '关闭侧栏',
  search: '搜索',
  jumpToLatest: '回到最新',
  message: '消息',
  placeholder: '发消息',
  localCommands: '本地命令',
  commands: '命令',
  voiceInput: '语音输入',
  send: '发送',
  commandWords: {
    model: '切换模型',
    thinking: '思考开关',
    effort: '推理档位',
    compact: '压缩上下文',
    context: '上下文用量',
    autocompact: '自动压缩阈值',
  },
  keyboardTitle: '快捷键',
  keys: {
    send: '发送',
    newline: '换行',
    mainAgent: '主智能体',
    search: '搜索',
    side: '收起或展开侧栏',
    panel: '会话面板',
    close: '关闭弹层',
    help: '快捷键',
    quick: '快速输入',
    settings: '设置',
  },
  close: '关闭',
  faces: '界面',
  faceChat: '对话',
  faceAgents: '智能体',
  modes: '模式',
  work: 'Work',
  code: 'Code',
  settings: '设置',
  settingsSearch: '搜索设置',
  closeSettings: '关闭设置',
  skipToArea: '跳到正文',
  desktopApp: '桌面版',
  newCodeSession: '新代码会话',
  codeSessions: '代码会话',
  noCodeSessions: '还没有代码会话',
  codeInApp: 'Code 在 Qmo 桌面版里用',
  codeFirst: '描述要做的事',
  codeReply: '接着说',
  folder: '文件夹',
  agentWord: 'agent',
  rescan: '重新检测',
  remoteLater: '后续版本开放',
  bypassLine: 'agent 将不经确认执行任何命令与改动',
  confirm: '确认',
  changes: '变更',
  refresh: '刷新',
  noChatChannel: '这里没有接入对话',
  noChatRole: '这个身份不能在这里对话',
  recents: '最近对话',
  dayGroups: ['今天', '昨天', '过去 7 天', '更早'],
  noConversations: '暂无对话',
  otherChats: '其他对话',
  readOnly: '只读',
  backTo: name => `回到 ${name}`,
  greetings: ['早上好', '下午好', '晚上好'],
  pickAgent: '选择智能体',
  openInAgents: '在智能体界面打开',
  sessionActions: title => `${title} 的操作`,
  offline: '网络已断开 · 恢复后自动重连',
  loading: '加载中',
  computerInUse: '云端电脑使用中',
  quickEntry: '快速输入',
  switchAgent: '换智能体',
  model: '模型',
  modelAuto: '自动',
  modelAutoNote: '按节点的配置选',
  effort: '推理强度',
  effortLevels: {
    inherit: '默认',
    off: '关闭',
    minimal: '最低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  },
  permission: '权限模式',
  permModes: {
    off: '人工确认',
    'accept-edits': '自动接受编辑',
    auto: '自动审批',
    'full-access': '跳过权限确认',
  },
  permNotes: {
    off: '有后果的操作逐次确认',
    'accept-edits': '工作区编辑直接执行 · 命令 联网 GitHub 逐次确认',
    auto: '沙箱命令 编辑 联网读取直接执行 · GitHub 写操作逐次确认',
    'full-access': '不再逐次确认 · 红线与云端电脑「每一步都确认」照旧',
  },
  permDefaults: '开启后按节点缺省的时长与次数 · 到期回到人工确认',
  bypassTitle: '跳过权限确认？',
  bypassBody:
    '这个智能体之后执行命令 改文件 访问外部都不再问你 · 到期 用完次数或收回前一直有效',
  bypassConfirm: '跳过确认',
  cancel: '取消',
  sessionPanel: '会话面板',
  closePanel: '关闭会话面板',
  panelEmpty: '这里会显示后台任务',
  backgroundTasks: '后台任务',
  tasksRunning: n => `${n} 个运行中`,
  tasksWaiting: n => `${n} 项待你处理`,
  tasksDone: n => `${n} 个已完成`,
  tasksEmpty: '子智能体的任务会出现在这里',
  taskStatus: {
    scheduled: '已安排',
    queued: '排队中',
    running: '运行中',
    interrupted: '失败',
    completion_pending: '运行中',
    needs_input_pending: '运行中',
    needs_input: '待你处理',
    completed: '已完成',
    cancelled: '已停止',
  },
  taskState: '状态',
  taskAsk: '要求',
  taskResult: '结果',
  taskProgress: '进度',
  taskError: '原因',
  openWorker: '打开子会话',
  stop: '停止',
  cloudComputer: '云端电脑',
  cloudComputerNote: '浏览器与电脑的开关和画面',
  ago: (at, now) => {
    const { unit, n, ahead } = gap(at, now)
    const tail = ahead ? '后' : '前'
    if (unit === 'now') return '刚刚'
    const words = { s: '秒', m: '分钟', h: '小时', d: '天' }[unit]
    return `${n} ${words}${tail}`
  },
}

const EN: FrontText = {
  agents: 'Agents',
  rosterDown: 'Roster unreachable',
  noAgents: 'No agents yet',
  manageNodes: 'Manage nodes',
  working: 'Working',
  mainTag: 'Main',
  noMatch: 'No matches',
  online: 'Online',
  notConnected: 'Not connected',
  notInRoster: 'Not in roster',
  noLongerListed: 'No longer in the roster',
  notConnectedForChat: 'Not connected for chat',
  newChat: 'New chat',
  changeLook: 'Change look',
  changeLookOf: name => `Change look · ${name}`,
  copyAddress: 'Copy address',
  nodeDetails: 'Node details',
  modelSettings: 'Model settings',
  messageChain: 'Message chain',
  actionsFor: name => `Actions for ${name}`,
  chats: 'Chats',
  chatScope: 'Which chats',
  thisAgent: 'This agent',
  all: 'All',
  chatList: 'Chat list',
  historyWindows: ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Older'],
  noChats: 'No chats yet',
  chatHistory: 'Chat history',
  subAgentsWorking: n => `Sub-agents working · ${n}`,
  workingInBackground: n => `Working in background · ${n}`,
  more: n => `${n} more`,
  sent: 'Sent',
  delivered: 'Delivered',
  receipt: id => `receipt ${id}`,
  receiptUnknown: 'Receipt unknown',
  awaitingDelivery: 'Awaiting delivery',
  queuedNext: 'Queued · goes in at the next step',
  read: 'Read',
  unread: 'Unread',
  failed: 'Failed',
  trace: 'trace',
  task: 'task',
  copyReply: 'Copy reply',
  stepsDone: n => `Done · ${n} ${n === 1 ? 'step' : 'steps'}`,
  stepsRunning: n => `In progress · ${n} ${n === 1 ? 'step' : 'steps'}`,
  details: 'Details',
  resent: 'Resent',
  activity: {
    thinking: 'Thinking',
    read: 'Reading',
    search: 'Searching',
    edit: 'Editing',
    run: 'Running',
    fetch: 'Fetching',
    computer: 'Using the computer',
    browser: 'Using the browser',
    mail: 'Mail',
    calendar: 'Calendar',
    connectors: 'Connectors',
    file: 'Sending a file',
    generate: 'Generating',
    memory: 'Memory',
    colon: ': ',
    failed: 'failed',
  },
  agentInfo: 'Agent info',
  address: 'Address',
  node: 'Node',
  status: 'Status',
  chatChannel: 'Chat channel',
  connected: 'Connected',
  thisChat: 'This chat',
  chatStats: (turns, started) => `${turns} turns · started ${started}`,
  chat: 'Chat',
  roleAdmin: 'Admin',
  roleView: 'Read-only',
  me: 'Me',
  accountMenu: 'Account and appearance',
  changeMyLook: 'Change my look',
  appearance: 'Appearance',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  accent: 'Theme color',
  accentCustom: 'Custom',
  accentNames: {
    ink: 'Ink',
    sage: 'Sage',
    indigo: 'Indigo',
    clay: 'Ochre',
    plum: 'Plum',
    gold: 'Gold',
  },
  accentCustomAria: 'Custom theme color',
  language: 'Language · 语言',
  signOut: 'Sign out',
  skipToBox: 'Skip to message box',
  collapseSide: 'Collapse sidebar',
  expandSide: 'Expand sidebar',
  closeSide: 'Close sidebar',
  search: 'Search',
  jumpToLatest: 'Jump to latest',
  message: 'Message',
  placeholder: 'Message',
  localCommands: 'Local commands',
  commands: 'Commands',
  voiceInput: 'Voice input',
  send: 'Send',
  commandWords: {
    model: 'Switch model',
    thinking: 'Toggle thinking',
    effort: 'Reasoning effort',
    compact: 'Compact context',
    context: 'Context usage',
    autocompact: 'Auto-compact threshold',
  },
  keyboardTitle: 'Keyboard shortcuts',
  keys: {
    send: 'Send',
    newline: 'New line',
    mainAgent: 'Main agent',
    search: 'Search',
    side: 'Collapse or expand the sidebar',
    panel: 'Session panel',
    close: 'Close menus',
    help: 'Keyboard shortcuts',
    quick: 'Quick entry',
    settings: 'Settings',
  },
  close: 'Close',
  faces: 'View',
  faceChat: 'Chat',
  faceAgents: 'Agents',
  modes: 'Mode',
  work: 'Work',
  code: 'Code',
  settings: 'Settings',
  settingsSearch: 'Search settings',
  closeSettings: 'Close settings',
  skipToArea: 'Skip to content',
  desktopApp: 'Desktop app',
  newCodeSession: 'New code session',
  codeSessions: 'Code sessions',
  noCodeSessions: 'No code sessions yet',
  codeInApp: 'Code runs in the Qmo desktop app',
  codeFirst: 'Describe a task',
  codeReply: 'Reply',
  folder: 'Folder',
  agentWord: 'Agent',
  rescan: 'Scan again',
  remoteLater: 'Coming in a later version',
  bypassLine:
    'The agent will run any command and make any change without asking',
  confirm: 'Confirm',
  changes: 'Changes',
  refresh: 'Refresh',
  noChatChannel: 'No conversation channel here',
  noChatRole: 'This identity cannot hold conversations here',
  recents: 'Recent chats',
  dayGroups: ['Today', 'Yesterday', 'Previous 7 days', 'Older'],
  noConversations: 'No chats yet',
  otherChats: 'Other conversations',
  readOnly: 'Read only',
  backTo: name => `Back to ${name}`,
  greetings: ['Good morning', 'Good afternoon', 'Good evening'],
  pickAgent: 'Choose an agent',
  openInAgents: 'Open in Agents',
  sessionActions: title => `Actions for ${title}`,
  offline: 'Offline · reconnects when the network is back',
  loading: 'Loading',
  computerInUse: 'Cloud computer in use',
  quickEntry: 'Quick entry',
  switchAgent: 'Switch agent',
  model: 'Model',
  modelAuto: 'Auto',
  modelAutoNote: "Follows the node's configuration",
  effort: 'Reasoning effort',
  effortLevels: {
    inherit: 'Default',
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  },
  permission: 'Permission mode',
  permModes: {
    off: 'Ask first',
    'accept-edits': 'Accept edits',
    auto: 'Auto approve',
    'full-access': 'Skip permissions',
  },
  permNotes: {
    off: 'Asks before anything with consequences',
    'accept-edits': 'Workspace edits run · commands, web and GitHub ask',
    auto: 'Sandboxed commands, edits and web reads run · GitHub writes ask',
    'full-access': 'Stops asking · hard limits and computer step checks stay',
  },
  permDefaults:
    "Uses the node's default time and call budget · then back to Ask first",
  bypassTitle: 'Skip permissions?',
  bypassBody:
    'This agent runs commands, edits files and reaches out without asking · until it expires, runs out or is revoked',
  bypassConfirm: 'Skip permissions',
  cancel: 'Cancel',
  sessionPanel: 'Session panel',
  closePanel: 'Close the session panel',
  panelEmpty: 'Background tasks show up here',
  backgroundTasks: 'Background tasks',
  tasksRunning: n => `${n} running`,
  tasksWaiting: n => `${n} need you`,
  tasksDone: n => `${n} finished`,
  tasksEmpty: "Sub-agents' tasks show up here",
  taskStatus: {
    scheduled: 'Scheduled',
    queued: 'Queued',
    running: 'Running',
    interrupted: 'Failed',
    completion_pending: 'Running',
    needs_input_pending: 'Running',
    needs_input: 'Needs you',
    completed: 'Done',
    cancelled: 'Stopped',
  },
  taskState: 'Status',
  taskAsk: 'Asked',
  taskResult: 'Result',
  taskProgress: 'Progress',
  taskError: 'Reason',
  openWorker: "Open the worker's chat",
  stop: 'Stop',
  cloudComputer: 'Cloud computer',
  cloudComputerNote: 'Browser and computer switches and screens',
  ago: (at, now) => {
    const { unit, n, ahead } = gap(at, now)
    if (unit === 'now') return 'just now'
    const words = { s: 's', m: 'm', h: 'h', d: 'd' }[unit]
    return ahead ? `in ${n}${words}` : `${n}${words} ago`
  },
}

const JA: FrontText = {
  agents: 'エージェント',
  rosterDown: '名簿に接続できません',
  noAgents: 'エージェントはまだいません',
  manageNodes: 'ノードを管理',
  working: '実行中',
  mainTag: 'メイン',
  noMatch: '一致なし',
  online: 'オンライン',
  notConnected: '未接続',
  notInRoster: '名簿にありません',
  noLongerListed: '名簿から外れました',
  notConnectedForChat: 'チャット未接続',
  newChat: '新しいチャット',
  changeLook: '見た目を変更',
  changeLookOf: name => `見た目を変更 · ${name}`,
  copyAddress: 'アドレスをコピー',
  nodeDetails: 'ノード詳細',
  modelSettings: 'モデル設定',
  messageChain: 'メッセージ経路',
  actionsFor: name => `${name} の操作`,
  chats: 'チャット',
  chatScope: '表示範囲',
  thisAgent: 'このエージェント',
  all: 'すべて',
  chatList: 'チャット一覧',
  historyWindows: ['24時間以内', '7日以内', '30日以内', 'それ以前'],
  noChats: 'チャットはまだありません',
  chatHistory: 'チャット履歴',
  subAgentsWorking: n => `サブエージェント実行中 · ${n}`,
  workingInBackground: n => `バックグラウンド実行中 · ${n}`,
  more: n => `ほか ${n} 件`,
  sent: '送信済み',
  delivered: '配信済み',
  receipt: id => `受領 ${id}`,
  receiptUnknown: '受領不明',
  awaitingDelivery: '配信待ち',
  queuedNext: '待機中 · 次のステップで届きます',
  read: '既読',
  unread: '未読',
  failed: '失敗',
  trace: 'トレース',
  task: 'タスク',
  copyReply: '返信をコピー',
  stepsDone: n => `完了 · ${n} ステップ`,
  stepsRunning: n => `進行中 · ${n} ステップ`,
  details: '詳細',
  resent: '再送',
  activity: {
    thinking: '考え中',
    read: '読込',
    search: '検索',
    edit: '編集',
    run: '実行',
    fetch: '取得',
    computer: 'パソコンを操作',
    browser: 'ブラウザを操作',
    mail: 'メール',
    calendar: '予定',
    connectors: 'コネクタ',
    file: 'ファイル送信',
    generate: '生成',
    memory: '記憶',
    colon: '：',
    failed: '失敗',
  },
  agentInfo: 'エージェント情報',
  address: 'アドレス',
  node: 'ノード',
  status: '状態',
  chatChannel: 'チャット経路',
  connected: '接続済み',
  thisChat: 'このチャット',
  chatStats: (turns, started) => `${turns} ターン · ${started}に開始`,
  chat: 'チャット',
  roleAdmin: '管理者',
  roleView: '閲覧のみ',
  me: '自分',
  accountMenu: 'アカウントと外観',
  changeMyLook: '自分の見た目を変更',
  appearance: '外観',
  themeSystem: 'システム',
  themeLight: 'ライト',
  themeDark: 'ダーク',
  accent: 'テーマカラー',
  accentCustom: 'カスタム',
  accentNames: {
    ink: '墨',
    sage: '青磁',
    indigo: '藍',
    clay: '赭',
    plum: '紫',
    gold: '金',
  },
  accentCustomAria: 'カスタムテーマカラー',
  language: '言語 · Language',
  signOut: 'ログアウト',
  skipToBox: '入力欄へ移動',
  collapseSide: 'サイドバーを閉じる',
  expandSide: 'サイドバーを開く',
  closeSide: 'サイドバーを閉じる',
  search: '検索',
  jumpToLatest: '最新へ移動',
  message: 'メッセージ',
  placeholder: 'メッセージ',
  localCommands: 'ローカルコマンド',
  commands: 'コマンド',
  voiceInput: '音声入力',
  send: '送信',
  commandWords: {
    model: 'モデル切替',
    thinking: '思考の切替',
    effort: '推論レベル',
    compact: 'コンテキスト圧縮',
    context: 'コンテキスト使用量',
    autocompact: '自動圧縮のしきい値',
  },
  keyboardTitle: 'キーボードショートカット',
  keys: {
    send: '送信',
    newline: '改行',
    mainAgent: 'メインエージェント',
    search: '検索',
    side: 'サイドバーの開閉',
    panel: 'セッションパネル',
    close: 'メニューを閉じる',
    help: 'キーボードショートカット',
    quick: 'クイック入力',
    settings: '設定',
  },
  close: '閉じる',
  faces: '表示',
  faceChat: 'チャット',
  faceAgents: 'エージェント',
  modes: 'モード',
  work: 'Work',
  code: 'Code',
  settings: '設定',
  settingsSearch: '設定を検索',
  closeSettings: '設定を閉じる',
  skipToArea: '本文へ移動',
  desktopApp: 'デスクトップ版',
  newCodeSession: '新しいコードセッション',
  codeSessions: 'コードセッション',
  noCodeSessions: 'コードセッションはまだありません',
  codeInApp: 'Code は Qmo デスクトップ版で使えます',
  codeFirst: 'やることを入力',
  codeReply: '続けて入力',
  folder: 'フォルダ',
  agentWord: 'agent',
  rescan: '再検出',
  remoteLater: '今後のバージョンで対応',
  bypassLine: 'agent は確認なしであらゆるコマンドの実行と変更を行います',
  confirm: '確認',
  changes: '変更',
  refresh: '更新',
  noChatChannel: 'ここには会話チャネルがありません',
  noChatRole: 'この ID ではここで会話できません',
  recents: '最近のチャット',
  dayGroups: ['今日', '昨日', '過去 7 日間', 'それ以前'],
  noConversations: 'チャットはまだありません',
  otherChats: 'ほかの会話',
  readOnly: '閲覧のみ',
  backTo: name => `${name} に戻る`,
  greetings: ['おはようございます', 'こんにちは', 'こんばんは'],
  pickAgent: 'エージェントを選択',
  openInAgents: 'エージェント表示で開く',
  sessionActions: title => `${title} の操作`,
  offline: 'オフライン · 回復すると自動で再接続します',
  loading: '読み込み中',
  computerInUse: 'クラウド PC を使用中',
  quickEntry: 'クイック入力',
  switchAgent: 'エージェントを切り替え',
  model: 'モデル',
  modelAuto: '自動',
  modelAutoNote: 'ノードの設定に従う',
  effort: '推論の強さ',
  effortLevels: {
    inherit: '既定',
    off: 'オフ',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最大',
  },
  permission: '権限モード',
  permModes: {
    off: '手動で確認',
    'accept-edits': '編集を自動承認',
    auto: '自動承認',
    'full-access': '権限確認をスキップ',
  },
  permNotes: {
    off: '影響のある操作は毎回確認',
    'accept-edits':
      'ワークスペースの編集は実行 · コマンド ネット GitHub は確認',
    auto: 'サンドボックスのコマンド 編集 ネット読み取りは実行 · GitHub の書き込みは確認',
    'full-access': '確認しない · 禁止事項とクラウド PC の毎回確認はそのまま',
  },
  permDefaults: 'ノード既定の時間と回数 · 終わると手動で確認に戻る',
  bypassTitle: '権限確認をスキップしますか',
  bypassBody:
    'このエージェントはコマンド 編集 外部アクセスを確認なしで行います · 期限 回数切れ 取り消しまで有効',
  bypassConfirm: 'スキップする',
  cancel: 'キャンセル',
  sessionPanel: 'セッションパネル',
  closePanel: 'セッションパネルを閉じる',
  panelEmpty: 'バックグラウンドタスクがここに表示されます',
  backgroundTasks: 'バックグラウンドタスク',
  tasksRunning: n => `${n} 件実行中`,
  tasksWaiting: n => `${n} 件が対応待ち`,
  tasksDone: n => `${n} 件完了`,
  tasksEmpty: 'サブエージェントのタスクがここに表示されます',
  taskStatus: {
    scheduled: '予定済み',
    queued: '待機中',
    running: '実行中',
    interrupted: '失敗',
    completion_pending: '実行中',
    needs_input_pending: '実行中',
    needs_input: '対応待ち',
    completed: '完了',
    cancelled: '停止済み',
  },
  taskState: '状態',
  taskAsk: '依頼',
  taskResult: '結果',
  taskProgress: '進捗',
  taskError: '理由',
  openWorker: 'サブセッションを開く',
  stop: '停止',
  cloudComputer: 'クラウド PC',
  cloudComputerNote: 'ブラウザとコンピューターの切り替えと画面',
  ago: (at, now) => {
    const { unit, n, ahead } = gap(at, now)
    if (unit === 'now') return 'たった今'
    const words = { s: '秒', m: '分', h: '時間', d: '日' }[unit]
    return `${n}${words}${ahead ? '後' : '前'}`
  },
}

export const FRONT_TEXT: Readonly<Record<Lang, FrontText>> = {
  'zh-CN': ZH,
  en: EN,
  ja: JA,
}

const CLIENT: Readonly<Record<Lang, FrontClientText>> = {
  'zh-CN': {
    messageTo: '发消息给 ',
    unavailable: '暂不可对话',
    readOnly: '只读',
    opening: '正在打开会话',
    pickAgent: '先选一个智能体',
    noSession: '没能开出会话',
    sending: '发送中',
    queuedNext: '排队中 · 下一步时送达',
    switchedTo: '已切换为 ',
    notWired: '未接入 · 一直是人工确认',
    opsOnly: '只有运维能切换',
    defaultOn: '默认{mode} · 到期后自动再开',
    defaultHeld: '已手动关闭 · 不再自动开启默认档',
    stopping: '正在停止',
    stopped: '已停止',
    sent: '已发送',
    sentRetrying: '已发送 · 刷新失败 · 自动重试中',
    notDelivered: '未送达',
    retry: '重试',
    scanning: '正在检测',
    noLocalAgents: '这台电脑上没有找到 agent',
    agentReady: '可用',
    agentNotReady: '不可用',
    newReply: '收到新回复 · ',
    seeChat: '回到对话查看',
    polling: '轮询中',
    disconnected: '已断开',
    copied: '已复制',
    copyFailed: '复制失败',
    voiceUnavailable: '语音输入不可用',
    voiceLang: 'zh-CN',
  },
  en: {
    messageTo: 'Message ',
    unavailable: 'Chat unavailable',
    readOnly: 'Read only',
    opening: 'Opening the chat',
    pickAgent: 'Pick an agent first',
    noSession: "Couldn't open a chat",
    sending: 'Sending',
    queuedNext: 'Queued · goes in at the next step',
    switchedTo: 'Switched to ',
    notWired: 'Not connected · always Ask first',
    opsOnly: 'Only an operator can switch',
    defaultOn: 'Default: {mode} · reopens when it expires',
    defaultHeld: 'Turned off by hand · the default stays off',
    stopping: 'Stopping',
    stopped: 'Stopped',
    sent: 'Sent',
    sentRetrying: 'Sent · refresh failed · retrying',
    notDelivered: 'Not delivered',
    retry: 'Retry',
    scanning: 'Looking',
    noLocalAgents: 'No agents found on this computer',
    agentReady: 'Ready',
    agentNotReady: 'Not available',
    newReply: 'New reply · ',
    seeChat: 'see the chat',
    polling: 'Polling',
    disconnected: 'Disconnected',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    voiceUnavailable: 'Voice input unavailable',
    openFailed: "Couldn't open",
    sendFailed: 'Send failed',
    voiceLang: 'en-US',
  },
  ja: {
    messageTo: 'メッセージ：',
    unavailable: 'チャットできません',
    readOnly: '閲覧のみ',
    opening: 'チャットを開いています',
    pickAgent: '先にエージェントを選んでください',
    noSession: 'チャットを開けませんでした',
    sending: '送信中',
    queuedNext: '待機中 · 次のステップで届きます',
    switchedTo: '切り替えました：',
    notWired: '未接続 · 常に手動で確認',
    opsOnly: '切り替えは運用者のみ',
    defaultOn: '既定：{mode} · 期限が切れると再開',
    defaultHeld: '手動でオフ · 既定では開きません',
    stopping: '停止しています',
    stopped: '停止しました',
    sent: '送信済み',
    sentRetrying: '送信済み · 更新失敗 · 再試行中',
    notDelivered: '未送信',
    retry: '再試行',
    scanning: '検出中',
    noLocalAgents: 'このコンピュータに agent が見つかりません',
    agentReady: '利用可能',
    agentNotReady: '利用不可',
    newReply: '新しい返信 · ',
    seeChat: 'チャットを確認してください',
    polling: 'ポーリング中',
    disconnected: '切断されました',
    copied: 'コピーしました',
    copyFailed: 'コピーに失敗しました',
    voiceUnavailable: '音声入力は使えません',
    openFailed: '開けませんでした',
    sendFailed: '送信に失敗しました',
    voiceLang: 'ja-JP',
  },
}

/** What Code's page script says (`assets/codeClient.ts`, `codeRender.ts`). */
interface CodeClientText {
  readonly updateApp: string
  readonly pickFolder: string
  readonly noFolder: string
  readonly later: string
  readonly running: string
  readonly waiting: string
  readonly idle: string
  readonly interrupted: string
  readonly failed: string
  readonly queued: string
  readonly notSent: string
  readonly once: string
  readonly always: string
  readonly deny: string
  readonly note: string
  readonly allowed: string
  readonly allowedAll: string
  readonly denied: string
  /** A permission mode's answer: in effect now, or from the next turn. */
  readonly now: string
  readonly next: string
  readonly notGit: string
  readonly clean: string
  readonly binary: string
  readonly cut: string
  /** The runner went away; the shell starts it again. */
  readonly down: string
  /** A run of steps; `{n}` is how many, `{s}` the plural ending where there is one. */
  readonly done: string
  readonly doing: string
  readonly untitled: string
}

const CODE_CLIENT: Readonly<Record<Lang, CodeClientText>> = {
  'zh-CN': {
    updateApp: '更新桌面版后可开本机会话',
    pickFolder: '选择文件夹…',
    noFolder: '先选一个文件夹',
    later: '后续版本支持',
    running: '运行中',
    waiting: '等你确认',
    idle: '完成',
    interrupted: '已中断',
    failed: '失败',
    queued: '排队中',
    notSent: '未发出',
    once: '允许一次',
    always: '本会话都允许',
    deny: '拒绝',
    note: '附一句话（可不填）',
    allowed: '已允许',
    allowedAll: '本会话已允许',
    denied: '已拒绝',
    now: '已生效',
    next: '下一轮生效',
    notGit: '不是 Git 仓库，变更面板在后续版本补上',
    clean: '没有改动',
    binary: '二进制文件',
    cut: '只显示一部分',
    down: '运行器已停止 · 正在重启',
    done: '已执行 · {n} 步',
    doing: '进行中 · {n} 步',
    untitled: '新会话',
  },
  en: {
    updateApp: 'Update the desktop app to open local sessions',
    pickFolder: 'Choose a folder…',
    noFolder: 'Choose a folder first',
    later: 'In a later version',
    running: 'Running',
    waiting: 'Needs you',
    idle: 'Done',
    interrupted: 'Interrupted',
    failed: 'Failed',
    queued: 'Queued',
    notSent: 'Not sent',
    once: 'Allow once',
    always: 'Allow for this session',
    deny: 'Deny',
    note: 'Add a note (optional)',
    allowed: 'Allowed',
    allowedAll: 'Allowed for this session',
    denied: 'Denied',
    now: 'In effect',
    next: 'From the next turn',
    notGit: 'Not a Git repository · the changes panel comes in a later version',
    clean: 'No changes',
    binary: 'Binary file',
    cut: 'Showing part of it',
    down: 'Runner stopped · restarting',
    done: 'Done · {n} step{s}',
    doing: 'In progress · {n} step{s}',
    untitled: 'New session',
  },
  ja: {
    updateApp: 'デスクトップ版を更新するとローカルセッションを開けます',
    pickFolder: 'フォルダを選択…',
    noFolder: '先にフォルダを選んでください',
    later: '今後のバージョンで対応',
    running: '実行中',
    waiting: '確認待ち',
    idle: '完了',
    interrupted: '中断',
    failed: '失敗',
    queued: '待機中',
    notSent: '未送信',
    once: '今回だけ許可',
    always: 'このセッションでは許可',
    deny: '拒否',
    note: 'ひとこと添える（任意）',
    allowed: '許可しました',
    allowedAll: 'このセッションでは許可',
    denied: '拒否しました',
    now: '反映しました',
    next: '次のターンから反映',
    notGit: 'Git リポジトリではありません · 変更パネルは今後のバージョンで対応',
    clean: '変更はありません',
    binary: 'バイナリファイル',
    cut: '一部のみ表示',
    down: 'ランナーが停止しました · 再起動中',
    done: '完了 · {n} ステップ',
    doing: '進行中 · {n} ステップ',
    untitled: '新しいセッション',
  },
}

/**
 * Code's words, as JSON for its data attribute (`view/frontCode.ts`); the
 * front's own words (`#fx`) are read beside them. The few the server also
 * draws travel along.
 */
export function codeClientText(lang: Lang): string {
  const t = FRONT_TEXT[lang]
  return JSON.stringify({
    ...CODE_CLIENT[lang],
    none: t.noCodeSessions,
    folder: t.folder,
    thinking: t.activity.thinking,
    details: t.details,
    copy: t.copyReply,
  })
}

/**
 * The page script's words, as JSON for a data attribute. The greetings go
 * along: the server draws one by its own clock, the page redraws it by the
 * reader's (`assets/frontClient.ts`).
 */
export function frontClientText(lang: Lang): string {
  return JSON.stringify({
    ...CLIENT[lang],
    greetings: FRONT_TEXT[lang].greetings,
    switchAgent: FRONT_TEXT[lang].switchAgent,
  })
}
