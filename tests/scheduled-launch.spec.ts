import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderTask,
  writeTaskOnce,
  runEnv,
  runArgv,
  launchRun,
  REPORT_CONTRACT,
  ALLOWED_BASE_ENV_VARS,
  isForbiddenEnvVar,
  type ExecFunction,
} from '../src/scheduled/launch.ts'

describe('C5.7 renderTask & writeTaskOnce', () => {
  let tempDirs: string[] = []

  afterEach(() => {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs = []
  })

  it('renders task.md with fact brief, job prompt, and report contract verbatim', () => {
    const text = renderTask({
      spec: {
        id: 'master:fleet-nightly',
        revision: 'rev-abcdef',
        prompt: 'Check all cluster nodes and upgrade fleet dependencies.',
        schedule: '0 0 * * *',
        deadline: '2026-11-12T04:00:00Z',
        missed: 1,
      },
      occurrence: 'master:fleet-nightly@2026-11-12T00:00:00Z',
      attempt: 1,
      history: [{ state: 'done', summary: 'Previous nightly run passed cleanly.' }],
      diff: '--- a/workflow.jsonc\n+++ b/workflow.jsonc\n@@ -1,3 +1,3 @@',
      editedSince: 'rev-previous',
      check: 'check command exited 1 (not yet satisfied)',
      interrupted: 'power cut rebooted host during attempt',
    })

    // Fact brief items
    expect(text).toContain('# Fact Brief')
    expect(text).toContain('- Workflow: master:fleet-nightly')
    expect(text).toContain('- Revision: rev-abcdef')
    expect(text).toContain('- Edited since: rev-previous')
    expect(text).toContain('- Occurrence: master:fleet-nightly@2026-11-12T00:00:00Z')
    expect(text).toContain('- Schedule: 0 0 * * *')
    expect(text).toContain('- Missed count: 1')
    expect(text).toContain('- Attempt: 1')
    expect(text).toContain('- Deadline: 2026-11-12T04:00:00Z')
    expect(text).toContain('- Check result: check command exited 1 (not yet satisfied)')

    // History and diff
    expect(text).toContain('## Previous Reports')
    expect(text).toContain('Previous nightly run passed cleanly.')
    expect(text).toContain('## Edits Diff')
    expect(text).toContain('--- a/workflow.jsonc')

    // Interrupted line and unattended line
    expect(text).toContain('Interrupted: power cut rebooted host during attempt')
    expect(text).toContain('Unattended run: nobody can answer during this run.')

    // Job prompt
    expect(text).toContain('# Job Prompt')
    expect(text).toContain('Check all cluster nodes and upgrade fleet dependencies.')

    // Report contract verbatim from 7.5
    expect(text).toContain(REPORT_CONTRACT)
    expect(text.trim().endsWith(REPORT_CONTRACT.trim())).toBe(true)
  })

  it('omits interrupted line when not interrupted', () => {
    const text = renderTask({
      spec: { id: 'master:rollover', prompt: 'Run rollover.' },
      occurrence: 'master:rollover@2026-11-12T00:00:00Z',
      attempt: 1,
      interrupted: null,
    })
    expect(text).not.toContain('Interrupted:')
    expect(text).toContain('Unattended run:')
    expect(text).toContain(REPORT_CONTRACT)
  })

  it('writes task.md once and distinguishes written, same, and different', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-task-test-'))
    tempDirs.push(dir)
    const runDir = join(dir, 'sch-master-fleet-nightly-20261112t0000z')

    const contentA = 'Content version A\n' + REPORT_CONTRACT
    const contentB = 'Content version B\n' + REPORT_CONTRACT

    // 1. Initial write
    const res1 = writeTaskOnce(runDir, contentA)
    expect(res1).toBe('written')

    // Verify mode 0700 on dir and 0600 on file
    const dirStat = statSync(runDir)
    // Mode mask on unix: 0o777 & mode
    expect(dirStat.mode & 0o777).toBe(0o700)
    const fileStat = statSync(join(runDir, 'task.md'))
    expect(fileStat.mode & 0o777).toBe(0o600)
    expect(readFileSync(join(runDir, 'task.md'), 'utf-8')).toBe(contentA)

    // 2. Same content -> returns 'same'
    const res2 = writeTaskOnce(runDir, contentA)
    expect(res2).toBe('same')

    // 3. Different content -> returns 'different'
    const res3 = writeTaskOnce(runDir, contentB)
    expect(res3).toBe('different')
    // Existing file content was not overwritten
    expect(readFileSync(join(runDir, 'task.md'), 'utf-8')).toBe(contentA)
  })
})

