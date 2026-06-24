import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  clearRemoteCache,
  DEFAULT_REQUEST_TIMEOUT_MS,
  normalizeHost,
  resolveRemoteMetadata,
  resolveReusableWorkflowMetadata,
} from './github.js'
import { createOutputLogger, noopLogger, type LogLevel, type Logger } from './log.js'
import { resolveLocalMetadata, resolveLocalReusableWorkflowMetadata, type LocalFileSystem } from './local.js'
import { envTokenForHost } from './token.js'
import {
  compareInputs,
  compareOutputs,
  actionVersionLines,
  COPY_ACTION_REFERENCE_COMMAND,
  esc,
  findInput,
  inputDocumentation,
  inputSummary,
  outputDocumentation,
  outputSummary,
  referenceLabel,
  titleWithMetadata,
} from './render.js'
import type { ActionMetadata, UsesReference, WorkflowActionStep } from './types.js'
import {
  buildWorkflowIndex,
  inputNameAtOffset,
  isOffsetInWithBlock,
  isSupportedActionsPath,
  stepAtOffset,
  stepOutputReferenceAtOffset,
  type StepOutputReference,
} from './workflow.js'

// -- Constants ----------------------------------------------------------------

const TOKEN_SECRET_PREFIX = 'withcraft.githubToken.'
const REFRESH_METADATA_COMMAND = 'withcraft.refreshMetadata'
const SET_TOKEN_COMMAND = 'withcraft.setGitHubToken'
const GH_AUTH_TOKEN_TIMEOUT_MS = 5000

const execFileAsync = promisify(execFile)

// Node.js filesystem adapter passed to local resolvers. Defined once here so
// neither local-action nor local-reusable-workflow cases need their own literal.
const nodeFs: LocalFileSystem = {
  readFile: (filePath) => readFile(filePath, 'utf8'),
  pathExists: (filePath) =>
    access(filePath).then(
      () => true,
      () => false,
    ),
}

// -- Module-level state --------------------------------------------------------

// Workflow step index keyed by document URI + version. Cleared when a document
// is closed so stale parses don't accumulate.
const indexCache = new Map<string, { version: number; steps: WorkflowActionStep[] }>()

// gh CLI token cache. Keyed by host; `undefined` means "asked, got nothing".
const ghTokenCache = new Map<string, string | undefined>()
const ghTokenInFlight = new Map<string, Promise<string | undefined>>()

let logger: Logger = noopLogger

// -- Extension lifecycle -------------------------------------------------------

export function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Withcraft')
  logger = createOutputLogger(output, () =>
    vscode.workspace.getConfiguration('withcraft').get<LogLevel>('logging.level', 'info'),
  )
  const selector: vscode.DocumentSelector = [
    { language: 'yaml', scheme: 'file' },
    { language: 'github-actions-workflow', scheme: 'file' },
  ]

  ctx.subscriptions.push(
    output,
    vscode.workspace.onDidCloseTextDocument((doc) => indexCache.delete(doc.uri.toString())),
    vscode.languages.registerHoverProvider(selector, { provideHover: (doc, pos) => provideHover(ctx, doc, pos) }),
    vscode.languages.registerCompletionItemProvider(
      selector,
      { provideCompletionItems: (doc, pos) => provideCompletionItems(ctx, doc, pos) },
      ':',
      ' ',
      '.',
    ),
    vscode.commands.registerCommand('withcraft.clearCache', () => {
      clearRemoteCache()
      clearTokenCache()
      logger.info('cache.clear')
      void vscode.window.showInformationMessage('Withcraft cache cleared.')
    }),
    vscode.commands.registerCommand(SET_TOKEN_COMMAND, () => setGitHubToken(ctx)),
    vscode.commands.registerCommand('withcraft.removeGitHubToken', () => removeGitHubToken(ctx)),
    vscode.commands.registerCommand(REFRESH_METADATA_COMMAND, () => refreshMetadata()),
    vscode.commands.registerCommand(COPY_ACTION_REFERENCE_COMMAND, (reference: unknown) =>
      copyActionReference(reference),
    ),
    vscode.commands.registerCommand('withcraft.showOutput', () => output.show()),
  )

  logger.info('extension.activate')
}

export function deactivate() {
  clearRemoteCache()
  clearTokenCache()
  logger.info('extension.deactivate')
  logger = noopLogger
}

// -- Hover provider ------------------------------------------------------------

