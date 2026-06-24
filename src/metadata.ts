import { isMap, isScalar, parseDocument, type YAMLMap } from 'yaml'
import type { ActionInput, ActionMetadata, ActionOutput, LocalMetadataSource, RemoteMetadataSource } from './types.js'

type MetadataSource = RemoteMetadataSource | LocalMetadataSource

// Hard caps on the number of declared inputs/outputs we parse. Legitimate
// actions rarely exceed a few dozen; these limits prevent a crafted action.yml
// with thousands of entries from causing UI lag or excessive memory use.
// (Remote files are already bounded by MAX_RESPONSE_BODY_BYTES; these caps
// cover local files which are read without a size limit.)
export const MAX_INPUTS = 200
export const MAX_OUTPUTS = 50

// yaml v2 parseDocument collects parse errors in doc.errors rather than throwing
// (strict: false default) and enforces maxAliasCount: 100 by default -- both are
// the behaviors we rely on. No explicit options are needed.

export function parseReusableWorkflowMetadata(text: string, source: MetadataSource): ActionMetadata {
  const doc = parseDocument(text)
  const root = doc.contents
  const name = scalarString(root && isMap(root) ? root.get('name', true) : undefined)
  const onNode = root && isMap(root) ? root.get('on', true) : undefined
  const workflowCallNode = onNode && isMap(onNode) ? onNode.get('workflow_call', true) : undefined
  const inputsNode = workflowCallNode && isMap(workflowCallNode) ? workflowCallNode.get('inputs', true) : undefined
  const outputsNode = workflowCallNode && isMap(workflowCallNode) ? workflowCallNode.get('outputs', true) : undefined

  return {
    name,
    description: undefined,
    inputs: isMap(inputsNode) ? parseInputs(inputsNode) : [],
    outputs: isMap(outputsNode) ? parseOutputs(outputsNode) : [],
    source,
  }
}

export function parseActionMetadata(text: string, source: MetadataSource): ActionMetadata {
  const doc = parseDocument(text)
  const root = doc.contents
  const name = scalarString(root && isMap(root) ? root.get('name', true) : undefined)
  const description = scalarString(root && isMap(root) ? root.get('description', true) : undefined)
  const inputsNode = root && isMap(root) ? root.get('inputs', true) : undefined
  const outputsNode = root && isMap(root) ? root.get('outputs', true) : undefined

  return {
    name,
    description,
    inputs: isMap(inputsNode) ? parseInputs(inputsNode) : [],
    outputs: isMap(outputsNode) ? parseOutputs(outputsNode) : [],
    source,
  }
}

function parseInputs(inputs: YAMLMap): ActionInput[] {
  const parsed: ActionInput[] = []
  for (const item of inputs.items.slice(0, MAX_INPUTS)) {
    const name = scalarString(item.key)
    if (!name) continue

    const { value } = item
    const description = isMap(value) ? scalarString(value.get('description', true)) : undefined
    const required = isMap(value) ? scalarString(value.get('required', true)) === 'true' : false
    const defaultValue = isMap(value) ? scalarString(value.get('default', true)) : undefined
    const deprecationMessage = isMap(value) ? scalarString(value.get('deprecationMessage', true)) : undefined

    parsed.push({
      name,
      description: description ?? '',
      required,
      default: defaultValue,
      deprecationMessage,
    })
  }
  return parsed
}

function parseOutputs(outputs: YAMLMap): ActionOutput[] {
  const parsed: ActionOutput[] = []
  for (const item of outputs.items.slice(0, MAX_OUTPUTS)) {
    const name = scalarString(item.key)
    if (!name) continue

    const { value } = item
    const description = isMap(value) ? scalarString(value.get('description', true)) : undefined

    parsed.push({
      name,
      description: description ?? '',
    })
  }
  return parsed
}

function scalarString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (isScalar(value)) return value.value === undefined || value.value === null ? undefined : String(value.value)
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}
