// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the shell's local pages share: the call into the shell, their words in
 * three languages, and the 阡陌 mark. The language is the system's, as the
 * shell read it (`local_state`), not the WebView's guess.
 */

/** A shell command; the local pages' are the `local_*` ones. */
export function invoke(command, args) {
  return window.__TAURI__.core.invoke(command, args)
}

const WORDS = {
  zh: {
    'signin.title': '登录阡陌',
    'signin.hub': '中枢地址',
    'signin.code': '配对码',
    'signin.hint': '配对码在中枢「连接 › 本机工具 › 添加设备」里拿',
    'signin.submit': '登录',
    'signin.busy': '正在登录…',
    'signin.entering': '正在进入…',
    'notice.revoked': '这台设备已被吊销，请重新登录',
    'notice.invalid': '这台设备需要重新配对',
    'notice.device_kind': '这台设备需要重新配对',
    'notice.signed_out': '已退出。中枢上的设备没能吊销，请在「连接」页处理',
    'error.usage': '地址以 https:// 开头；本机可用 http://127.0.0.1',
    'error.bad_code': '配对码不对或已过期',
    'error.unsupported': '这台中枢不支持设备配对',
    'error.throttled': '尝试太多，稍后再试',
    'error.network': '连不上中枢',
    'error.broken': '客户端组件出错',
    'error.signed_in': '这台电脑已经登录',
    'error.other': '登录失败',
    'offline.network': '连不上中枢',
    'offline.network.note': '网络恢复后自动重连',
    'offline.owner_inactive': '账号暂时不能用',
    'offline.owner_inactive.note': '账号可能已停用或正在重置，恢复后重试',
    'offline.loop': '中枢一直要求重新登录',
    'offline.loop.note': '这个账号可能没有对话权限',
    'offline.throttled': '尝试太多',
    'offline.throttled.note': '稍后再试',
    'offline.broken': '客户端组件出错',
    'offline.broken.note': '重新安装阡陌后再试',
    'offline.other': '进不了中枢',
    'offline.other.note': '稍后再试',
    'offline.retry': '重试',
    'offline.retrying': '正在重试…',
    'offline.next': '{n} 秒后重试',
    'offline.browser': '在浏览器中打开',
    'offline.signout': '退出登录',
    'settings.title': '设置',
    'settings.account': '账号',
    'settings.hub': '中枢',
    'settings.device': '设备',
    'settings.signout': '退出登录',
    'settings.signout.confirm': '再点一次退出',
    'settings.signout.note': '退出会吊销这台设备',
    'settings.quick': '快速输入',
    'settings.shortcut': '快捷键',
    'settings.shortcut.record': '按下组合键…',
    'settings.shortcut.reset': '恢复默认',
    'settings.shortcut.taken': '这个组合键已被占用',
    'settings.shortcut.invalid': '要带 Ctrl、Alt 或 ⌘',
    'settings.startup': '启动',
    'settings.autostart': '登录电脑时启动',
    'settings.background': '关闭窗口后留在后台',
    'settings.background.note': '在托盘里继续运行',
    'settings.about': '关于',
    'settings.version': '版本',
    'settings.code': 'Code',
    'settings.code.mode': '新会话的权限模式',
    'settings.code.off': '人工确认',
    'settings.code.accept-edits': '自动接受编辑',
    'settings.code.auto': '自动审批',
    'settings.code.full-access': '跳过权限确认',
    'settings.code.bypass': '跳过权限确认？',
    'settings.code.bypass.note': '新会话里执行命令、改文件都不再问你',
    'settings.code.bypass.ok': '跳过确认',
    'settings.code.cancel': '取消',
    'settings.code.remote': '新会话开 Remote',
    'settings.code.remote.closed': '还没开放',
    'settings.code.remote.unknown': '打开一次 Code 后可设',
    'about.name': '阡陌',
    'about.license': '以 AGPL-3.0-or-later 许可',
    none: '—',
  },
  en: {
    'signin.title': 'Sign in to Qmo',
    'signin.hub': 'Hub address',
    'signin.code': 'Pairing code',
    'signin.hint':
      'Get a pairing code on the hub: Connect › This computer › Add device',
    'signin.submit': 'Sign in',
    'signin.busy': 'Signing in…',
    'signin.entering': 'Opening…',
    'notice.revoked': 'This device was revoked. Sign in again.',
    'notice.invalid': 'This device needs to pair again.',
    'notice.device_kind': 'This device needs to pair again.',
    'notice.signed_out':
      'Signed out. The hub did not revoke this device; remove it on the Connect page.',
    'error.usage': 'Use https://, or http://127.0.0.1 for this computer',
    'error.bad_code': 'The pairing code is wrong or expired',
    'error.unsupported': 'This hub does not pair devices',
    'error.throttled': 'Too many attempts. Try again later',
    'error.network': 'Can’t reach the hub',
    'error.broken': 'The app’s client component failed',
    'error.signed_in': 'This computer is signed in already',
    'error.other': 'Sign-in failed',
    'offline.network': 'Can’t reach the hub',
    'offline.network.note': 'Reconnects when the network is back',
    'offline.owner_inactive': 'Account unavailable',
    'offline.owner_inactive.note':
      'The account may be suspended or being reset. Retry once it is back',
    'offline.loop': 'The hub keeps asking to sign in',
    'offline.loop.note': 'This account may not have access to conversations',
    'offline.throttled': 'Too many attempts',
    'offline.throttled.note': 'Try again later',
    'offline.broken': 'The app’s client component failed',
    'offline.broken.note': 'Reinstall Qmo and try again',
    'offline.other': 'Can’t open the hub',
    'offline.other.note': 'Try again later',
    'offline.retry': 'Retry',
    'offline.retrying': 'Retrying…',
    'offline.next': 'Retrying in {n} s',
    'offline.browser': 'Open in browser',
    'offline.signout': 'Sign out',
    'settings.title': 'Settings',
    'settings.account': 'Account',
    'settings.hub': 'Hub',
    'settings.device': 'Device',
    'settings.signout': 'Sign out',
    'settings.signout.confirm': 'Click again to sign out',
    'settings.signout.note': 'Signing out revokes this device',
    'settings.quick': 'Quick entry',
    'settings.shortcut': 'Shortcut',
    'settings.shortcut.record': 'Press keys…',
    'settings.shortcut.reset': 'Default',
    'settings.shortcut.taken': 'That shortcut is taken',
    'settings.shortcut.invalid': 'Include Ctrl, Alt or ⌘',
    'settings.startup': 'Startup',
    'settings.autostart': 'Open at login',
    'settings.background': 'Keep running when closed',
    'settings.background.note': 'Stays in the tray',
    'settings.about': 'About',
    'settings.version': 'Version',
    'settings.code': 'Code',
    'settings.code.mode': 'Permission mode for new sessions',
    'settings.code.off': 'Ask first',
    'settings.code.accept-edits': 'Accept edits',
    'settings.code.auto': 'Auto approve',
    'settings.code.full-access': 'Skip permissions',
    'settings.code.bypass': 'Skip permissions?',
    'settings.code.bypass.note':
      'New sessions run commands and edit files without asking',
    'settings.code.bypass.ok': 'Skip permissions',
    'settings.code.cancel': 'Cancel',
    'settings.code.remote': 'Remote for new sessions',
    'settings.code.remote.closed': 'Not available yet',
    'settings.code.remote.unknown': 'Open Code once to set this',
    'about.name': 'Qmo',
    'about.license': 'Licensed under AGPL-3.0-or-later',
    none: '—',
  },
  ja: {
    'signin.title': 'Qmo にサインイン',
    'signin.hub': 'ハブのアドレス',
    'signin.code': 'ペアリングコード',
    'signin.hint':
      'ペアリングコードはハブの「接続 › このコンピュータ › デバイスを追加」で取得',
    'signin.submit': 'サインイン',
    'signin.busy': 'サインインしています…',
    'signin.entering': '開いています…',
    'notice.revoked':
      'このデバイスは取り消されました。もう一度サインインしてください。',
    'notice.invalid': 'このデバイスはペアリングし直す必要があります。',
    'notice.device_kind': 'このデバイスはペアリングし直す必要があります。',
    'notice.signed_out':
      'サインアウトしました。ハブ側のデバイスは取り消せませんでした。「接続」ページで削除してください。',
    'error.usage':
      'https:// で始まるアドレス（このコンピュータは http://127.0.0.1 も可）',
    'error.bad_code': 'ペアリングコードが違うか期限切れです',
    'error.unsupported': 'このハブはデバイスのペアリングに対応していません',
    'error.throttled': '試行回数が多すぎます。しばらくしてから',
    'error.network': 'ハブに接続できません',
    'error.broken': 'クライアントコンポーネントのエラー',
    'error.signed_in': 'このコンピュータはサインイン済みです',
    'error.other': 'サインインできませんでした',
    'offline.network': 'ハブに接続できません',
    'offline.network.note': 'ネットワークが戻ると自動で再接続します',
    'offline.owner_inactive': 'アカウントを利用できません',
    'offline.owner_inactive.note':
      '停止中かリセット中の可能性があります。復旧後に再試行してください',
    'offline.loop': 'ハブがサインインを繰り返し求めています',
    'offline.loop.note': 'このアカウントには会話の権限がない可能性があります',
    'offline.throttled': '試行回数が多すぎます',
    'offline.throttled.note': 'しばらくしてから再試行してください',
    'offline.broken': 'クライアントコンポーネントのエラー',
    'offline.broken.note': 'Qmo を再インストールしてください',
    'offline.other': 'ハブを開けません',
    'offline.other.note': 'しばらくしてから再試行してください',
    'offline.retry': '再試行',
    'offline.retrying': '再試行しています…',
    'offline.next': '{n} 秒後に再試行',
    'offline.browser': 'ブラウザで開く',
    'offline.signout': 'サインアウト',
    'settings.title': '設定',
    'settings.account': 'アカウント',
    'settings.hub': 'ハブ',
    'settings.device': 'デバイス',
    'settings.signout': 'サインアウト',
    'settings.signout.confirm': 'もう一度クリックでサインアウト',
    'settings.signout.note': 'サインアウトするとこのデバイスは取り消されます',
    'settings.quick': 'クイック入力',
    'settings.shortcut': 'ショートカット',
    'settings.shortcut.record': 'キーを押してください…',
    'settings.shortcut.reset': 'デフォルト',
    'settings.shortcut.taken': 'そのショートカットは使用中です',
    'settings.shortcut.invalid': 'Ctrl、Alt または ⌘ を含めてください',
    'settings.startup': '起動',
    'settings.autostart': 'ログイン時に開く',
    'settings.background': '閉じても実行を続ける',
    'settings.background.note': 'トレイに残ります',
    'settings.about': '情報',
    'settings.version': 'バージョン',
    'settings.code': 'Code',
    'settings.code.mode': '新しいセッションの権限モード',
    'settings.code.off': '手動で確認',
    'settings.code.accept-edits': '編集を自動承認',
    'settings.code.auto': '自動承認',
    'settings.code.full-access': '権限確認をスキップ',
    'settings.code.bypass': '権限確認をスキップしますか',
    'settings.code.bypass.note':
      '新しいセッションはコマンドの実行もファイルの編集も確認しません',
    'settings.code.bypass.ok': 'スキップする',
    'settings.code.cancel': 'キャンセル',
    'settings.code.remote': '新しいセッションで Remote',
    'settings.code.remote.closed': 'まだ使えません',
    'settings.code.remote.unknown': '一度 Code を開くと設定できます',
    'about.name': 'Qmo',
    'about.license': 'AGPL-3.0-or-later ライセンス',
    none: '—',
  },
}

