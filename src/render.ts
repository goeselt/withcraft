import type { ActionInput, ActionMetadata, ActionOutput, RemoteActionInfo, UsesReference } from './types.js'

export const COPY_ACTION_REFERENCE_COMMAND = 'withcraft.copyActionReference'
export const REFRESH_METADATA_COMMAND = 'withcraft.refreshMetadata'

export function inputSummary(metadata: ActionMetadata): string {
  if (metadata.inputs.length === 0) return 'No declared inputs.'
  return metadata.inputs.slice().sort(compareInputs).map(formatInputSummary).join('\n')
}

export function outputSummary(metadata: ActionMetadata): string {
  if (metadata.outputs.length === 0) return 'No declared outputs.'
  return metadata.outputs.slice().sort(compareOutputs).map(formatOutputSummary).join('\n')
}

export function titleWithMetadata(metadata: ActionMetadata, fallbackTitle: string): string {
  const title = esc(metadata.name ?? fallbackTitle)
  const label = metadataLabel(metadata)
  const source =
    metadata.source.kind === 'remote'
      ? `([\`${codeEsc(label)}\`](${metadata.source.url}))`
      : `(\`${codeEsc(label)}\`)`
  return `**${title}** ${source} ${refreshMetadataLink()}`
}

// Command link rendered as a bare refresh icon next to the source-file link. Clicking it runs the same refresh as the
// footer link; VS Code dismisses the hover on command links, and the handler reopens it with freshly fetched data.
function refreshMetadataLink(): string {
  return `[$(refresh)](command:${REFRESH_METADATA_COMMAND} "Refresh metadata")`
}

export function actionVersionLines(metadata: ActionMetadata): string[] {
  if (metadata.source.kind !== 'remote' || !metadata.source.action) return []
  const { action } = metadata.source
  const lines = [`Current: ${pinnedActionLine(action, action.resolvedSha, action.commitUrl, currentPinInfo(action))}`]
  if (action.latest && !action.latest.isCurrent) {
    lines.push(`Latest: ${pinnedActionLine(action, action.latest.sha, action.latest.commitUrl, latestPinInfo(action))}`)
  }
  return lines
}

export function inputDocumentation(input: ActionInput): string {
  const lines: string[] = []
  if (input.description) lines.push(esc(input.description), '')
  lines.push(`Required: ${input.required ? 'yes' : 'no'}`)
  if (input.deprecationMessage) lines.push(`Deprecated: ${esc(input.deprecationMessage)}`)
  return lines.join('\n')
}

export function outputDocumentation(output: ActionOutput): string {
  return output.description ? esc(output.description) : ''
}

export function findInput(metadata: ActionMetadata, name: string): ActionInput | undefined {
  return metadata.inputs.find((input) => input.name === name)
}

export function referenceLabel(uses: UsesReference): string {
  return uses.raw
}

export function compareInputs(a: ActionInput, b: ActionInput): number {
  if (a.required !== b.required) return a.required ? -1 : 1
  return a.name.localeCompare(b.name)
}

export function compareOutputs(a: ActionOutput, b: ActionOutput): number {
  return a.name.localeCompare(b.name)
}

function formatInputSummary(input: ActionInput): string {
  const markers = [
    input.required ? 'required' : undefined,
    input.default ? `default: \`${codeEsc(input.default)}\`` : undefined,
    input.deprecationMessage ? 'deprecated' : undefined,
  ].filter(Boolean)
  const heading = `- **${codeEsc(input.name)}**${markers.length > 0 ? ` (${markers.join(', ')})` : ''}`
  return input.description ? `${heading}:  ${esc(input.description)}` : heading
}

function formatOutputSummary(output: ActionOutput): string {
  const heading = `- **${codeEsc(output.name)}**`
  return output.description ? `${heading}:  ${esc(output.description)}` : heading
}

function metadataLabel(metadata: ActionMetadata): string {
  if (metadata.source.kind === 'remote') return metadata.source.path.split('/').pop() ?? metadata.source.path
  return metadata.source.path.split(/[\\/]/).pop() ?? metadata.source.path
}

function pinnedActionLine(action: RemoteActionInfo, sha: string, shaUrl: string, info: PinInfo): string {
  const reference = plainActionReference(action, sha, info.label)
  const actionPart = action.repoUrl
    ? `[\`${codeEsc(action.fullName)}\`](${action.repoUrl})`
    : `\`${codeEsc(action.fullName)}\``
  const shaPart = `[\`${codeEsc(sha)}\`](${shaUrl})`
  const infoPart = info.url ? `[\`${codeEsc(info.label)}\`](${info.url})` : `\`${codeEsc(info.label)}\``
  return `${actionPart}@${shaPart} # ${infoPart} ${copyActionReferenceLink(reference)}`
}

interface PinInfo {
  label: string
  url: string | undefined
}

function currentPinInfo(action: RemoteActionInfo): PinInfo {
  return {
    label: action.pinInfo,
    url: action.pinInfoUrl,
  }
}

function latestPinInfo(action: RemoteActionInfo): PinInfo {
  return {
    label: action.latest?.name ?? 'latest',
    url: action.latest?.url,
  }
}

function plainActionReference(action: RemoteActionInfo, sha: string, info: string): string {
  return `${action.fullName}@${sha} # ${info}`
}

function copyActionReferenceLink(reference: string): string {
  const args = encodeURIComponent(JSON.stringify([reference]))
  return `[$(copy)](command:${COPY_ACTION_REFERENCE_COMMAND}?${args})`
}

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/([\\`*_[\]{}#+\-!|>~])/g, '\\$1')
}

export function codeEsc(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
}
