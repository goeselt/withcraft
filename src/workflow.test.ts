import { describe, expect, it } from 'vitest'
import {
  buildWorkflowIndex,
  inputNameAtOffset,
  isActionMetadataPath,
  isOffsetInWithBlock,
  isSupportedActionsPath,
  isWorkflowPath,
  stepOutputReferenceAtOffset,
  stepAtOffset,
} from './workflow.js'

describe('workflow index', () => {
  it('indexes action steps, uses ranges, and with input keys', () => {
    const text = `name: CI
on: push
jobs:
  test:
    steps:
      - id: setup
        uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: npm
      - uses: ./.github/actions/local
        with:
          mode: fast
`

    const steps = buildWorkflowIndex(text)
    expect(steps).toHaveLength(2)
    expect(steps[0].id).toBe('setup')
    expect(steps[0].uses).toMatchObject({ kind: 'remote-action', owner: 'actions', repo: 'setup-node' })
    expect(text.slice(steps[0].scopeRange.start, steps[0].scopeRange.end)).toContain('steps:')
    expect(steps[0].withInputs.get('node-version')).toBeDefined()
    expect(steps[1].uses).toMatchObject({ kind: 'local-action', workspacePath: './.github/actions/local' })

    const cacheOffset = text.indexOf('cache')
    const step = stepAtOffset(steps, cacheOffset)
    expect(step).toBe(steps[0])
    expect(inputNameAtOffset(steps[0], cacheOffset)).toBe('cache')
    expect(isOffsetInWithBlock(steps[0], text.indexOf('node-version'))).toBe(true)
  })

  it('isolates steps across multiple jobs', () => {
    const text = `jobs:
  job1:
    steps:
      - uses: actions/checkout@v4
        with:
          token: abc
  job2:
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 20
`
    const steps = buildWorkflowIndex(text)
    expect(steps).toHaveLength(2)

    const checkoutOffset = text.indexOf('actions/checkout')
    const setupNodeOffset = text.indexOf('actions/setup-node')
    const tokenOffset = text.indexOf('token')
    const nodeVersionOffset = text.indexOf('node-version')

    expect(stepAtOffset(steps, checkoutOffset)).toBe(steps[0])
    expect(stepAtOffset(steps, setupNodeOffset)).toBe(steps[1])
    expect(inputNameAtOffset(steps[0], tokenOffset)).toBe('token')
    expect(inputNameAtOffset(steps[1], nodeVersionOffset)).toBe('node-version')
    expect(inputNameAtOffset(steps[0], nodeVersionOffset)).toBeUndefined()
    expect(steps[0].scopeRange.end).toBeLessThanOrEqual(steps[1].scopeRange.start)
  })

  it('indexes uses entries even when name comes first in the step', () => {
    const text = `jobs:
  test:
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          token: abc
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(1)
    expect(steps[0].uses).toMatchObject({ kind: 'remote-action', owner: 'actions', repo: 'checkout' })
    expect(inputNameAtOffset(steps[0], text.indexOf('token'))).toBe('token')
  })

  it('does not index uses-looking text inside run block scalars', () => {
    const text = `jobs:
  test:
    steps:
      - run: |
          echo uses: owner/repo@v1
          uses: owner/repo@v1
      - uses: actions/checkout@v4
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(1)
    expect(steps[0].uses).toMatchObject({ kind: 'remote-action', owner: 'actions', repo: 'checkout' })
  })

  it('treats with.uses as an input name, not as a separate action step', () => {
    const text = `jobs:
  test:
    steps:
      - uses: actions/setup-node@v6
        with:
          uses: owner/repo@v1
          node-version: 24
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(1)
    expect(inputNameAtOffset(steps[0], text.indexOf('uses: owner'))).toBe('uses')
    expect(inputNameAtOffset(steps[0], text.indexOf('node-version'))).toBe('node-version')
  })

  it('indexes job-level reusable workflow uses entries', () => {
    const text = `jobs:
  call:
    uses: owner/repo/.github/workflows/reuse.yml@main
    with:
      mode: fast
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(1)
    expect(steps[0].uses).toMatchObject({
      kind: 'reusable-workflow',
      owner: 'owner',
      repo: 'repo',
      workflowPath: '.github/workflows/reuse.yml',
      ref: 'main',
    })
    expect(inputNameAtOffset(steps[0], text.indexOf('mode'))).toBe('mode')
  })

  it('indexes job-level local reusable workflow uses entries', () => {
    const text = `jobs:
  call:
    uses: ./.github/workflows/reuse.yml
    with:
      mode: fast
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(1)
    expect(steps[0].uses).toMatchObject({
      kind: 'local-reusable-workflow',
      workspacePath: './.github/workflows/reuse.yml',
      raw: './.github/workflows/reuse.yml',
    })
    expect(inputNameAtOffset(steps[0], text.indexOf('mode'))).toBe('mode')
  })

  it('indexes composite action runs steps from action metadata files', () => {
    const text = `name: My Composite Action
runs:
  using: composite
  steps:
    - uses: actions/setup-node@v6
      with:
        node-version: 24
    - uses: ./mysubaction/action.yml
      with:
        mode: fast
`

    const steps = buildWorkflowIndex(text)

    expect(steps).toHaveLength(2)
    expect(steps[0].uses).toMatchObject({ kind: 'remote-action', owner: 'actions', repo: 'setup-node' })
    expect(steps[1].uses).toMatchObject({
      kind: 'local-action',
      workspacePath: './mysubaction/action.yml',
    })
    expect(inputNameAtOffset(steps[0], text.indexOf('node-version'))).toBe('node-version')
    expect(inputNameAtOffset(steps[1], text.indexOf('mode'))).toBe('mode')
  })

  it('recognizes workflow file paths', () => {
    expect(isWorkflowPath('/repo/.github/workflows/ci.yml')).toBe(true)
    expect(isWorkflowPath('/repo/action.yml')).toBe(false)
  })

  it('recognizes supported GitHub Actions yaml paths', () => {
    expect(isActionMetadataPath('/repo/myrepo/mysubaction/action.yml')).toBe(true)
    expect(isActionMetadataPath('/repo/myrepo/mysubaction/action.yaml')).toBe(true)
    expect(isSupportedActionsPath('/repo/myrepo/mysubaction/action.yml')).toBe(true)
    expect(isSupportedActionsPath('/repo/.github/workflows/reuse.yml')).toBe(true)
    expect(isSupportedActionsPath('/repo/dependabot.yml')).toBe(false)
  })

  it('recognizes step output completion references', () => {
    const text = `jobs:
  test:
    steps:
      - id: build
        uses: owner/repo@v1
      - run: echo $\{{ steps.build.outputs.art }}
`
    const offset = text.indexOf('art') + 'art'.length

    expect(stepOutputReferenceAtOffset(text, offset)).toEqual({
      stepId: 'build',
      outputNameRange: {
        start: text.indexOf('art'),
        end: offset,
      },
    })
  })
})
