/**
 * Tests for `InMemoryBookmarkStore` — the default `BookmarkStore`
 * impl used in tests and as a fallback before persistent storage is
 * wired in.
 *
 * As with the history tests, the contract under test is the public
 * `BookmarkStore` interface; a future persistent impl can re-use
 * this file by parameterising the factory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryBookmarkStore } from '../bookmarks';

describe('InMemoryBookmarkStore', () => {
  it('add returns the stored entry with id and createdAt populated', async () => {
    const s = new InMemoryBookmarkStore();
    const stored = await s.add({ url: 'https://a.example.com', title: 'A' });
    assert.equal(stored.url, 'https://a.example.com');
    assert.equal(stored.title, 'A');
    assert.equal(typeof stored.id, 'string');
    assert.ok(stored.id.length > 0);
    assert.equal(typeof stored.createdAt, 'number');
    assert.ok(stored.createdAt > 0);
  });

  it('add assigns monotonically distinct ids', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({ url: 'https://a.example.com', title: 'A' });
    const b = await s.add({ url: 'https://b.example.com', title: 'B' });
    const c = await s.add({ url: 'https://c.example.com', title: 'C' });
    assert.notEqual(a.id, b.id);
    assert.notEqual(b.id, c.id);
    assert.notEqual(a.id, c.id);
  });

  it('add preserves an optional faviconUrl', async () => {
    const s = new InMemoryBookmarkStore();
    const stored = await s.add({
      url: 'https://a.example.com',
      title: 'A',
      faviconUrl: 'https://a.example.com/favicon.ico',
    });
    assert.equal(stored.faviconUrl, 'https://a.example.com/favicon.ico');
  });

  it('list returns entries in insertion order', async () => {
    const s = new InMemoryBookmarkStore();
    await s.add({ url: 'https://1.example.com', title: '1' });
    await s.add({ url: 'https://2.example.com', title: '2' });
    await s.add({ url: 'https://3.example.com', title: '3' });
    const list = await s.list();
    assert.deepEqual(
      list.map((b) => b.url),
      [
        'https://1.example.com',
        'https://2.example.com',
        'https://3.example.com',
      ],
    );
  });

  it('list returns a copy — mutating it does not affect the store', async () => {
    const s = new InMemoryBookmarkStore();
    await s.add({ url: 'https://a.example.com', title: 'A' });
    const list = (await s.list()) as ReturnType<typeof Array>;
    list.length = 0;
    const after = await s.list();
    assert.equal(after.length, 1);
  });

  it('remove deletes the matching entry', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({ url: 'https://a.example.com', title: 'A' });
    const b = await s.add({ url: 'https://b.example.com', title: 'B' });
    await s.remove(a.id);
    const list = await s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, b.id);
  });

  it('remove is a no-op for unknown ids', async () => {
    const s = new InMemoryBookmarkStore();
    await s.add({ url: 'https://a.example.com', title: 'A' });
    await s.remove('does-not-exist');
    const list = await s.list();
    assert.equal(list.length, 1);
  });

  it('update can change title in place', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({ url: 'https://a.example.com', title: 'A' });
    await s.update(a.id, { title: 'A — renamed' });
    const list = await s.list();
    assert.equal(list[0]!.title, 'A — renamed');
    assert.equal(list[0]!.url, 'https://a.example.com');
  });

  it('update can change faviconUrl without touching title', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({ url: 'https://a.example.com', title: 'A' });
    await s.update(a.id, { faviconUrl: 'https://a.example.com/new.ico' });
    const list = await s.list();
    assert.equal(list[0]!.title, 'A');
    assert.equal(list[0]!.faviconUrl, 'https://a.example.com/new.ico');
  });

  it('update with an empty patch is a no-op', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({
      url: 'https://a.example.com',
      title: 'A',
      faviconUrl: 'https://a.example.com/favicon.ico',
    });
    await s.update(a.id, {});
    const list = await s.list();
    assert.equal(list[0]!.title, 'A');
    assert.equal(list[0]!.faviconUrl, 'https://a.example.com/favicon.ico');
  });

  it('update throws for unknown ids', async () => {
    const s = new InMemoryBookmarkStore();
    await assert.rejects(s.update('does-not-exist', { title: 'X' }));
  });

  it('createdAt is non-decreasing across consecutive adds', async () => {
    const s = new InMemoryBookmarkStore();
    const a = await s.add({ url: 'https://a.example.com', title: 'A' });
    const b = await s.add({ url: 'https://b.example.com', title: 'B' });
    assert.ok(b.createdAt >= a.createdAt);
  });
});