let words = WORDS.en

/** One string in the page's language; `{n}` and the like filled from `vars`. */
export function t(key, vars = {}) {
  const text = words[key] ?? WORDS.en[key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
}

/**
 * Set the language and the platform on the document, fill every
 * `[data-i18n]` element, and show the page.
 */
export function ready(state) {
  const lang = WORDS[state.lang] ? state.lang : 'en'
  words = WORDS[lang]
  document.documentElement.lang =
    lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : 'en'
  document.documentElement.dataset.platform = state.platform
  for (const el of document.querySelectorAll('[data-i18n]'))
    el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-placeholder]'))
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder))
  if (document.title === '') document.title = t('about.name')
  document.body.classList.remove('loading')
}

/** The 阡陌 mark (console view/mark.ts), `height` px tall. */
export function mark(height) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('class', 'qm-mark')
  svg.setAttribute('viewBox', '0 0 853 920')
  svg.setAttribute('height', String(height))
  svg.setAttribute('width', String(Math.round((height * 853) / 920)))
  svg.setAttribute('aria-hidden', 'true')
  const group = document.createElementNS(ns, 'g')
  group.setAttribute('transform', 'matrix(1 0 0 -1 0 920)')
  for (const [cls, fill, d] of [
    ['qm-ink', '#222623', INK_PATH],
    ['qm-field', '#5e866c', FIELD_PATH],
  ]) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('class', cls)
    path.setAttribute('fill', fill)
    path.setAttribute('d', d)
    group.appendChild(path)
  }
  svg.appendChild(group)
  return svg
}

