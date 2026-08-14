// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

export function residentOptionValue(
  args: readonly string[],
  index: number,
  name: string,
): { value: string; next: number } {
  const current = args[index]
  if (current?.startsWith(`${name}=`)) {
    return { value: current.slice(name.length + 1), next: index }
  }
  const next = args[index + 1]
  if (current !== name || next === undefined || next.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return { value: next, next: index + 1 }
}