async function provideHover(
  ctx: vscode.ExtensionContext,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.Hover | undefined> {
  if (!enabled(document, 'hover.enabled')) return undefined
  if (!isSupportedActionsPath(document.uri.fsPath)) return undefined

  const offset = document.offsetAt(position)
  const steps = getCachedIndex(document)
  const step = stepAtOffset(steps, offset)
  if (!step) return undefined

  const metadata = await resolveStepMetadata(ctx, document, step, 'hover')
  if (!metadata) return unsupportedHover(step, offset)

  if (offset >= step.usesRange.start && offset <= step.usesRange.end) {
    const config = vscode.workspace.getConfiguration('withcraft', document.uri)
    if (!config.get<boolean>('hover.uses.enabled', true)) return undefined
    return new vscode.Hover(
      buildUsesHover(step.uses, metadata, {
        showInputs: config.get<boolean>('hover.inputs.enabled', true),
        showOutputs: config.get<boolean>('hover.outputs.enabled', true),
      }),
      toRange(document, step.usesRange.start, step.usesRange.end),
    )
  }

  const inputName = inputNameAtOffset(step, offset)
  if (!inputName) return undefined
  const input = findInput(metadata, inputName)
  if (!input) return undefined

  const range = step.withInputs.get(inputName)
  return new vscode.Hover(buildInputHover(input), range ? toRange(document, range.start, range.end) : undefined)
}

function buildUsesHover(
  uses: UsesReference,
  metadata: ActionMetadata,
  options: { showInputs: boolean; showOutputs: boolean },
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  configureHoverMarkdown(md)
  md.appendMarkdown(`${titleWithMetadata(metadata, referenceLabel(uses))}\n\n`)
  if (metadata.description) md.appendMarkdown(`${esc(metadata.description)}\n\n`)
  const actionLines = actionVersionLines(metadata)
  if (actionLines.length > 0) md.appendMarkdown(`${actionLines.join('  \n')}\n\n`)
  if (options.showInputs) md.appendMarkdown(`**Inputs:**\n\n${inputSummary(metadata)}`)
  if (options.showOutputs && metadata.outputs.length > 0) {
    if (options.showInputs) md.appendMarkdown('\n\n')
    md.appendMarkdown(`**Outputs:**\n\n${outputSummary(metadata)}`)
  }
  appendRefreshLink(md)
  return md
}

function buildInputHover(input: ActionMetadata['inputs'][number]): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  configureHoverMarkdown(md)
  md.appendMarkdown(`**${esc(input.name)}**${input.required ? ' (required)' : ''}\n\n`)
  if (input.description) md.appendMarkdown(`${esc(input.description)}\n\n`)
  if (input.default) md.appendMarkdown(`Default: \`${input.default.replace(/`/g, '\\`')}\`\n\n`)
  if (input.deprecationMessage) md.appendMarkdown(`Deprecated: ${esc(input.deprecationMessage)}`)
  appendRefreshLink(md)
  return md
}

function configureHoverMarkdown(md: vscode.MarkdownString) {
  md.supportHtml = false
  md.supportThemeIcons = true
  md.isTrusted = { enabledCommands: [REFRESH_METADATA_COMMAND, COPY_ACTION_REFERENCE_COMMAND] }
}

function appendRefreshLink(md: vscode.MarkdownString) {
  md.appendMarkdown(`\n\n[$(refresh) Refresh metadata](command:${REFRESH_METADATA_COMMAND})`)
}

async function copyActionReference(reference: unknown) {
  if (typeof reference !== 'string' || reference.length === 0) return
  await vscode.env.clipboard.writeText(reference)
  vscode.window.setStatusBarMessage('Withcraft action reference copied.', 2000)
}

function unsupportedHover(step: WorkflowActionStep, offset: number): vscode.Hover | undefined {
  if (offset < step.usesRange.start || offset > step.usesRange.end) return undefined
  return new vscode.Hover(unsupportedMessage(step.uses))
}

function unsupportedMessage(uses: UsesReference): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.supportThemeIcons = true
  switch (uses.kind) {
    case 'docker-image':
      md.appendMarkdown('$(info) Withcraft does not read inputs for Docker image actions.')
      return md
    case 'local-action':
    case 'local-reusable-workflow':
      md.appendMarkdown(
        '$(warning) Withcraft could not find an `action.yml`/`action.yaml` for this local reference. ' +
          'Check that the path is correct and points inside the repository.',
      )
      return md
    default:
      // Resolution can fail for several reasons; the most common actionable one
      // is a private repository without a configured token, so offer that path.
      md.isTrusted = { enabledCommands: [SET_TOKEN_COMMAND] }
      md.appendMarkdown(
        '$(warning) Withcraft could not resolve this action.\n\n' +
          'The repository may be private, the reference may not exist, or the request may have timed out. ' +
          `If it is private, [set a GitHub token](command:${SET_TOKEN_COMMAND}).`,
      )
      return md
  }
}

