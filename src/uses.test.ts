import { describe, expect, it } from 'vitest'
import { parseUsesValue } from './uses.js'

describe('parseUsesValue', () => {
  it('parses remote root actions', () => {
    expect(parseUsesValue('actions/checkout@v6')).toEqual({
      kind: 'remote-action',
      owner: 'actions',
      repo: 'checkout',
      path: '',
      ref: 'v6',
      pinInfo: undefined,
      raw: 'actions/checkout@v6',
    })
  })

  it('parses remote sub actions', () => {
    expect(parseUsesValue('github/codeql-action/upload-sarif@v4')).toMatchObject({
      kind: 'remote-action',
      owner: 'github',
      repo: 'codeql-action',
      path: 'upload-sarif',
      ref: 'v4',
    })
  })

  it('parses local actions without treating them as remote metadata', () => {
    expect(parseUsesValue('./.github/actions/build')).toEqual({
      kind: 'local-action',
      workspacePath: './.github/actions/build',
      raw: './.github/actions/build',
    })
  })

  it('classifies docker images and reusable workflows explicitly', () => {
    expect(parseUsesValue('docker://alpine:3')).toMatchObject({ kind: 'docker-image', image: 'alpine:3' })
    expect(parseUsesValue('owner/repo/.github/workflows/reuse.yml@main')).toMatchObject({
      kind: 'reusable-workflow',
      owner: 'owner',
      repo: 'repo',
      workflowPath: '.github/workflows/reuse.yml',
      ref: 'main',
    })
    expect(parseUsesValue('./.github/workflows/reuse.yml')).toMatchObject({
      kind: 'local-reusable-workflow',
      workspacePath: './.github/workflows/reuse.yml',
      raw: './.github/workflows/reuse.yml',
    })
  })

  it('parses SHA-pinned references', () => {
    expect(parseUsesValue('actions/checkout@a81bbbf8298c0fa03ea29cdc473d45769f953675')).toMatchObject({
      kind: 'remote-action',
      owner: 'actions',
      repo: 'checkout',
      ref: 'a81bbbf8298c0fa03ea29cdc473d45769f953675',
    })
  })

  it('parses branch refs with slashes', () => {
    expect(parseUsesValue('owner/repo@feature/my-branch')).toMatchObject({
      kind: 'remote-action',
      owner: 'owner',
      repo: 'repo',
      ref: 'feature/my-branch',
    })
  })

  it('ignores malformed remote references', () => {
    expect(parseUsesValue('actions/checkout')).toBeUndefined()
    expect(parseUsesValue('checkout@v6')).toBeUndefined()
  })
})
