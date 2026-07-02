import { expect, test } from 'vitest'
import {
  actionVersionLines,
  COPY_ACTION_REFERENCE_COMMAND,
  esc,
  inputDocumentation,
  inputInsertText,
  inputSummary,
  outputSummary,
  REFRESH_METADATA_COMMAND,
  titleWithMetadata,
  undeclaredInputMessage,
} from './render.js'
import type { ActionMetadata } from './types.js'

function copyLink(reference: string): string {
  return `[$(copy)](command:${COPY_ACTION_REFERENCE_COMMAND}?${encodeURIComponent(JSON.stringify([reference]))})`
}

const metadata: ActionMetadata = {
  name: 'Setup Node.js environment',
  description:
    'Setup a Node.js environment by adding problem matchers and optionally downloading and adding it to the PATH.',
  inputs: [
    {
      name: 'cache-dependency-path',
      description:
        'Used to specify the path to a dependency file: package-lock.json, yarn.lock, etc. Supports wildcards or a list of file names for caching multiple dependencies.',
      required: false,
      default: undefined,
      deprecationMessage: undefined,
    },
    {
      name: 'check-latest',
      description:
        'Set this option if you want the action to check for the latest available version that satisfies the version spec.',
      required: false,
      default: 'false',
      deprecationMessage: undefined,
    },
  ],
  outputs: [],
  source: {
    kind: 'remote',
    host: 'github.com',
    owner: 'actions',
    repo: 'setup-node',
    path: 'action.yml',
    ref: 'v6',
    url: 'https://github.com/actions/setup-node/blob/v6/action.yml',
    action: {
      fullName: 'actions/setup-node',
      repoUrl: 'https://github.com/actions/setup-node',
      pinInfo: 'v6',
      pinInfoUrl: 'https://github.com/actions/setup-node/tree/v6',
      resolvedSha: 'a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
      commitUrl: 'https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
      version: 'v6.0.0',
      latest: {
        name: 'v6.0.0',
        url: 'https://github.com/actions/setup-node/tree/v6.0.0',
        sha: 'a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
        commitUrl: 'https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
        isCurrent: true,
      },
    },
  },
}

const refreshIcon = `[$(refresh)](command:${REFRESH_METADATA_COMMAND} "Refresh metadata")`

test('titleWithMetadata places the metadata link and a refresh icon next to the title', () => {
  expect(titleWithMetadata(metadata, 'actions/setup-node@v6')).toBe(
    `**Setup Node.js environment** ([\`action.yml\`](https://github.com/actions/setup-node/blob/v6/action.yml)) ${refreshIcon}`,
  )
})

test('titleWithMetadata links the local file and renders the refresh icon', () => {
  const local: ActionMetadata = {
    ...metadata,
    source: {
      kind: 'local',
      path: '/repo/.github/actions/build/action.yml',
      uri: 'file:///repo/.github/actions/build/action.yml',
    },
  }
  expect(titleWithMetadata(local, 'fallback')).toBe(
    `**Setup Node.js environment** ([\`action.yml\`](file:///repo/.github/actions/build/action.yml)) ${refreshIcon}`,
  )
})

test('actionVersionLines renders the canonical action reference', () => {
  expect(actionVersionLines(metadata)).toEqual([
    `Current: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`v6\`](https://github.com/actions/setup-node/tree/v6) ${copyLink(
        'actions/setup-node@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v6',
      )}`,
  ])
})

test('actionVersionLines labels branch references', () => {
  const branch = structuredClone(metadata)
  if (branch.source.kind !== 'remote' || !branch.source.action) throw new Error('expected remote metadata')
  branch.source.action.pinInfo = 'main'
  branch.source.action.pinInfoUrl = 'https://github.com/actions/setup-node/tree/main'
  branch.source.action.latest = undefined

  expect(actionVersionLines(branch)).toEqual([
    `Current: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`main\`](https://github.com/actions/setup-node/tree/main) ${copyLink(
        'actions/setup-node@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # main',
      )}`,
  ])
})

test('actionVersionLines labels SHA-pinned references', () => {
  const pinned = structuredClone(metadata)
  if (pinned.source.kind !== 'remote' || !pinned.source.action) throw new Error('expected remote metadata')
  pinned.source.action.pinInfo = 'sha pin'
  pinned.source.action.pinInfoUrl = pinned.source.action.commitUrl
  pinned.source.action.latest = undefined

  expect(actionVersionLines(pinned)).toEqual([
    `Current: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`sha pin\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32) ${copyLink(
        'actions/setup-node@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # sha pin',
      )}`,
  ])
})

test('actionVersionLines prefers inline pin comments as current info', () => {
  const pinned = structuredClone(metadata)
  if (pinned.source.kind !== 'remote' || !pinned.source.action) throw new Error('expected remote metadata')
  pinned.source.action.pinInfo = 'v6.0.0'
  pinned.source.action.pinInfoUrl = 'https://github.com/actions/setup-node/tree/v6.0.0'
  pinned.source.action.latest = undefined

  expect(actionVersionLines(pinned)).toEqual([
    `Current: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`v6.0.0\`](https://github.com/actions/setup-node/tree/v6.0.0) ${copyLink(
        'actions/setup-node@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v6.0.0',
      )}`,
  ])
})

