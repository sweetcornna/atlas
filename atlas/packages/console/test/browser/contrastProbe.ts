// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contrast measure the browser suites share (`contrast.browser.test.ts`,
 * `code.browser.test.ts`): every visible text node's computed colour,
 * composited over the stack of backgrounds behind it with every ancestor's
 * opacity applied, against WCAG AA — 4.5:1, 3:1 for large text. Text inside
 * a disabled control and text only a screen reader reads are exempt.
 */

/** One text that is under its threshold. */
export interface Shortfall {
  readonly text: string
  readonly where: string
  readonly ratio: number
  readonly need: number
  readonly fg: string
  readonly bg: string
}

export interface Probe {
  readonly total: number
  readonly short: readonly Shortfall[]
}

/** Contrast of every visible text node under `root`, against what is behind it. */
export function probe(root: string): string {
  return `(() => {
  function parse(c) {
    let m = c.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) {
      const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, under) {
    const a = top.a;
    return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
  }
  function lum(c) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function hex(c) {
    return '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
  function backdrop(el) {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let c = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (!c || c.a === 0) c = parse(getComputedStyle(document.body).backgroundColor);
    c = { r: c.r, g: c.g, b: c.b, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) {
      const b = parse(getComputedStyle(chain[i]).backgroundColor);
      if (b && b.a > 0) c = over(b, c);
    }
    return c;
  }
  function opacityOf(el) {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  }
  const scope = ${root};
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const short = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,template')) continue;
    const box = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (box.width <= 1 || box.height <= 1 || s.visibility === 'hidden') continue;
    if (el.closest('[hidden],dialog:not([open]),details:not([open]) > :not(summary)')) continue;
    if (el.closest(':disabled,[aria-disabled="true"]')) continue;
    if (opacityOf(el) === 0) continue;
    total += 1;
    const bg = backdrop(el);
    const ink = parse(s.color);
    if (!ink) continue;
    const fg = over({ ...over(ink, bg), a: opacityOf(el) }, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    if (ratio + 1e-9 < need) {
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
      short.push({ text: text.slice(0, 24), where: el.tagName.toLowerCase() + cls, ratio: Math.round(ratio * 100) / 100, need, fg: hex(fg), bg: hex(bg) });
    }
  }
  return { total, short };
})()`
}
