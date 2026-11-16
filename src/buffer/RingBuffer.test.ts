import {describe, expect, it} from 'vitest';
import {RingBuffer, Sequence, type Stamped} from './RingBuffer.js';

interface Item extends Stamped {
  name: string;
}

function filled(capacity: number, count: number, sequence = new Sequence()) {
  const buffer = new RingBuffer<Item>(capacity, sequence);
  for (let i = 1; i <= count; i++) buffer.push({name: `e${i}`, ts: i * 1000});
  return buffer;
}

describe('RingBuffer', () => {
  it('evicts the oldest events once full and counts them', () => {
    const buffer = filled(3, 5);

    expect([...buffer.values()].map((e) => e.name)).toEqual(['e3', 'e4', 'e5']);
    expect(buffer.size).toBe(3);
    expect(buffer.evicted).toBe(2);
  });

  it('forgets evicted ids and still finds live ones', () => {
    const buffer = filled(2, 3);

    expect(buffer.get(1)).toBeUndefined();
    expect(buffer.get(3)?.name).toBe('e3');
  });

  it('shares one id sequence across buffers so ids never collide', () => {
    const sequence = new Sequence();
    const a = new RingBuffer<Item>(5, sequence);
    const b = new RingBuffer<Item>(5, sequence);

    const first = a.push({name: 'a'});
    const second = b.push({name: 'b'});

    expect([first.id, second.id]).toEqual([1, 2]);
  });

  it('keeps the newest matches when limit cuts the result', () => {
    const page = filled(10, 6).query({limit: 2});

    expect(page.items.map((e) => e.name)).toEqual(['e5', 'e6']);
    expect(page).toMatchObject({matched: 6, truncated: true, lastId: 6});
  });

  it('applies since, until, afterId and predicate together', () => {
    const page = filled(10, 8).query({
      since: 2000,
      until: 7000,
      afterId: 3,
      predicate: (e) => e.name !== 'e5',
    });

    expect(page.items.map((e) => e.name)).toEqual(['e4', 'e6', 'e7']);
    expect(page.truncated).toBe(false);
  });

  it('returns newest-first matches from findLast', () => {
    const buffer = filled(10, 4);

    expect(buffer.findLast((e) => e.ts < 3500)?.name).toBe('e3');
  });

  it('reports each evicted event', () => {
    const evicted: string[] = [];
    const buffer = new RingBuffer<Item>(2, new Sequence(), (item) => evicted.push(item.name));

    for (const name of ['a', 'b', 'c', 'd']) buffer.push({name});

    expect(evicted).toEqual(['a', 'b']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer<Item>(0)).toThrow('positive integer');
  });
});
