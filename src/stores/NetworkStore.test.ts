import {describe, expect, it} from 'vitest';
import {Sequence} from '../buffer/RingBuffer.js';
import {loadConfig} from '../config.js';
import * as fx from '../test-support/fixtures.js';
import {NetworkStore} from './NetworkStore.js';

const APP_A = 'A#Android#Pixel#emulator-5554';
const APP_B = 'B#Android#Pixel#emulator-5554';

function store(capacity = 50) {
  const config = loadConfig({FLIPPER_NETWORK_BUFFER: String(capacity)}, []);
  return new NetworkStore(config, new Sequence());
}

const message = (clientId: string, method: string, params: unknown) => ({clientId, api: 'Network', method, params, ts: Date.now()});

describe('NetworkStore', () => {
  it('returns a response through afterId even when the request was already polled as pending', () => {
    const network = store();
    network.handle(message(APP_A, 'newRequest', fx.newRequest('r1', 'https://api.dev/pay')));
    const first = network.query({});

    network.handle(message(APP_A, 'newResponse', fx.newResponse('r1', 500, '{}')));
    const next = network.query({afterId: first.lastId});

    expect(first.items).toEqual([expect.objectContaining({requestId: 'r1', pending: true})]);
    expect(next.items).toEqual([expect.objectContaining({requestId: 'r1', status: 500})]);
    expect(network.query({afterId: next.lastId}).items).toEqual([]);
  });

  it('does not return another app request by event id', () => {
    const network = store();
    network.handle(message(APP_A, 'newRequest', fx.newRequest('r1', 'https://api.dev/a')));
    const id = network.query({}).items[0]!.id as number;

    expect(network.find(id, APP_B)).toBeUndefined();
    expect(network.find(id, APP_A)?.requestId).toBe('r1');
  });

  it('keeps interrupted chunked responses bounded by the buffer capacity', () => {
    const network = store(2);

    for (let i = 0; i < 100; i++) {
      network.handle(message(APP_A, 'newRequest', fx.newRequest(`p${i}`, 'https://api.dev/x')));
      network.handle(message(APP_A, 'partialResponse', fx.partialResponses(`p${i}`, 200, 'abcdef', 2)[0]));
    }

    expect(network.pendingAssemblies).toBeLessThanOrEqual(2);
  });

  it('drops half-assembled responses when the app session ends', () => {
    const network = store();
    network.handle(message(APP_A, 'partialResponse', fx.partialResponses('p1', 200, 'abcdef', 2)[0]));

    network.forgetPartials(APP_A);

    expect(network.pendingAssemblies).toBe(0);
  });

  it('keeps the request index bounded by the buffer capacity', () => {
    const network = store(2);

    for (let i = 0; i < 100; i++) network.handle(message(APP_A, 'newRequest', fx.newRequest(`r${i}`, 'https://api.dev/x')));

    expect(network.buffer.size).toBe(2);
    expect(network.indexedRequests).toBe(2);
  });
});
