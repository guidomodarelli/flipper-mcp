import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadConfig} from './config.js';
import {Debugger} from './Debugger.js';
import {readRecording, type RecordedFrame} from './flipper/Recorder.js';
import {FakeFlipperServer} from './test-support/FakeFlipperServer.js';

/**
 * Replays sessions captured with `flipper-mcp --record` (fixtures/recordings/*.jsonl).
 * Drop new captures from the real app there; the tests pick them up.
 */
const DIR = path.resolve('fixtures/recordings');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')) : [];

type Frame = {event: string; payload: any};
const frame = (f: RecordedFrame) => f.frame as Frame;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it('ships at least the recording captured from a real flipper-server', () => {
  // Guards against the fixtures being ignored or dropped from the repo.
  expect(files).toContain('real-flipper-server-0.273.0-no-device.jsonl');
});

describe.each(files)('recording %s', (file) => {
  const frames = readRecording(path.join(DIR, file));

  it('only contains the envelopes documented in PROTOCOL.md', () => {
    const outIds = new Set(frames.filter((f) => f.dir === 'out').map((f) => frame(f).payload.id));

    for (const f of frames) {
      const {event, payload} = frame(f);
      if (f.dir === 'out') {
        expect(event).toBe('exec');
        expect(payload).toEqual({id: expect.any(Number), command: expect.any(String), args: expect.any(Array)});
      } else {
        expect(['exec-response', 'exec-response-error', 'server-event', 'error']).toContain(event);
        if (event.startsWith('exec-response')) expect(outIds).toContain(payload.id);
        if (event === 'server-event') expect(payload).toEqual({event: expect.any(String), data: expect.anything()});
      }
    }
  });

  it('ingests every pushed plugin message without errors', async () => {
    const events = frames.filter((f) => f.dir === 'in' && frame(f).event === 'server-event').map((f) => frame(f).payload);
    const messages = events.filter((e) => e.event === 'client-message').map((e) => ({id: e.data.id, ...JSON.parse(e.data.message)}));
    const apis = new Set(messages.filter((m) => m.method === 'execute').map((m) => `${m.params.api}.${m.params.method}`));

    const fake = new FakeFlipperServer();
    const port = await fake.start();
    const dbg = new Debugger({...loadConfig({}, []), port, host: '127.0.0.1', token: 'test-token'});
    dbg.start();
    cleanup = async () => {
      dbg.stop();
      await fake.stop();
    };
    await vi.waitFor(() => expect(dbg.connection.state).toBe('connected'), {timeout: 3000});
    const logsBefore = dbg.logs.buffer.size;

    for (const event of events) fake.emitEvent(event.event, event.data);

    const deviceLogs = events.filter((e) => e.event === 'device-log').length;
    await vi.waitFor(() => expect(dbg.logs.buffer.size - logsBefore).toBe(Math.min(deviceLogs, dbg.logs.buffer.capacity)));
    if (apis.has('Network.newRequest')) expect(dbg.network.buffer.size).toBeGreaterThan(0);
    if (apis.has('FluxDispatcher.action')) {
      await vi.waitFor(() => expect(dbg.flux.buffer.size).toBe(messages.filter((m) => m.params?.method === 'action').length));
    }
    if (apis.has('ui-debugger.subtreeUpdate') || apis.has('ui-debugger.frameScan')) {
      const clientId = messages.find((m) => m.params?.api === 'ui-debugger')!.id;
      await vi.waitFor(() => expect(dbg.ui.hasFrame(clientId)).toBe(true));
      // Real frames carry text inside namespace sections; at least one node must expose it.
      const tree = JSON.stringify(dbg.ui.hierarchy(clientId, {maxDepth: 50, maxNodes: 5000}));
      if (apis.has('ui-debugger.metadataUpdate')) expect(tree).toContain('"text":');
    }
  });
});