// -- Completion provider -------------------------------------------------------

async function provideCompletionItems(
  ctx: vscode.ExtensionContext,
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<vscode.CompletionItem[] | undefined> {
  if (!enabled(document, 'completion.enabled')) return undefined
  if (!isSupportedActionsPath(document.uri.fsPath)) return undefined

  const offset = document.offsetAt(position)
  const steps = getCachedIndex(document)
  const outputReference = stepOutputReferenceAtOffset(document.getText(), offset)
  if (outputReference) return outputCompletionItems(ctx, document, steps, outputReference, offset)

  const step = stepAtOffset(steps, offset)
  if (!step || !isOffsetInWithBlock(step, offset)) return undefined

  const metadata = await resolveStepMetadata(ctx, document, step, 'completion')
  if (!metadata) return undefined

  const existing = new Set(step.withInputs.keys())
  return metadata.inputs
    .filter((input) => !existing.has(input.name))
    .slice()
    .sort(compareInputs)
    .map((input) => {
      const item = new vscode.CompletionItem(input.name, vscode.CompletionItemKind.Property)
      item.detail = [
        input.required ? 'required' : undefined,
        input.default ? `default: ${input.default}` : undefined,
        input.deprecationMessage ? 'deprecated' : undefined,
      ]
        .filter(Boolean)
        .join(', ')
      const documentation = new vscode.MarkdownString(inputDocumentation(input), true)
      documentation.supportHtml = false
      documentation.isTrusted = false
      item.documentation = documentation
      item.insertText = new vscode.SnippetString(`${input.name}: ${input.default ? `\${1:${input.default}}` : '$1'}`)
      item.sortText = `${input.required ? '0' : '1'}-${input.name}`
      return item
    })
}

async function outputCompletionItems(
  ctx: vscode.ExtensionContext,
  document: vscode.TextDocument,
  steps: WorkflowActionStep[],
  outputReference: StepOutputReference,
  offset: number,
): Promise<vscode.CompletionItem[] | undefined> {
  const step = steps.find(
    (candidate) =>
      candidate.id === outputReference.stepId &&
      offset >= candidate.scopeRange.start &&
      offset <= candidate.scopeRange.end,
  )
  if (!step) return undefined

  const metadata = await resolveStepMetadata(ctx, document, step, 'completion')
  if (!metadata || metadata.outputs.length === 0) return undefined

  const range = toRange(document, outputReference.outputNameRange.start, outputReference.outputNameRange.end)
  return metadata.outputs
    .slice()
    .sort(compareOutputs)
    .map((output) => {
      const item = new vscode.CompletionItem(output.name, vscode.CompletionItemKind.Field)
      item.detail = `output from ${outputReference.stepId}`
      const documentation = new vscode.MarkdownString(outputDocumentation(output), true)
      documentation.supportHtml = false
      documentation.isTrusted = false
      item.documentation = documentation
      item.insertText = output.name
      item.range = range
      return item
    })
}

// -- Metadata resolution -------------------------------------------------------

function resolveStepMetadata(
  ctx: vscode.ExtensionContext,
  document: vscode.TextDocument,
  step: WorkflowActionStep,
  operation: 'hover' | 'completion',
): Promise<ActionMetadata | undefined> {
  switch (step.uses.kind) {
    case 'remote-action':
    case 'reusable-workflow': {
      const config = vscode.workspace.getConfiguration('withcraft', document.uri)
      const remoteOptions = {
        hosts: config.get<string[]>('githubHosts', []),
        maxEntries: config.get<number>('cache.maxEntries', 1000),
        requestTimeoutMs: config.get<number>('github.requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
        logger,
        operation,
        tokenForHost: (host: string) => tokenForHost(ctx, host),
      }
      return step.uses.kind === 'remote-action'
        ? resolveRemoteMetadata(step.uses, remoteOptions)
        : resolveReusableWorkflowMetadata(step.uses, remoteOptions)
    }
    case 'local-action': {
      const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
      return resolveLocalMetadata(step.uses, document.uri.fsPath, workspaceRoot, nodeFs)
    }
    case 'local-reusable-workflow': {
      const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
      return resolveLocalReusableWorkflowMetadata(step.uses, document.uri.fsPath, workspaceRoot, nodeFs)
    }
    case 'docker-image':
      return Promise.resolve<ActionMetadata | undefined>(void 0)
  }
}

function getCachedIndex(document: vscode.TextDocument): WorkflowActionStep[] {
  const key = document.uri.toString()
  const cached = indexCache.get(key)
  if (cached?.version === document.version) return cached.steps
  const steps = buildWorkflowIndex(document.getText())
  indexCache.set(key, { version: document.version, steps })
  return steps
}

// -- Command handlers ----------------------------------------------------------

async function setGitHubToken(ctx: vscode.ExtensionContext) {
  const host = await promptForHost('Withcraft: Set GitHub Token')
  if (!host) return

  const token = (
    await vscode.window.showInputBox({
      title: 'Withcraft: Set GitHub Token',
      prompt: `Token for ${host}`,
      placeHolder: 'GitHub personal access token',
      password: true,
    })
  )?.trim()
  if (!token) return

  await ctx.secrets.store(`${TOKEN_SECRET_PREFIX}${host}`, token)
  clearTokenCache()
  clearRemoteCache()
  void vscode.window.showInformationMessage(`Withcraft token stored for ${host}.`)
}

async function removeGitHubToken(ctx: vscode.ExtensionContext) {
  const host = await promptForHost('Withcraft: Remove GitHub Token')
  if (!host) return

  const existing = await ctx.secrets.get(`${TOKEN_SECRET_PREFIX}${host}`)
  if (!existing) {
    void vscode.window.showInformationMessage(`No Withcraft token is stored for ${host}.`)
    return
  }

  await ctx.secrets.delete(`${TOKEN_SECRET_PREFIX}${host}`)
  clearTokenCache()
  clearRemoteCache()
  void vscode.window.showInformationMessage(`Withcraft token removed for ${host}.`)
}

function refreshMetadata() {
  clearRemoteCache()

  const activeDocument = vscode.window.activeTextEditor?.document
  if (activeDocument) indexCache.delete(activeDocument.uri.toString())

  logger.info('cache.refresh')
  setTimeout(() => {
    void vscode.commands.executeCommand('editor.action.showHover')
  }, 100)
}

// Prompts for a GitHub host and returns its canonical form, validating input so
// a mistyped host (with scheme/casing/path) cannot be stored under a key that
// later lookups never match.
async function promptForHost(title: string): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    prompt: 'GitHub host',
    value: 'github.com',
    validateInput: (value) =>
      normalizeHost(value) ? undefined : 'Enter a valid GitHub host, e.g. github.com or github.example.com.',
  })
  if (input === undefined) return undefined
  return normalizeHost(input)
}

