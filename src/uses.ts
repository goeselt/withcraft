import type { UsesReference } from './types.js'

export function parseUsesValue(rawValue: string): UsesReference | undefined {
  const raw = unquote(rawValue.trim())
  if (!raw) return undefined

  if (raw.startsWith('docker://')) {
    return { kind: 'docker-image', image: raw.slice('docker://'.length), raw }
  }

  if (raw.startsWith('./') || raw.startsWith('../')) {
    if (isReusableWorkflowPath(raw)) {
      return { kind: 'local-reusable-workflow', workspacePath: raw, raw }
    }
    return { kind: 'local-action', workspacePath: raw, raw }
  }

  const at = raw.lastIndexOf('@')
  if (at <= 0 || at === raw.length - 1) return undefined

  const actionPath = raw.slice(0, at)
  const ref = raw.slice(at + 1)
  const parts = actionPath.split('/')
  if (parts.length < 2) return undefined

  const owner = parts[0]
  const repo = parts[1]
  const path = parts.slice(2).join('/')

  if (isReusableWorkflowPath(path)) {
    return { kind: 'reusable-workflow', owner, repo, workflowPath: path, ref, raw }
  }

  return { kind: 'remote-action', owner, repo, path, ref, raw }
}

function isReusableWorkflowPath(path: string): boolean {
  const normalized = path.replace(/^\.\//, '').replace(/^\.\.\//, '')
  return /^\.github\/workflows\/.+\.ya?ml$/i.test(normalized)
}

function unquote(value: string): string {
  const first = value.at(0)
  const last = value.at(-1)
  if ((first === '"' || first === "'") && first === last) return value.slice(1, -1)
  return value
}