/** Esc closes a small window (settings, about). */
export function closeOnEscape() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') invoke('local_close').catch(() => {})
  })
}

const INK_PATH =
  'M100 916 c-43 -3 -74 -24 -89 -61 -10 -21 -11 -35 -11 -100 0 -60 1 -63 10 -72 7 -7 12 -9 59 ' +
  '-19 76 -17 94 -23 143 -55 39 -24 63 -35 99 -44 20 -6 27 -7 30 -5 4 3 3 6 -6 18 -46 60 -42 ' +
  '118 12 184 4 6 26 28 47 49 46 46 51 52 51 66 0 20 -20 31 -62 34 -36 3 -262 7 -283 5z M11 653 ' +
  'c-5 -1 -9 -5 -10 -10 -1 -7 -1 -506 1 -517 6 -49 30 -87 44 -71 4 4 6 8 10 31 17 78 51 140 107 ' +
  '197 34 33 64 56 121 91 40 25 46 29 58 37 14 10 34 30 39 39 17 28 10 68 -13 83 -6 4 -12 6 -25 ' +
  '8 -49 6 -94 22 -131 45 -8 4 -19 11 -25 15 -42 25 -80 38 -156 52 -17 2 -15 2 -20 0z M280 256 ' +
  'c-5 -2 -9 -4 -18 -13 -36 -37 -71 -95 -82 -137 -4 -17 -4 -43 0 -56 9 -25 28 -40 61 -46 10 -2 ' +
  '12 -2 205 -3 205 -1 239 0 257 2 38 6 67 20 74 36 7 17 -8 42 -43 73 -53 48 -111 77 -179 90 ' +
  '-17 4 -30 6 -86 14 -67 9 -101 16 -149 32 -28 9 -33 10 -40 8z'