test('actionVersionLines renders latest when the current ref is outdated', () => {
  const outdated = structuredClone(metadata)
  if (outdated.source.kind !== 'remote' || !outdated.source.action?.latest) throw new Error('expected remote metadata')
  outdated.source.action.latest = {
    name: 'v6.1.0',
    url: 'https://github.com/actions/setup-node/tree/v6.1.0',
    sha: 'bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
    commitUrl: 'https://github.com/actions/setup-node/commit/bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
    isCurrent: false,
  }

  expect(actionVersionLines(outdated)).toEqual([
    `Current: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`v6\`](https://github.com/actions/setup-node/tree/v6) ${copyLink(
        'actions/setup-node@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v6',
      )}`,
    `Latest: [` +
      `\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`v6.1.0\`](https://github.com/actions/setup-node/tree/v6.1.0) ${copyLink(
        'actions/setup-node@bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v6.1.0',
      )}`,
  ])
})

test('actionVersionLines renders reusable workflow references with current and latest', () => {
  const reusable: ActionMetadata = {
    name: 'Check Super Linter',
    description: undefined,
    inputs: [],
    outputs: [
      {
        name: 'report-url',
        description: 'URL of the generated report.',
      },
    ],
    source: {
      kind: 'remote',
      host: 'github.example.com',
      owner: 'example-org',
      repo: 'action-workflows',
      path: '.github/workflows/_check.super-linter.yml',
      ref: 'v1.0.23',
      url: 'https://github.example.com/example-org/action-workflows/blob/v1.0.23/.github/workflows/_check.super-linter.yml',
      action: {
        fullName: 'example-org/action-workflows/.github/workflows/_check.super-linter.yml',
        repoUrl: 'https://github.example.com/example-org/action-workflows',
        pinInfo: 'v1.0.23',
        pinInfoUrl: 'https://github.example.com/example-org/action-workflows/tree/v1.0.23',
        resolvedSha: 'df4cb1c069e1874edd31b4311f1884172cec0e10',
        commitUrl:
          'https://github.example.com/example-org/action-workflows/commit/df4cb1c069e1874edd31b4311f1884172cec0e10',
        version: 'v1.0.23',
        latest: {
          name: 'v1.0.24',
          url: 'https://github.example.com/example-org/action-workflows/tree/v1.0.24',
          sha: 'a81bbbf8298c0fa03ea29cdc473d45769f953675',
          commitUrl:
            'https://github.example.com/example-org/action-workflows/commit/a81bbbf8298c0fa03ea29cdc473d45769f953675',
          isCurrent: false,
        },
      },
    },
  }

  expect(actionVersionLines(reusable)).toEqual([
    `Current: [` +
      `\`example-org/action-workflows/.github/workflows/_check.super-linter.yml\`](https://github.example.com/example-org/action-workflows)` +
      `@[\`df4cb1c069e1874edd31b4311f1884172cec0e10\`](https://github.example.com/example-org/action-workflows/commit/df4cb1c069e1874edd31b4311f1884172cec0e10)` +
      ` # [\`v1.0.23\`](https://github.example.com/example-org/action-workflows/tree/v1.0.23) ${copyLink(
        'example-org/action-workflows/.github/workflows/_check.super-linter.yml@df4cb1c069e1874edd31b4311f1884172cec0e10 # v1.0.23',
      )}`,
    `Latest: [` +
      `\`example-org/action-workflows/.github/workflows/_check.super-linter.yml\`](https://github.example.com/example-org/action-workflows)` +
      `@[\`a81bbbf8298c0fa03ea29cdc473d45769f953675\`](https://github.example.com/example-org/action-workflows/commit/a81bbbf8298c0fa03ea29cdc473d45769f953675)` +
      ` # [\`v1.0.24\`](https://github.example.com/example-org/action-workflows/tree/v1.0.24) ${copyLink(
        'example-org/action-workflows/.github/workflows/_check.super-linter.yml@a81bbbf8298c0fa03ea29cdc473d45769f953675 # v1.0.24',
      )}`,
  ])
})