// -- Token management ----------------------------------------------------------

async function tokenForHost(ctx: vscode.ExtensionContext, host: string): Promise<string | undefined> {
  const stored = await ctx.secrets.get(`${TOKEN_SECRET_PREFIX}${host}`)
  if (stored?.trim()) return stored.trim()

  const envToken = envTokenForHost(host, process.env)
  if (envToken) return envToken

  return tokenFromGhCli(host)
}

// Caches the gh CLI result per host for the lifetime of the extension. The
// in-flight map prevents redundant concurrent subprocess calls.
function tokenFromGhCli(host: string): Promise<string | undefined> {
  if (ghTokenCache.has(host)) return Promise.resolve(ghTokenCache.get(host))

  const running = ghTokenInFlight.get(host)
  if (running) return running

  const load = loadTokenFromGhCli(host)
    .then((token) => {
      ghTokenCache.set(host, token)
      return token
    })
    .finally(() => ghTokenInFlight.delete(host))

  ghTokenInFlight.set(host, load)
  return load
}

async function loadTokenFromGhCli(host: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', host], {
      timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    })
    const token = stdout.trim()
    return token || undefined
  } catch {
    return undefined
  }
}

function clearTokenCache() {
  ghTokenCache.clear()
  ghTokenInFlight.clear()
}

// -- Helpers -------------------------------------------------------------------

function enabled(document: vscode.TextDocument, setting: 'hover.enabled' | 'completion.enabled'): boolean {
  const config = vscode.workspace.getConfiguration('withcraft', document.uri)
  return config.get<boolean>('enabled', true) && config.get<boolean>(setting, true)
}

function toRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end))
}
