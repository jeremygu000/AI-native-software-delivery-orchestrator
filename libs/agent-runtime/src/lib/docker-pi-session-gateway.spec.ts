import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DockerPiSessionGateway } from './docker-pi-session-gateway.js';
import { PiSessionCancellationConfirmedError } from './pi-gateway.js';
import { ApprovedPiHostModelProxy, isolatedPiModel } from './pi-model-proxy.js';

const image = process.env.FORGE_TEST_DOCKER_IMAGE;
const execute = promisify(execFile);
const noop = () => {};
const fixture = (body: string) =>
  new DockerPiSessionGateway({
    image: image ?? 'test@sha256:' + 'a'.repeat(64),
    executable: '/usr/local/bin/node',
    args: [
      '-e',
      `
    const readline = require('node:readline');
    const fs = require('node:fs');
    const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
    readline.createInterface({input:process.stdin}).on('line', async (line) => {
      const message=JSON.parse(line);
      ${body}
    });
  `
    ],
    timeoutMs: 15_000
  });

describe('Docker Pi host broker', () => {
  it.skipIf(image === undefined)(
    'proxies model inference on the host without disclosing endpoint or credentials',
    async () => {
      const secret = 'host-only-provider-secret';
      let calls = 0;
      const proxy = new ApprovedPiHostModelProxy({
        model: { ...isolatedPiModel, provider: 'openai', baseUrl: 'https://host-only.example/v1' },
        apiKey: secret,
        complete: async (_model, _context, options) => {
          expect(options?.apiKey).toBe(secret);
          calls++;
          return {
            role: 'assistant',
            api: isolatedPiModel.api,
            provider: 'openai',
            model: 'approved',
            content: [{ type: 'text', text: 'approved-host-answer' }],
            stopReason: 'stop',
            timestamp: Date.now(),
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          };
        }
      });
      // The deployment config, not a container frame, installs the model proxy.
      const gateway = new DockerPiSessionGateway({
        image: image!,
        executable: '/usr/local/bin/node',
        args: [
          '-e',
          `const readline=require('node:readline'),fs=require('node:fs'); const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'); readline.createInterface({input:process.stdin}).on('line',line=>{ const message=JSON.parse(line);
        if(message.type==='start') send({type:'started',sessionId:'model-session'});
        else if(message.type==='started-ack') send({type:'model',id:'model-1',context:{messages:[{role:'user',content:'Approved prompt',timestamp:1}],tools:[]}});
        else if(message.type==='model-result') { if(JSON.stringify(message).includes('host-only') || process.env.OPENAI_API_KEY || fs.existsSync('/workspace')) throw new Error('credential leak'); if(message.message.content[0].text!=='approved-host-answer') throw new Error('bad inference'); send({type:'completed',sessionId:'model-session'}); process.exit(0); }
      });`
        ],
        modelProxy: proxy,
        timeoutMs: 15000
      });
      await expect(
        gateway.start({
          cwd: '/unmounted',
          prompt: 'x',
          tools: [],
          onStarted: async () => {},
          executeTool: async () => {
            throw new Error('No tool');
          }
        })
      ).resolves.toEqual({ sessionId: 'model-session' });
      expect(calls).toBe(1);
    },
    30_000
  );

  it('requires immutable image identity and an image-owned absolute entrypoint', () => {
    expect(() => new DockerPiSessionGateway({ image: 'node:latest', executable: '/node' })).toThrow(
      'pinned image'
    );
    expect(
      () =>
        new DockerPiSessionGateway({ image: 'node@sha256:' + 'a'.repeat(64), executable: 'node' })
    ).toThrow('absolute');
  });

  it.skipIf(image === undefined)(
    'isolates the actual process from the host workspace and acknowledges durable start before tools',
    async () => {
      const events: string[] = [];
      const gateway = fixture(`
      if(message.type==='start') {
        if(fs.existsSync('/workspace') || fs.existsSync('/var/run/docker.sock') || process.env.PGDATABASE) throw new Error('host access');
        try { fs.writeFileSync('/escape.txt','unsafe'); throw new Error('root writable'); }
        catch(error) { if(error.code!=='EROFS' && error.code!=='EACCES') throw error; }
        fs.writeFileSync('/tmp/ephemeral.txt','allowed');
        send({type:'started',sessionId:'container-session'});
      } else if(message.type==='started-ack') {
        send({type:'tool',id:'1',call:{name:'forge_write',path:'value.txt',content:'隔离写入'}});
      } else if(message.type==='tool-result') {
        if(message.id!=='1' || message.result.content!=='host-written') throw new Error('bad response');
        send({type:'completed',sessionId:'container-session'});
        process.exit(0);
      }
    `);
      await expect(
        gateway.start({
          cwd: '/host-workspace-never-mounted',
          prompt: 'approved prompt',
          tools: ['forge_write'],
          onStarted: async (id) => {
            expect(id).toBe('container-session');
            events.push('durable-start');
          },
          executeTool: async (call) => {
            expect(call).toEqual({ name: 'forge_write', path: 'value.txt', content: '隔离写入' });
            expect(events).toEqual(['durable-start']);
            events.push('fenced-host-callback');
            return { content: 'host-written' };
          }
        })
      ).resolves.toEqual({ sessionId: 'container-session' });
      expect(events).toEqual(['durable-start', 'fenced-host-callback']);
    },
    30_000
  );

  it.skipIf(image === undefined)(
    'kills container descendants on cancellation but drains the host callback before confirming',
    async () => {
      const controller = new AbortController();
      let allowCallback: () => void = noop;
      const callbackGate = new Promise<void>((resolve) => {
        allowCallback = resolve;
      });
      let entered: () => void = noop;
      const callbackEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let childContainerId = '';
      let finished = false;
      const gateway = fixture(`
      if(message.type==='start') {
        require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        send({type:'started',sessionId:fs.readFileSync('/etc/hostname','utf8').trim()});
      } else if(message.type==='started-ack') {
        send({type:'tool',id:'1',call:{name:'forge_read',path:'value.txt'}});
        setInterval(()=>{},1000);
      }
    `);
      const pending = gateway.start({
        cwd: '/unmounted',
        prompt: 'x',
        tools: ['forge_read'],
        cancellationSignal: controller.signal,
        onStarted: async (id) => {
          childContainerId = id;
        },
        executeTool: async () => {
          entered();
          await callbackGate;
          finished = true;
          return { content: 'done' };
        }
      });
      const outcome = expect(pending).rejects.toBeInstanceOf(PiSessionCancellationConfirmedError);
      await callbackEntered;
      controller.abort();
      await execute('docker', ['wait', childContainerId], { timeout: 15_000 });
      expect(finished).toBe(false);
      const { stdout } = await execute('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        childContainerId
      ]);
      expect(stdout.trim()).toBe('false');
      allowCallback();
      await outcome;
      expect(finished).toBe(true);
      await expect(execute('docker', ['inspect', childContainerId])).rejects.toThrow();
    },
    30_000
  );

  it.skipIf(image === undefined)(
    'rejects unestablished tools, duplicate IDs and disabled tools without repeated side effects',
    async () => {
      for (const scenario of ['early', 'duplicate', 'disabled']) {
        let mutations = 0;
        const gateway = fixture(`
        if(message.type==='start') {
          ${scenario === 'early' ? "send({type:'tool',id:'1',call:{name:'forge_write',path:'x',content:'x'}});" : "send({type:'started',sessionId:'s'});"}
        } else if(message.type==='started-ack') {
          send({type:'tool',id:'1',call:{name:'forge_write',path:'x',content:'x'}});
          ${scenario === 'duplicate' ? "send({type:'tool',id:'1',call:{name:'forge_write',path:'x',content:'x'}});" : ''}
        }
      `);
        await expect(
          gateway.start({
            cwd: '/unmounted',
            prompt: 'x',
            tools: scenario === 'disabled' ? ['forge_read'] : ['forge_write'],
            onStarted: async () => {},
            executeTool: async () => {
              mutations++;
              return { content: 'done' };
            }
          })
        ).rejects.toThrow();
        expect(mutations).toBe(scenario === 'duplicate' ? 1 : 0);
      }
    },
    60_000
  );
});
