/**
 * Tests for `InMemoryHistoryStore` — the default `HistoryStore` impl
 * used in tests and as a fallback before a persistent adapter is
 * wired in.
 *
 * The contract under test is the public `HistoryStore` interface;
 * the in-memory impl is the system under test. Any future persistent
 * impl can re-use this file by parameterising the factory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryHistoryStore } from '../history';

describe('InMemoryHistoryStore', () => {
  it('record then recent returns the entry', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'A', visitedAt: 100 });
    const recent = await s.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.url, 'https://a.example.com');
  });

  it('recent returns newest-first', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://1.example.com', title: '1', visitedAt: 100 });
    await s.record({ url: 'https://2.example.com', title: '2', visitedAt: 200 });
    await s.record({ url: 'https://3.example.com', title: '3', visitedAt: 300 });
    const recent = await s.recent(10);
    assert.deepEqual(
      recent.map((e) => e.url),
      [
        'https://3.example.com',
        'https://2.example.com',
        'https://1.example.com',
      ],
    );
  });

  it('recent respects the limit', async () => {
    const s = new InMemoryHistoryStore();
    for (let i = 0; i < 5; i++) {
      await s.record({ url: `https://${i}.example.com`, title: String(i), visitedAt: i });
    }
    const recent = await s.recent(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]!.url, 'https://4.example.com');
    assert.equal(recent[1]!.url, 'https://3.example.com');
  });

  it('recent with limit 0 returns an empty list', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'A', visitedAt: 1 });
    const recent = await s.recent(0);
    assert.equal(recent.length, 0);
  });

  it('recent with a query filters case-insensitively against url and title', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://github.com', title: 'GitHub', visitedAt: 1 });
    await s.record({ url: 'https://example.com', title: 'Example', visitedAt: 2 });
    await s.record({ url: 'https://docs.github.com', title: 'GitHub Docs', visitedAt: 3 });
    const hits = await s.recent(10, 'github');
    assert.equal(hits.length, 2);
    // Newest-first within the filtered set.
    assert.equal(hits[0]!.url, 'https://docs.github.com');
    assert.equal(hits[1]!.url, 'https://github.com');
  });

  it('recent query matches title even when URL does not', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'Anthropic blog', visitedAt: 1 });
    const hits = await s.recent(10, 'anthropic');
    assert.equal(hits.length, 1);
  });

  it('forget removes every entry for a URL across all visits', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'A', visitedAt: 1 });
    await s.record({ url: 'https://b.example.com', title: 'B', visitedAt: 2 });
    await s.record({ url: 'https://a.example.com', title: 'A again', visitedAt: 3 });
    await s.forget('https://a.example.com');
    const recent = await s.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.url, 'https://b.example.com');
  });

  it('forget is a no-op for unknown URLs', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'A', visitedAt: 1 });
    await s.forget('https://not-recorded.example.com');
    const recent = await s.recent(10);
    assert.equal(recent.length, 1);
  });

  it('clear empties the store', async () => {
    const s = new InMemoryHistoryStore();
    await s.record({ url: 'https://a.example.com', title: 'A', visitedAt: 1 });
    await s.record({ url: 'https://b.example.com', title: 'B', visitedAt: 2 });
    await s.clear();
    const recent = await s.recent(10);
    assert.equal(recent.length, 0);
  });

  it('clear on an empty store is a no-op', async () => {
    const s = new InMemoryHistoryStore();
    await s.clear();
    const recent = await s.recent(10);
    assert.equal(recent.length, 0);
  });
});