describe('C5.8 runArgv', () => {
  it('builds deterministic argv matching 7.5 step 5 exactly', () => {
    const argv = runArgv({
      name: 'sch-master-fleet-nightly-20261112t0000z',
      root: '/home/tom',
      labels: {
        'scheduled.agency': '/home/tom',
        'scheduled.workflow': 'master:fleet-nightly',
        'scheduled.occurrence': '2026-11-12T00:00:00Z',
        'scheduled.attempt': '1',
        'scheduled.rev': 'rev-1',
      },
      mode: 'workspace-write',
      addDirs: ['/home/tom/reports', '/tmp/shared'],
    })

    expect(argv).toEqual([
      '/run/current-system/sw/bin/dshd',
      'run',
      '--bg',
      '--json',
      '--name',
      'sch-master-fleet-nightly-20261112t0000z',
      '--cwd',
      '/home/tom',
      '--label',
      'scheduled.agency=/home/tom',
      '--label',
      'scheduled.workflow=master:fleet-nightly',
      '--label',
      'scheduled.occurrence=2026-11-12T00:00:00Z',
      '--label',
      'scheduled.attempt=1',
      '--label',
      'scheduled.rev=rev-1',
      '--',
      'floor-worker',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '--add-dir',
      '/home/tom/reports',
      '--add-dir',
      '/tmp/shared',
      '--json',
      'Scheduled run sch-master-fleet-nightly-20261112t0000z. Read and follow /home/tom/.agency/runs/sch-master-fleet-nightly-20261112t0000z/task.md.',
    ])
  })

  it('defaults permission mode to workspace-write and omits --add-dir when empty', () => {
    const argv = runArgv({
      name: 'now-master-fix-20261112t0000z-abc123',
      root: '/home/tom',
      labels: {
        'scheduled.agency': '/home/tom',
        'scheduled.workflow': 'master:fix',
        'scheduled.occurrence': '2026-11-12T00:00:00Z',
        'scheduled.attempt': '1',
        'scheduled.rev': 'rev-2',
      },
    })

    expect(argv.includes('--add-dir')).toBe(false)
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'workspace-write',
    ])
  })
})

