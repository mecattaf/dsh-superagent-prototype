import { spawn } from 'node:child_process'

export type CliExecResult = {
  code?: number
  exitCode?: number
  exit?: number
  stdout?: string
  stderr?: string
}

export type CliExec = (
  file: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<CliExecResult | string> | CliExecResult | string

export interface SchedCliOptions {
  path?: string
  exec?: CliExec
  timeoutMs?: number
}

export interface SchedCli {
  check(id: string, occ: string, attempt: number | string): Promise<{ holds: boolean; exit: number; output: any }>
  gate(id: string, occ: string, attempt: number | string): Promise<{ deferred: string | null }>
  show(id: string): Promise<any>
  env(id: string, occ: string, attempt: number | string): Promise<Record<string, string>>
}

const defaultExec: CliExec = (file, args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options?.timeout ?? 60_000,
      env: options?.env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

async function runCli(
  exec: CliExec,
  file: string,
  args: string[],
  timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await exec(file, args, { timeout })
    if (typeof res === 'string') {
      return { code: 0, stdout: res, stderr: '' }
    }
    const code = res?.code ?? res?.exitCode ?? res?.exit ?? 0
    const stdout = res?.stdout ?? ''
    const stderr = res?.stderr ?? ''
    return { code, stdout, stderr }
  } catch (err: any) {
    if (err && typeof err === 'object' && (typeof err.code === 'number' || typeof err.exitCode === 'number')) {
      return {
        code: err.code ?? err.exitCode ?? 1,
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
      }
    }
    throw err
  }
}

/**
 * Returns a CLI wrapper around the `scheduled` command.
 * Spawns `<path> check|gate <id> --occurrence <key> --attempt <n> --json` (60 s timeout, JSON stdout),
 * plus `show(id)` and `env(id, occ, attempt)` the same way.
 */
export function schedCli(
  pathOrOptions: string | SchedCliOptions = 'scheduled',
  execArg?: CliExec,
): SchedCli {
  let path = 'scheduled'
  let exec: CliExec = defaultExec
  let timeoutMs = 60_000

  if (typeof pathOrOptions === 'string') {
    path = pathOrOptions
    if (execArg) {
      exec = execArg
    }
  } else if (pathOrOptions && typeof pathOrOptions === 'object') {
    if (pathOrOptions.path) path = pathOrOptions.path
    if (pathOrOptions.exec) exec = pathOrOptions.exec
    else if (execArg) exec = execArg
    if (pathOrOptions.timeoutMs) timeoutMs = pathOrOptions.timeoutMs
  }

  return {
    async check(id: string, occ: string, attempt: number | string) {
      const args = ['check', id, '--occurrence', String(occ), '--attempt', String(attempt), '--json']
      const res = await runCli(exec, path, args, timeoutMs)

      let parsed: any = null
      const trimmed = res.stdout.trim()
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // Non-JSON stdout
        }
      }

      let holds: boolean
      if (parsed && typeof parsed === 'object' && typeof parsed.holds === 'boolean') {
        holds = parsed.holds
      } else if (parsed && typeof parsed === 'object' && typeof parsed.satisfied === 'boolean') {
        holds = parsed.satisfied
      } else {
        holds = res.code === 0
      }

      return {
        holds,
        exit: res.code,
        output: parsed !== null ? parsed : res.stdout,
      }
    },

    async gate(id: string, occ: string, attempt: number | string) {
      const args = ['gate', id, '--occurrence', String(occ), '--attempt', String(attempt), '--json']
      const res = await runCli(exec, path, args, timeoutMs)

      const trimmed = res.stdout.trim()
      if (res.code !== 0 && !trimmed) {
        throw new Error(`scheduled gate exited with code ${res.code}`)
      }

      let parsed: any = null
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          if (res.code !== 0) {
            throw new Error(`scheduled gate exited with code ${res.code}: ${res.stdout}`)
          }
        }
      }

      let deferred: string | null = null
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.deferred === 'string') {
          deferred = parsed.deferred
        } else if (parsed.deferred === null || parsed.deferred === false) {
          deferred = null
        } else if (parsed.deferred !== undefined) {
          deferred = String(parsed.deferred)
        } else if (typeof parsed.reason === 'string') {
          deferred = parsed.reason
        }
      } else if (typeof parsed === 'string' && parsed.trim().length > 0) {
        deferred = parsed.trim()
      }

      return { deferred }
    },

    async show(id: string) {
      const args = ['show', id, '--json']
      const res = await runCli(exec, path, args, timeoutMs)
      if (res.code !== 0) {
        throw new Error(`scheduled show exited with code ${res.code}: ${res.stderr || res.stdout}`)
      }
      return JSON.parse(res.stdout.trim())
    },

    async env(id: string, occ: string, attempt: number | string) {
      const args = ['env', id, '--occurrence', String(occ), '--attempt', String(attempt), '--json']
      const res = await runCli(exec, path, args, timeoutMs)
      if (res.code !== 0) {
        throw new Error(`scheduled env exited with code ${res.code}: ${res.stderr || res.stdout}`)
      }
      return JSON.parse(res.stdout.trim())
    },
  }
}
