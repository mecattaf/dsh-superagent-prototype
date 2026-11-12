/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, DshdConfig, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
/** The dshd executor's configuration as the schema defaults it: no pairs yet. */
export const testDshd = (overrides: Partial<DshdConfig> = {}): DshdConfig => ({
  command: 'dshd', prefix: 'sa', pairs: {}, defaultPair: '', cwd: '', env: {},
  passEnv: ['HOME', 'USER', 'LOGNAME', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DSH_HOME'],
  args: ['--approval-policy', 'never'], watchSeconds: 30, briefArgvMaxChars: 64000, removeEnded: false, ...overrides,
})
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), engine: true, executor: 'dsh', dshd: testDshd(), ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
