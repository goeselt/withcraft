import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveLocalMetadata, resolveLocalReusableWorkflowMetadata, type LocalFileSystem } from './local.js'

const nodeFs: LocalFileSystem = {
  readFile: (path) => import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')),
  pathExists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
}

describe('resolveLocalMetadata', () => {
  it('reads local action metadata relative to the workspace root without cache state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const actionDir = join(root, '.github/actions/local')
      await mkdir(actionDir, { recursive: true })
      await writeFile(
        join(actionDir, 'action.yml'),
        `name: Local Action
inputs:
  mode:
    description: Execution mode
`,
      )

      const metadata = await resolveLocalMetadata(
        { kind: 'local-action', workspacePath: './.github/actions/local', raw: './.github/actions/local' },
        join(root, '.github/workflows/ci.yml'),
        root,
        nodeFs,
      )

      expect(metadata?.name).toBe('Local Action')
      expect(metadata?.inputs[0]?.name).toBe('mode')
      expect(metadata?.source.kind).toBe('local')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads local reusable workflow metadata from workflow_call inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const workflowDir = join(root, '.github/workflows')
      await mkdir(workflowDir, { recursive: true })
      await writeFile(
        join(workflowDir, 'reuse.yml'),
        `name: Reuse CI
on:
  workflow_call:
    inputs:
      mode:
        description: Execution mode
        required: true
        default: fast
`,
      )

      const metadata = await resolveLocalReusableWorkflowMetadata(
        {
          kind: 'local-reusable-workflow',
          workspacePath: './.github/workflows/reuse.yml',
          raw: './.github/workflows/reuse.yml',
        },
        join(root, '.github/workflows/ci.yml'),
        root,
        nodeFs,
      )

      expect(metadata?.name).toBe('Reuse CI')
      expect(metadata?.inputs[0]?.name).toBe('mode')
      expect(metadata?.inputs[0]?.required).toBe(true)
      expect(metadata?.source.kind).toBe('local')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves repo-relative action paths against the git root, not a parent workspace folder', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const repoRoot = join(workspaceRoot, 'project/myrepo')
      await mkdir(join(repoRoot, '.git'), { recursive: true })
      const actionDir = join(repoRoot, 'myaction')
      await mkdir(actionDir, { recursive: true })
      await writeFile(join(actionDir, 'action.yml'), 'name: My Action\n')

      const metadata = await resolveLocalMetadata(
        { kind: 'local-action', workspacePath: './myaction', raw: './myaction' },
        join(repoRoot, '.github/workflows/check-pr.yml'),
        workspaceRoot,
        nodeFs,
      )

      expect(metadata?.name).toBe('My Action')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('refuses to read an action.yml outside the repository root via ../ traversal', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const repoRoot = join(workspaceRoot, 'repo')
      await mkdir(join(repoRoot, '.git'), { recursive: true })
      // A real action.yml that lives OUTSIDE the repo root.
      const outsideDir = join(workspaceRoot, 'secret')
      await mkdir(outsideDir, { recursive: true })
      await writeFile(join(outsideDir, 'action.yml'), 'name: Secret Action\n')

      const metadata = await resolveLocalMetadata(
        { kind: 'local-action', workspacePath: '../secret', raw: '../secret' },
        join(repoRoot, '.github/workflows/ci.yml'),
        workspaceRoot,
        nodeFs,
      )

      expect(metadata).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('refuses to read a reusable workflow outside the repository root via ../ traversal', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const repoRoot = join(workspaceRoot, 'repo')
      await mkdir(join(repoRoot, '.git'), { recursive: true })
      const outsideDir = join(workspaceRoot, '.github/workflows')
      await mkdir(outsideDir, { recursive: true })
      await writeFile(join(outsideDir, 'secret.yml'), 'name: Secret\non:\n  workflow_call:\n')

      const metadata = await resolveLocalReusableWorkflowMetadata(
        {
          kind: 'local-reusable-workflow',
          workspacePath: '../.github/workflows/secret.yml',
          raw: '../.github/workflows/secret.yml',
        },
        join(repoRoot, '.github/workflows/ci.yml'),
        workspaceRoot,
        nodeFs,
      )

      expect(metadata).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('falls back to the workspace root when no git repository is found', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'withcraft-'))
    try {
      const actionDir = join(workspaceRoot, 'myaction')
      await mkdir(actionDir, { recursive: true })
      await writeFile(join(actionDir, 'action.yml'), 'name: My Action\n')

      const metadata = await resolveLocalMetadata(
        { kind: 'local-action', workspacePath: './myaction', raw: './myaction' },
        join(workspaceRoot, '.github/workflows/check-pr.yml'),
        workspaceRoot,
        nodeFs,
      )

      expect(metadata?.name).toBe('My Action')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
