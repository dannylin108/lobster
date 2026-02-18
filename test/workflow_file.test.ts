import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runWorkflowFile } from '../src/workflows/file.js';
import { decodeResumeToken } from '../src/resume.js';

test('workflow file runs with approval and resume', async () => {
  const workflow = {
    name: 'sample',
    steps: [
      {
        id: 'collect',
        command: "node -e \"process.stdout.write(JSON.stringify([{value:1}]))\"",
      },
      {
        id: 'mutate',
        command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);items[0].value=2;process.stdout.write(JSON.stringify(items));});\"",
        stdin: '$collect.stdout',
      },
      {
        id: 'approve_step',
        command: "node -e \"process.stdout.write(JSON.stringify({requiresApproval:{prompt:'Proceed?', items:[{id:1}]}}))\"",
        approval: 'required',
      },
      {
        id: 'finish',
        command: "node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const items=JSON.parse(d);process.stdout.write(JSON.stringify({done:true,value:items[0].value}));});\"",
        stdin: '$mutate.stdout',
        condition: '$approve_step.approved',
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-'));
  const stateDir = path.join(tmpDir, 'state');
  const filePath = path.join(tmpDir, 'workflow.lobster');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  const env = { ...process.env, LOBSTER_STATE_DIR: stateDir };

  const first = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
  });

  assert.equal(first.status, 'needs_approval');
  assert.equal(first.requiresApproval?.prompt, 'Proceed?');
  assert.ok(first.requiresApproval?.resumeToken);

  const payload = decodeResumeToken(first.requiresApproval?.resumeToken ?? '');
  assert.equal(payload.kind, 'workflow-file');

  const resumed = await runWorkflowFile({
    filePath,
    ctx: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env,
      mode: 'tool',
    },
    resume: payload,
    approved: true,
  });

  assert.equal(resumed.status, 'ok');
  assert.deepEqual(resumed.output, [{ done: true, value: 2 }]);
});

test('workflow file executes openclaw.invoke via lobster runtime (not shell)', async () => {
  const bodyLog: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tools/invoke') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      bodyLog.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { ok: true, source: 'gateway' } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const workflow = {
    name: 'invoke-demo',
    steps: [
      {
        id: 'llm',
        command: `openclaw.invoke --tool llm-task --action json --args-json '{"prompt":"hello"}'`,
      },
    ],
  };

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lobster-workflow-openclaw-'));
  const filePath = path.join(tmpDir, 'workflow.lobster.yaml');
  await fsp.writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf8');

  try {
    const env = { ...process.env, CLAWD_URL: `http://127.0.0.1:${port}` };

    const run = await runWorkflowFile({
      filePath,
      ctx: {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        env,
        mode: 'tool',
      },
    });

    assert.equal(run.status, 'ok');
    assert.deepEqual(run.output, [{ ok: true, source: 'gateway' }]);
    assert.equal(bodyLog.length, 1);
    assert.equal(bodyLog[0].tool, 'llm-task');
    assert.equal(bodyLog[0].action, 'json');
    assert.equal(bodyLog[0].args.prompt, 'hello');
  } finally {
    server.close();
  }
});