const FIELD_PATH =
  'M692 918 c-129 -3 -154 -13 -222 -84 -75 -77 -100 -120 -100 -167 0 -31 12 -53 44 -87 26 -25 ' +
  '26 -25 44 -10 69 56 115 77 220 99 89 19 150 42 165 64 8 10 8 11 9 54 0 23 0 41 -1 46 -6 47 ' +
  '-33 75 -79 84 -12 2 -41 2 -80 1z M827 698 c-42 -20 -84 -34 -152 -49 -68 -15 -105 -28 -144 ' +
  '-50 -31 -18 -71 -50 -71 -58 0 -3 0 -3 11 -18 21 -27 25 -53 14 -81 -5 -12 -12 -21 -28 -37 -21 ' +
  '-20 -21 -21 14 -24 118 -14 224 2 311 47 44 22 65 40 69 60 2 9 1 205 -1 209 -4 8 -9 8 -23 1z ' +
  'M837 438 c-2 -1 -11 -6 -20 -12 -95 -57 -212 -80 -338 -67 -10 1 -25 3 -34 4 -32 3 -45 -1 -80 ' +
  '-27 -18 -14 -30 -24 -46 -39 -19 -19 -19 -21 3 -29 43 -16 87 -25 169 -36 63 -8 89 -13 121 -23 ' +
  '68 -21 134 -66 177 -122 12 -15 16 -18 25 -18 17 0 28 17 36 53 2 12 3 305 0 310 -2 6 -7 8 -13 ' +
  '6z'
