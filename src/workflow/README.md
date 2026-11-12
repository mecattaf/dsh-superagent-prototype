# `src/workflow`: the workflow interpreter, vendored

This directory is Substrate's workflow interpreter, copied into this repository as a library. It runs a Claude Code workflow script (`export const meta = ...` and a body with top-level `await` and `return`) against a `Backend`, journals every `agent()` call, and replays or resumes a run from that journal. Nothing in `src` imports it yet: a later change wraps it in a Cordis plugin with a Backend of its own.

## Provenance

| | |
| --- | --- |
| Origin | Substrate (`agency-agency/substrate`), `packages/interpreter` |
| Commit | `6e6a72269ef7fa478f53c9b379bcff1c2561802a` (`6e6a722`) |
| Vendored | 2026-11-12 |
| Source | `src/*.ts`, 10 files, 2,376 lines, here as `src/workflow/*.ts` |
| Tests | `test/helpers.ts` and 10 of its 11 test files, here in `tests/workflow/` |

The code is unchanged. These are all the differences from that commit:

1. **Two comment lines.** `key.ts` line 4 and `journal.ts` line 165 named a directory in one machine's home and a profile folder there. The comments now say where the measurements came from without the path. No code differs.
2. **Test layout.** The tests are `tests/workflow/*.spec.ts` instead of `test/*.test.ts`, so the root vitest configuration runs them, and their imports read `../../src/workflow/<file>.ts` instead of `../src/<file>.ts`.
3. **`fidelity.spec.ts`** reads recorded runs only from the directory `NAIVE_PROJECTS` names. Substrate's file also fell back to two directories under one machine's home. Without that variable, the tests against recorded runs are skipped, as they were on any machine without those runs. The three synthetic tests always run.
4. **Not vendored:**
   - `conformance.test.ts`: all 28 of its tests compare against private recorded runs on one machine, named by session id, and are skipped everywhere else. It stays in Substrate.
   - `bin/naive-run.mjs`: a `tsx` loader for `cli.ts`. `main(argv)` in `cli.ts` is the same entry. `cli.ts` is kept only because the vendored tests `successor-r2`, `successor-r3` and `successor-r5` call `main`: `index.ts` does not export it, the plugin never runs it, and `lib/` does not contain it.
   - `package.json`, `tsconfig.json` and `vitest.config.ts`: the repository's own configuration builds and tests this code, with TypeScript 6.0.3 and vitest 4.1.8.
   - The original README, whose contract is summarized below.
5. **Dependencies.** `effect` `4.0.0-rc.112`, a peer dependency in Substrate, and `ajv` `8.20.0`, the version Substrate's lockfile resolves, are exact `dependencies` here. `tsdown.config.ts` keeps them out of the bundle, as it does `zod`.
6. **Repository checks.** `tests/class-docs.spec.ts` skips this directory, so its classes keep Substrate's comment style. `docs/007-architecture.md` lists its modules and tests.

To check the source against Substrate (only the two comment lines should differ):

```sh
for f in backend cli index interpreter journal jsonschema key meta replay sandbox; do
  git -C <substrate checkout> show 6e6a722:packages/interpreter/src/$f.ts | diff - src/workflow/$f.ts
done
```

To update, copy from a newer Substrate commit in the same way, make the same differences, and change the commit above.

## The contract it keeps

This is a summary of Substrate's README at `6e6a722`. The code comments are the full text.

- **The realm.** A script runs in a fresh `node:vm` context (`sandbox.ts`). It sees its own ECMAScript intrinsics and the workflow builtins, and nothing else: no `process`, `require`, `fetch`, timers or host objects. Values cross the boundary as JSON. This isolates globals. It is not a security boundary, because workflow scripts are the operator's own code.
- **Resume-safe time.** `Date.now()`, `Date()`, an argless `new Date()`, `Math.random()` and an argless `Intl.DateTimeFormat().format()` throw, because each would make a resumed run diverge from its journal. Intl and the Date local-time methods answer in UTC.
- **Nothing is fabricated.**
  - A replay that reaches a call its journal did not record reports `diverged`, not `completed`.
  - A failed call is journalled with its error.
  - A recorded result is checked against the call's schema again. A mismatch becomes null.
  - A throwing `parallel` thunk or `pipeline` stage becomes null for that item only.
- **Caps.**
  - `workflow()` nests 1 level (`MAX_NESTING`).
  - A `parallel` or `pipeline` call takes at most 4096 items (`ITEMS_PER_CALL_CAP`).
  - A run makes at most 1000 `agent()` calls (`LIFETIME_AGENT_CAP`).
  - A budget is a ceiling: a call that would pass it is refused when it is admitted.
- **Resume identity.**
  - `cacheIdentity: "chain"` is the harness's chained key and the default.
  - `cacheIdentity: "content"` (`c1:<sha256>#<occurrence>`, `key.ts`) looks every call up on its own, so an early failure does not discard later cached work.
  - `resumeFrom` takes a `LoadedJournal` from `parseJournal`.
- **`workflow()` resolution.** `resolveWorkflow` is the caller's choice. By default a bare name is looked up as `<name>.js` in the calling script's directory, then in `.claude/workflows/` under the working directory. A path ending in `.js` resolves against the calling script's directory.
