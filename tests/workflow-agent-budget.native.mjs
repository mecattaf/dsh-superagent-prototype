// Run on compute through runtime-test. Native DSH, literal local HTTP only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [dsh, baselineRoot, builtRoot] = process.argv.slice(2);
assert.ok(dsh?.startsWith('/nix/store/') && baselineRoot && builtRoot);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const redact = text => text.replace(/([?&]token=)[^\s&]+/g, '$1REDACTED');
const stream = (response, delta, finish) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [part, reason] of [[delta, null], [{}, finish]]) {
    response.write('data: ' + JSON.stringify({ id: 'literal-fixture', object: 'chat.completion.chunk', model: 'fixture-model',
      choices: [{ index: 0, delta: part, finish_reason: reason }] }) + '\n\n');
  }
  response.end('data: [DONE]\n\n');
};

async function fixture(label, limit, override = true) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-native-budget-'));
  const profile = join(root, 'profiles', 'fixture');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  symlinkSync(resolve(baselineRoot), join(profile, 'node_modules', 'dsh-superagent'));
  const script = join(root, 'probe.workflow.js');
  writeFileSync(script, "export const meta = { name: 'native-budget-probe', description: 'no nodes or inference' };\nreturn {probe:'complete'};\n");
  const requests = [];
  let handlerError;
  const fake = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(text); requests.push(body);
      writeFileSync(join(root, 'requests.json'), JSON.stringify(requests, null, 2));
      if (requests.length === 1) {
        const tool = body.tools.find(item => item.function.name === 'orchestrator_workflow_start');
        assert.ok(tool);
        assert.equal(Boolean(tool.function.parameters.properties.max_agents), override);
        const args = { script, cwd: root, ...(limit === undefined ? {} : { max_agents: limit }) };
        stream(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'start-once', type: 'function',
          function: { name: 'orchestrator_workflow_start', arguments: JSON.stringify(args) } }] }, 'tool_calls');
      } else {
        assert.equal(requests.length, 2, 'No extra provider request or model polling');
        assert.ok(body.messages.some(item => item.role === 'tool'));
        stream(response, { role: 'assistant', content: 'The fixture result is recorded.' }, 'stop');
      }
    } catch (error) {
      handlerError = error; response.writeHead(500); response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const webPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'] } } }));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), `
- {id: session-log-deepseek, disabled: true}
- {id: session-title-llm, disabled: true}
- {id: plugin-manager, disabled: true}
- {id: llm-retry, disabled: true}
- {id: deepseek-llm-api-extensions, disabled: true}
- {id: llm-deepseek, disabled: true}
- {id: llm-deepseek-account, disabled: true}
- {id: agent-preset-registry, config: {default: standard}}
- {id: agent-default-model, config: {provider: fixture, model: fixture-model}}
- {id: webserver, config: {host: 127.0.0.1, port: ${webPort}}}
- id: llm-pi-ai
  config:
    providers:
      fixture:
        api: openai-completions
        baseURL: http://127.0.0.1:${fakePort}/v1
        apiKeyEnv: GUFO_API_KEY
        compat: {supportsDeveloperRole: false, supportsStore: false}
        models: [{id: fixture-model, contextWindow: 102400, maxTokens: 2048}]
- {id: dsh-superagent, config: {engine: true, stateDir: ${JSON.stringify(join(root, 'state'))}, executor: dshd, dshd: {command: /run/current-system/sw/bin/dshd, prefix: wfprobe, defaultPair: fixture, pairs: {fixture: {profile: unused, env: {}, maxWorkers: 1}}}}}
- {id: dsh-superagent-github, disabled: true}
- {id: dsh-superagent-feishu, disabled: true}
- {id: dsh-superagent-scheduled, disabled: true}
- id: dsh-superagent-workflow
  disabled: ${override ? 'true' : 'false'}
  config: {pair: fixture, concurrency: 1, maxAttempts: 1, pollMs: 500}
${override ? `- insert:
    - id: dsh-superagent-workflow-budget
      name: ${JSON.stringify(resolve(builtRoot, 'lib/workflow.js'))}
      config: {pair: fixture, concurrency: 1, maxAttempts: 1, pollMs: 500}` : ''}
`);
  let out = '', err = '';
  const child = spawn(dsh, ['fixture', '--no-open'], { cwd: root,
    env: { ...process.env, DSH_HOME: root, GUFO_API_KEY: 'literal-fixture', DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const finishBy = Date.now() + 45000;
  let cookie;
  const origin = `http://127.0.0.1:${webPort}`;
  async function rpc(method, request) {
    const response = await fetch(origin + '/api/' + method, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: { request } } }) });
    const value = await response.json(); assert.equal(response.status, 200); assert.equal(value.result.ok, true, JSON.stringify(value));
    return value.result.value;
  }
  let state, rows = [];
  try {
    while (Date.now() < finishBy) {
      const match = (out + err).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/);
      if (match) {
        const connected = await fetch(origin + '/connect?token=' + match[1] + '&interactions=none', { redirect: 'manual' });
        cookie = connected.headers.get('set-cookie')?.split(';')[0];
        if (cookie) {
          const response = await fetch(origin + '/orchestrator/api/state', { headers: { 'x-orchestrator-request': '1' } });
          if (response.status === 200) { state = await response.json(); break; }
        }
      }
      if (child.exitCode !== null) throw new Error('Native fixture exited during boot: ' + redact(err + out));
      await sleep(50);
    }
    assert.ok(state?.masterId, redact(err + out));
    const sourceResponse = await fetch(origin + '/orchestrator/api/sources', { headers: { 'x-orchestrator-request': '1' } });
    const sourceState = await sourceResponse.json();
    writeFileSync(join(root, 'sources.json'), JSON.stringify(sourceState, null, 2));
    console.log(JSON.stringify({label, root, sources:sourceState}));
    await rpc('session/prompt', { requestId: 'native-fixture-' + label, sessionId: state.masterId,
      mode: 'queue', content: [{ type: 'text', text: 'Execute the explicit literal workflow-start fixture once, then end.' }] });
    while (Date.now() < finishBy) {
      const session = await rpc('session/state', { sessionId: state.masterId });
      if (requests.length === 2 && !session.running) break;
      await sleep(50);
    }
    if (handlerError) throw handlerError;
    assert.equal(requests.length, 2, redact(err + out));
    const db = new DatabaseSync(join(root, 'state', 'orchestrator.sqlite'), { readOnly: true });
    rows = db.prepare("SELECT value FROM kv WHERE key LIKE 'workflow-run:%'").all().map(row => JSON.parse(row.value)); db.close();
    const shouldStart = override && (limit === undefined || limit >= 1);
    assert.equal(rows.length, shouldStart ? 1 : 0, 'Actual public tool schema controls the handler');
    if (shouldStart) {
      assert.equal(rows[0].state, 'completed'); assert.equal(rows[0].maxAgents, limit);
      assert.deepEqual(rows[0].result, { probe: 'complete' });
    }
    writeFileSync(join(root, 'sanitized-boot.log'), redact(err + out));
    writeFileSync(join(root, 'proof.json'), JSON.stringify({ label, override, limit: limit ?? 'default1000',
      providerRequests: requests.length, workflowRuns: rows, sourceModule: resolve(builtRoot, 'lib/workflow.js') }, null, 2));
    console.log(JSON.stringify({ label, outcome: 'PASS', root, limit: limit ?? 'default1000', runs: rows.length, providerRequests: requests.length }));
  } finally {
    writeFileSync(join(root, 'sanitized-boot.log'), redact(err + out));
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => fake.close(resolve));
  }
}

await fixture('override', 1001);
await fixture('default', undefined);
await fixture('invalid-zero', 0);
await fixture('old-source-negative-control', 1001, false);