test('actionVersionLines marks an unresolved pinned SHA as not found and shows latest', () => {
  const fallback = structuredClone(metadata)
  if (fallback.source.kind !== 'remote' || !fallback.source.action) throw new Error('expected remote metadata')
  fallback.source.action.currentUnresolved = true
  fallback.source.action.resolvedSha = '01ceeba31f0d26eaaf8fbb4a60162001ee138d5c'
  fallback.source.action.latest = {
    name: 'v6.1.0',
    url: 'https://github.com/actions/setup-node/tree/v6.1.0',
    sha: 'bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
    commitUrl: 'https://github.com/actions/setup-node/commit/bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32',
    isCurrent: false,
  }

  expect(actionVersionLines(fallback)).toEqual([
    'Current: `actions/setup-node@01ceeba31f0d26eaaf8fbb4a60162001ee138d5c` — not found',
    `Latest: [\`actions/setup-node\`](https://github.com/actions/setup-node)` +
      `@[\`bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32\`](https://github.com/actions/setup-node/commit/bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32)` +
      ` # [\`v6.1.0\`](https://github.com/actions/setup-node/tree/v6.1.0) ${copyLink(
        'actions/setup-node@bbbbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v6.1.0',
      )}`,
  ])
})

test('inputSummary renders the compact input list', () => {
  expect(inputSummary(metadata)).toBe(
    '- **cache-dependency-path**:  Used to specify the path to a dependency file: package\\-lock.json, yarn.lock, etc. Supports wildcards or a list of file names for caching multiple dependencies.\n' +
      '- **check-latest** (default: `false`):  Set this option if you want the action to check for the latest available version that satisfies the version spec.',
  )
})

test('inputDocumentation includes the description for completion details', () => {
  expect(inputDocumentation(metadata.inputs[1])).toBe(
    'Set this option if you want the action to check for the latest available version that satisfies the version spec.\n' +
      '\n' +
      'Required: no',
  )
})

test('inputSummary marks deprecated inputs', () => {
  const withDeprecated: ActionMetadata = {
    ...metadata,
    inputs: [
      {
        name: 'old-token',
        description: 'Deprecated token input.',
        required: false,
        default: undefined,
        deprecationMessage: 'Use token instead.',
      },
    ],
  }
  expect(inputSummary(withDeprecated)).toBe('- **old-token** (deprecated):  Deprecated token input.')
})

test('esc does not escape parentheses in prose text', () => {
  expect(esc('Optional registry URL (https://npm.pkg.github.com/) for auth.')).toBe(
    'Optional registry URL (https://npm.pkg.github.com/) for auth.',
  )
})

test('esc escapes Markdown special characters other than parentheses', () => {
  expect(esc('a [b] *c* _d_ `e` \\f')).toBe('a \\[b\\] \\*c\\* \\_d\\_ \\`e\\` \\\\f')
})

test('copy links escape parentheses so a path cannot break out of the command link target', () => {
  const withParens = structuredClone(metadata)
  if (withParens.source.kind !== 'remote' || !withParens.source.action) throw new Error('expected remote metadata')
  withParens.source.action.fullName = 'actions/setup-node/docs(v2)'

  const [line] = actionVersionLines(withParens)
  const copySegment = line.slice(line.indexOf(`command:${COPY_ACTION_REFERENCE_COMMAND}?`))
  expect(copySegment).not.toContain('(')
  expect(copySegment.endsWith(')')).toBe(true) // only the closing Markdown link parenthesis remains
  expect(copySegment).toContain('docs%28v2%29') // parens arrive percent-encoded
})

test('inputInsertText places the default as an escaped snippet placeholder', () => {
  expect(
    inputInsertText({
      name: 'token',
      description: '',
      required: false,
      default: '${{ github.token }}',
      deprecationMessage: undefined,
    }),
  ).toBe('token: ${1:\\${{ github.token \\}\\}}')
})

test('inputInsertText uses a bare tab stop when there is no default', () => {
  expect(
    inputInsertText({
      name: 'node-version',
      description: '',
      required: true,
      default: undefined,
      deprecationMessage: undefined,
    }),
  ).toBe('node-version: $1')
})

test('undeclaredInputMessage names the input and warns', () => {
  expect(undeclaredInputMessage('node-versoin')).toBe(
    '$(warning) `node-versoin` is not a declared input of this action.',
  )
})

test('outputSummary renders the compact output list', () => {
  const withOutputs: ActionMetadata = {
    ...metadata,
    outputs: [
      {
        name: 'artifact-url',
        description: 'URL of the uploaded artifact.',
      },
      {
        name: 'digest',
        description: '',
      },
    ],
  }

  expect(outputSummary(withOutputs)).toBe('- **artifact-url**:  URL of the uploaded artifact.\n- **digest**')
})
