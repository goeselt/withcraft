import { describe, expect, it } from 'vitest'
import { envTokenForHost } from './token.js'

describe('envTokenForHost', () => {
  it('returns an environment token for the default github.com host', () => {
    expect(envTokenForHost('github.com', { GITHUB_TOKEN: 'ghp_secret' })).toBe('ghp_secret')
  })

  it('does not leak environment tokens to a non-default (workspace-configured) host', () => {
    const env = {
      WITHCRAFT_GITHUB_TOKEN: 'w_secret',
      GITHUB_TOKEN: 'gh_secret',
      GH_TOKEN: 'cli_secret',
    }
    expect(envTokenForHost('attacker.example.com', env)).toBeUndefined()
    expect(envTokenForHost('github.com@attacker.example.com', env)).toBeUndefined()
    expect(envTokenForHost('company.ghe.com', env)).toBeUndefined()
  })

  it('prefers WITHCRAFT_GITHUB_TOKEN, then GITHUB_TOKEN, then GH_TOKEN', () => {
    expect(
      envTokenForHost('github.com', {
        WITHCRAFT_GITHUB_TOKEN: 'first',
        GITHUB_TOKEN: 'second',
        GH_TOKEN: 'third',
      }),
    ).toBe('first')
    expect(envTokenForHost('github.com', { GITHUB_TOKEN: 'second', GH_TOKEN: 'third' })).toBe('second')
    expect(envTokenForHost('github.com', { GH_TOKEN: 'third' })).toBe('third')
  })

  it('trims whitespace and ignores blank values', () => {
    expect(envTokenForHost('github.com', { GITHUB_TOKEN: '  spaced  ' })).toBe('spaced')
    expect(envTokenForHost('github.com', { WITHCRAFT_GITHUB_TOKEN: '   ', GITHUB_TOKEN: 'real' })).toBe('real')
    expect(envTokenForHost('github.com', {})).toBeUndefined()
  })
})
