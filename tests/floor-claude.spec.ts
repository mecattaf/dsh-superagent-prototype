/**
 * `bin/floor-claude` (DESIGN 9.3 seam S4, C7.3): Agency Web's subscription guard minus its `cwd == HOME` refusal, plus
 * `~/.claude/settings.local.json` when cwd is HOME. A fake Claude Code stands in for the seat.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SHIM = resolve(__dirname, '..', 'bin', 'floor-claude')
const SUBSCRIBED = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }
let home: string

function fake(auth: object | null): string {
  const path = join(home, 'claude')
  writeFileSync(path, `#!/bin/sh
if [ "$1 $2 $3" = "auth status --json" ]; then ${auth ? `printf '%s' '${JSON.stringify(auth)}'` : 'exit 1'}; exit 0; fi
echo "claude-ran $* cwd=$(pwd) entry=$CLAUDE_CODE_ENTRYPOINT key=\${ANTHROPIC_API_KEY:-none}"
`)
  chmodSync(path, 0o755)
  return path
}
function run(args: string[], auth: object | null = SUBSCRIBED, cwd = home) {
  const result = spawnSync(SHIM, args, { cwd, encoding: 'utf8', env: {
    PATH: process.env.PATH, HOME: home, USER: 'tester', FLOOR_PYTHON: 'python3', FLOOR_CLAUDE: fake(auth), ANTHROPIC_API_KEY: 'sk-test',
  } })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'floor-claude-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('floor-claude', () => {
  it('C7.3: runs Claude Code with cwd HOME (the master agency), scrubbed and as the SDK entrypoint', () => {
    const r = run(['-p', 'Reply OK', '--max-turns', '1'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`claude-ran -p Reply OK --max-turns 1 cwd=${home}`)
    expect(r.out).toContain('entry=sdk-ts key=none')
  })
  it('C7.3: refuses --bare and exits non-zero with the fixed message only', () => {
    const r = run(['--bare', '-p', 'x'])
    expect(r.code).toBe(2)
    expect(r.out).toBe('')
    expect(r.err).toMatch(/^floor-claude: subscription preflight failed/u)
  })
  it('checks ~/.claude/settings.local.json when cwd is HOME', () => {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: '/bin/key' }))
    expect(run(['-p', 'x']).code).toBe(2)
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x' } }))
    expect(run(['-p', 'x']).code).toBe(2)
    writeFileSync(join(home, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: [] } }))
    expect(run(['-p', 'x']).code).toBe(0)
  })
  it('refuses a seat that is not a first-party subscription login', () => {
    expect(run(['-p', 'x'], { ...SUBSCRIBED, apiProvider: 'bedrock' }).code).toBe(2)
    expect(run(['-p', 'x'], { ...SUBSCRIBED, authMethod: 'api-key' }).code).toBe(2)
    expect(run(['-p', 'x'], null).code).toBe(2)
  })
  it('--version needs no auth check', () => {
    expect(run(['--version'], null).out).toContain('claude-ran --version')
  })
})
