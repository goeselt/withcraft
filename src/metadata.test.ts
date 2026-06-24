import { describe, expect, it } from 'vitest'
import { MAX_INPUTS, MAX_OUTPUTS, parseActionMetadata, parseReusableWorkflowMetadata } from './metadata.js'

const source = {
  kind: 'local' as const,
  path: '/workspace/action.yml',
  uri: 'file:///workspace/action.yml',
}

describe('parseActionMetadata', () => {
  it('normalizes declared inputs', () => {
    const metadata = parseActionMetadata(
      `
name: Demo Action
description: Does useful things
inputs:
  token:
    description: Access token
    required: true
  retries:
    description: Retry count
    default: 3
  old-name:
    deprecationMessage: Use token instead
outputs:
  artifact-url:
    description: URL of the uploaded artifact
`,
      source,
    )

    expect(metadata.name).toBe('Demo Action')
    expect(metadata.description).toBe('Does useful things')
    expect(metadata.inputs).toEqual([
      {
        name: 'token',
        description: 'Access token',
        required: true,
        default: undefined,
        deprecationMessage: undefined,
      },
      {
        name: 'retries',
        description: 'Retry count',
        required: false,
        default: '3',
        deprecationMessage: undefined,
      },
      {
        name: 'old-name',
        description: '',
        required: false,
        default: undefined,
        deprecationMessage: 'Use token instead',
      },
    ])
    expect(metadata.outputs).toEqual([
      {
        name: 'artifact-url',
        description: 'URL of the uploaded artifact',
      },
    ])
  })

  it('handles actions without declared inputs', () => {
    expect(parseActionMetadata('name: Empty', source).inputs).toEqual([])
    expect(parseActionMetadata('name: Empty', source).outputs).toEqual([])
  })
})

describe('parseReusableWorkflowMetadata', () => {
  it('parses workflow_call inputs', () => {
    const metadata = parseReusableWorkflowMetadata(
      `
name: Check Super-Linter
on:
  workflow_call:
    inputs:
      config-file:
        description: Path to the linter config
        required: true
        type: string
      fail-fast:
        description: Exit on first error
        required: false
        type: boolean
        default: 'false'
    outputs:
      digest:
        description: Build digest
        value: $\{{ jobs.build.outputs.digest }}
`,
      source,
    )

    expect(metadata.name).toBe('Check Super-Linter')
    expect(metadata.description).toBeUndefined()
    expect(metadata.inputs).toEqual([
      {
        name: 'config-file',
        description: 'Path to the linter config',
        required: true,
        default: undefined,
        deprecationMessage: undefined,
      },
      {
        name: 'fail-fast',
        description: 'Exit on first error',
        required: false,
        default: 'false',
        deprecationMessage: undefined,
      },
    ])
    expect(metadata.outputs).toEqual([
      {
        name: 'digest',
        description: 'Build digest',
      },
    ])
  })

  it('returns empty inputs when workflow_call has no inputs', () => {
    const metadata = parseReusableWorkflowMetadata(
      `
on:
  workflow_call:
`,
      source,
    )
    expect(metadata.inputs).toEqual([])
    expect(metadata.outputs).toEqual([])
  })

  it('returns empty inputs when workflow_call is absent', () => {
    expect(parseReusableWorkflowMetadata('on:\n  push:\n    branches: [main]', source).inputs).toEqual([])
    expect(parseReusableWorkflowMetadata('on:\n  push:\n    branches: [main]', source).outputs).toEqual([])
  })
})

describe('input/output count limits', () => {
  it('truncates inputs at MAX_INPUTS', () => {
    const many = Array.from({ length: MAX_INPUTS + 10 }, (_, i) => `  input-${i}:\n    description: d`).join('\n')
    const text = `name: Big\ninputs:\n${many}`
    const result = parseActionMetadata(text, source)
    expect(result.inputs).toHaveLength(MAX_INPUTS)
  })

  it('truncates outputs at MAX_OUTPUTS', () => {
    const many = Array.from({ length: MAX_OUTPUTS + 10 }, (_, i) => `  output-${i}:\n    description: d`).join('\n')
    const text = `name: Big\noutputs:\n${many}`
    const result = parseActionMetadata(text, source)
    expect(result.outputs).toHaveLength(MAX_OUTPUTS)
  })
})

describe('YAML robustness', () => {
  it('returns empty results for invalid YAML instead of throwing', () => {
    const result = parseActionMetadata('not: valid: yaml: :', source)
    expect(result.inputs).toEqual([])
    expect(result.outputs).toEqual([])
  })

  it('does not throw on documents that exceed the yaml alias limit', () => {
    // yaml v2 enforces maxAliasCount: 100 by default. 101 aliases records an error
    // in doc.errors instead of throwing; we produce empty inputs rather than crashing.
    const anchor = '&a {x: 1}'
    const aliases = Array.from({ length: 101 }, () => '*a').join('\n  - ')
    const text = `anchored: ${anchor}\nlist:\n  - ${aliases}`
    const result = parseActionMetadata(text, source)
    expect(result.inputs).toEqual([])
  })
})
