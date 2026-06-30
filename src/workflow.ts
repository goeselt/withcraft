import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { parseUsesValue } from './uses.js'
import type { OffsetRange, WorkflowActionStep } from './types.js'

export interface StepOutputReference {
  stepId: string
  outputNameRange: OffsetRange
}

export function isWorkflowPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (!/\.ya?ml$/i.test(normalized)) return false
  return /\/\.github\/workflows\/.+\.ya?ml$/i.test(normalized)
}

export function isActionMetadataPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /\/action\.ya?ml$/i.test(normalized)
}

export function isSupportedActionsPath(path: string): boolean {
  return isWorkflowPath(path) || isActionMetadataPath(path)
}

export function buildWorkflowIndex(text: string): WorkflowActionStep[] {
  const doc = parseDocument(text, { keepSourceTokens: true })
  const root = doc.contents
  if (!isMap(root)) return []

  const compositeSteps = compositeActionStepList(root)
  if (isSeq(compositeSteps)) {
    const steps: WorkflowActionStep[] = []
    pushActionSteps(compositeSteps, steps, nodeRange(root, true), text)
    return steps
  }

  const jobs = mapValue(root, 'jobs')
  if (!isMap(jobs)) return []

  const steps: WorkflowActionStep[] = []

  for (const job of jobs.items) {
    if (!isMap(job.value)) continue
    const jobRange = nodeRange(job.value, true)
    pushJobUses(job.value, steps, jobRange, text)

    const stepList = mapValue(job.value, 'steps')
    if (!isSeq(stepList)) continue
    pushActionSteps(stepList, steps, jobRange, text)
  }

  return steps
}

export function stepAtOffset(steps: WorkflowActionStep[], offset: number): WorkflowActionStep | undefined {
  return steps.find((step) => offset >= step.stepRange.start && offset <= step.stepRange.end)
}

export function inputNameAtOffset(step: WorkflowActionStep, offset: number): string | undefined {
  for (const [name, range] of step.withInputs) {
    if (offset >= range.start && offset <= range.end) return name
  }
  return undefined
}

export function isOffsetInWithBlock(step: WorkflowActionStep, offset: number): boolean {
  return step.withRange !== undefined && offset >= step.withRange.start && offset <= step.withRange.end
}

export function stepOutputReferenceAtOffset(text: string, offset: number): StepOutputReference | undefined {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const beforeCursor = text.slice(lineStart, offset)
  const match = /(?:^|[^A-Za-z0-9_-])steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.([A-Za-z0-9_-]*)?$/.exec(beforeCursor)
  if (!match) return undefined

  const outputPrefix = match[2] ?? ''
  return {
    stepId: match[1],
    outputNameRange: {
      start: offset - outputPrefix.length,
      end: offset,
    },
  }
}

function pushJobUses(job: YAMLMap, steps: WorkflowActionStep[], scopeRange: OffsetRange | undefined, text: string) {
  const usesStep = actionStepFromMap(job, scopeRange, text)
  if (usesStep?.uses.kind === 'reusable-workflow' || usesStep?.uses.kind === 'local-reusable-workflow') {
    steps.push(usesStep)
  }
}

function pushActionSteps(
  stepList: YAMLSeq,
  steps: WorkflowActionStep[],
  scopeRange: OffsetRange | undefined,
  text: string,
) {
  for (const item of stepList.items) {
    if (!isMap(item)) continue
    const step = actionStepFromMap(item, scopeRange, text)
    if (step) steps.push(step)
  }
}

function compositeActionStepList(root: YAMLMap): unknown {
  const runs = mapValue(root, 'runs')
  if (!isMap(runs)) return undefined
  return mapValue(runs, 'steps')
}

function actionStepFromMap(
  map: YAMLMap,
  scopeRange: OffsetRange | undefined,
  text: string,
): WorkflowActionStep | undefined {
  const usesPair = mapPair(map, 'uses')
  if (!usesPair) return undefined

  const usesValue = scalarString(usesPair.value)
  if (!usesValue) return undefined

  const usesRange = nodeRange(usesPair.value)
  const stepRange = nodeRange(map, true)
  const uses = withPinInfo(parseUsesValue(usesValue), usesRange ? inlineComment(text, usesRange) : undefined)
  if (!uses || !usesRange || !stepRange) return undefined

  const withInfo = parseWithMap(map)
  return {
    uses,
    id: scalarString(mapPair(map, 'id')?.value),
    stepRange,
    scopeRange: scopeRange ?? stepRange,
    usesRange,
    withRange: withInfo?.range,
    withInputs: withInfo?.inputs ?? new Map(),
  }
}

// Attaches the trailing `# ...` comment to remote refs so github.ts can match a SHA pin against its version comment.
// Only remote-action and reusable-workflow references carry pinInfo; local kinds are returned unchanged.
function withPinInfo(
  uses: ReturnType<typeof parseUsesValue>,
  pinInfo: string | undefined,
): ReturnType<typeof parseUsesValue> {
  if (!pinInfo || (uses?.kind !== 'remote-action' && uses?.kind !== 'reusable-workflow')) return uses
  return { ...uses, pinInfo }
}

// Extracts the `#` comment trailing a `uses:` value on the same line (e.g. the `# v1.2.3` after a SHA pin).
function inlineComment(text: string, valueRange: OffsetRange): string | undefined {
  const lineEndIndex = text.indexOf('\n', valueRange.end)
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex
  const suffix = text.slice(valueRange.end, lineEnd)
  const match = /(?:^|\s)(#.*)$/.exec(suffix)
  return match?.[1].trim() || undefined
}

function parseWithMap(map: YAMLMap): { range: OffsetRange; inputs: Map<string, OffsetRange> } | undefined {
  const withPair = mapPair(map, 'with')
  const withKeyRange = nodeRange(withPair?.key)
  if (!withPair || !withKeyRange) return undefined

  const inputs = new Map<string, OffsetRange>()
  if (isMap(withPair.value)) {
    for (const inputPair of withPair.value.items) {
      const name = scalarString(inputPair.key)
      const range = nodeRange(inputPair.key)
      if (name && range) inputs.set(name, range)
    }
  }

  return {
    range: {
      start: withKeyRange.start,
      end: nodeRange(withPair.value, true)?.end ?? withKeyRange.end,
    },
    inputs,
  }
}

function mapValue(map: YAMLMap, key: string): unknown {
  return mapPair(map, key)?.value
}

function mapPair(map: YAMLMap, key: string) {
  return map.items.find((item) => scalarString(item.key) === key)
}

function scalarString(value: unknown): string | undefined {
  if (isScalar(value)) return value.value === undefined || value.value === null ? undefined : String(value.value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function nodeRange(value: unknown, includeTrailing = false): OffsetRange | undefined {
  const range = (value as { range?: unknown } | undefined)?.range
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') return undefined
  const trailingEnd = includeTrailing && typeof range[2] === 'number' ? range[2] : range[1]
  return { start: range[0], end: trailingEnd }
}