describe('C5.9 runEnv', () => {
  it('whitelists standard environment variables and excludes forbidden ones', () => {
    const base = {
      HOME: '/home/tom',
      USER: 'tom',
      LOGNAME: 'tom',
      LANG: 'en_GB.UTF-8',
      LOCALE_ARCHIVE: '/run/current-system/sw/lib/locale/locale-archive',
      TZDIR: '/etc/zoneinfo',
      PATH: '/bin:/usr/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      NIX_PATH: 'nixpkgs=/etc/nix/inputs',
      LOCAL_MODEL_ENDPOINT: 'http://127.0.0.1:11434',
      // Forbidden names present in base:
      DSH_TOKEN: 'secret-dsh-token',
      DSH_SUPERAGENT_ACCOUNT: 'mecattaf',
      CLAUDE_CODE_ENTRY: 'claude',
      CLAUDE_CODE_TOKEN: 'super-secret',
      GITHUB_TOKEN: 'ghp_secret',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      SOME_OTHER_TOKEN_VAR: 'val',
      UNWHITELISTED_SECRET: 'do-not-leak',
    }

    const sched = {
      SCHED_FLOOR_CLI: '/home/tom/bin/floor',
      SCHED_EXTRA: 'some-value',
      SCHED_LEAK_TOKEN: 'should-be-dropped',
    }

    const env = runEnv({
      base,
      sched,
      seatConfigDir: '/home/tom/.claude-seat-1',
    })

    // Whitelisted keys present
    expect(env.HOME).toBe('/home/tom')
    expect(env.USER).toBe('tom')
    expect(env.LOGNAME).toBe('tom')
    expect(env.LANG).toBe('en_GB.UTF-8')
    expect(env.LOCALE_ARCHIVE).toBe('/run/current-system/sw/lib/locale/locale-archive')
    expect(env.TZDIR).toBe('/etc/zoneinfo')
    expect(env.PATH).toBe('/bin:/usr/bin')
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    expect(env.NIX_PATH).toBe('nixpkgs=/etc/nix/inputs')
    expect(env.LOCAL_MODEL_ENDPOINT).toBe('http://127.0.0.1:11434')
    expect(env.SCHED_FLOOR_CLI).toBe('/home/tom/bin/floor')
    expect(env.SCHED_EXTRA).toBe('some-value')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/tom/.claude-seat-1')

    // Non-whitelisted keys dropped
    expect(env.UNWHITELISTED_SECRET).toBeUndefined()

    // Forbidden keys dropped completely
    for (const key of Object.keys(env)) {
      expect(isForbiddenEnvVar(key)).toBe(false)
      expect(key.startsWith('DSH_')).toBe(false)
      expect(key.startsWith('CLAUDE_CODE_')).toBe(false)
      expect(key.includes('TOKEN')).toBe(false)
      expect(key).not.toBe('SSH_AUTH_SOCK')
    }
  })

  it('omits CLAUDE_CONFIG_DIR when seatConfigDir is omitted or empty', () => {
    const env = runEnv({
      base: { HOME: '/home/tom' },
      sched: {},
    })
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('C5.10 launchRun: dshd outcomes', () => {
  const dummyArgv = ['/run/current-system/sw/bin/dshd', 'run', '--bg', '--json', '--name', 'test-run']
  const dummyEnv = { HOME: '/home/tom' }

  it('maps created (exit 0) to watch', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 0,
      stdout: JSON.stringify({ status: 'created', unit: 'dshd@test-run.service' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('watch')
    expect(res.detail).toBe('created')
  })

  it('maps started (exit 0) to watch', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 0,
      stdout: JSON.stringify({ status: 'started' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('watch')
    expect(res.detail).toBe('started')
  })

  it('maps already-running (exit 0) to watch', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 0,
      stdout: JSON.stringify({ status: 'already-running' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('watch')
    expect(res.detail).toBe('already-running')
  })

  it('maps task-already-ran (exit 4) to harvest', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 4,
      stdout: JSON.stringify({ error: 'task-already-ran', message: 'Task already completed' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('harvest')
    expect(res.detail).toBe('task-already-ran')
  })

  it('maps exists-different-recipe (exit 4) to held', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 4,
      stdout: JSON.stringify({ error: 'exists-different-recipe' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('held')
    expect(res.detail).toBe('exists-different-recipe')
  })

  it('maps unit-masked (exit 4) to held', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 4,
      stdout: JSON.stringify({ error: 'unit-masked' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('held')
    expect(res.detail).toBe('unit-masked')
  })

  it('maps invalid-name (exit 2) to held', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 2,
      stdout: JSON.stringify({ error: 'invalid-name' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('held')
    expect(res.detail).toBe('invalid-name')
  })

  it('maps start-failed (exit 1) to failed', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 1,
      stdout: JSON.stringify({ error: 'start-failed', journal: 'systemd failed to start' }),
    })
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('failed')
    expect(res.detail).toBe('start-failed')
  })

  it('maps exit 7 to retry (or throws when throwOnRetry: true)', async () => {
    const fakeExec: ExecFunction = async () => ({
      code: 7,
      stdout: JSON.stringify({ error: 'systemd-unavailable' }),
    })

    // Default: returns outcome 'retry'
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('retry')
    expect(res.detail).toBe('systemd-unavailable')

    // With throwOnRetry: throws
    await expect(
      launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec, throwOnRetry: true }),
    ).rejects.toThrow(/systemd-unavailable/)
  })

  it('handles exec rejection when child process exits non-zero', async () => {
    const fakeExec: ExecFunction = async () => {
      const err: any = new Error('Process exited')
      err.code = 4
      err.stdout = JSON.stringify({ status: 'task-already-ran' })
      throw err
    }
    const res = await launchRun({ argv: dummyArgv, env: dummyEnv, exec: fakeExec })
    expect(res.outcome).toBe('harvest')
  })
})

describe('launchRun on the output dshd 0.1.0 prints (captured 11 Nov)', () => {
  const run = (code: number, stdout: string) => launchRun({ argv: ['/bin/dshd', 'run'], env: {}, exec: async () => ({ code, stdout }) })
  it('reads a created instance as watch, and the error kinds of refusals', async () => {
    expect((await run(0, JSON.stringify({ outcome: 'created', name: 'x', state: 'running', result: 'success' }))).outcome).toBe('watch')
    expect((await run(4, JSON.stringify({ error: { kind: 'task-already-ran', message: 'already ran', hint: 'dshd start --rerun x' } }))).outcome).toBe('harvest')
    expect(await run(4, JSON.stringify({ error: { kind: 'exists-different-recipe', message: 'differs', hint: 'dshd rm x' } })))
      .toMatchObject({ outcome: 'held', detail: 'exists-different-recipe' })
    expect((await run(7, JSON.stringify({ error: { kind: 'systemd-unavailable', message: 'no bus' } }))).outcome).toBe('retry')
  })
})
