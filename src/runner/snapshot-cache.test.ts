import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  createRedisKeyValueStore,
  createSnapshotCache,
  type KeyValueStore,
} from './snapshot-cache.js';

const KEY_PREFIX = 'diffprove:env-snapshots';

/** In-memory `KeyValueStore` that records the raw keys it is asked about. */
function createFakeKv(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const get = vi.fn<(key: string) => Promise<string | null>>(async (key) => values.get(key) ?? null);
  const set = vi.fn<(key: string, value: string) => Promise<void>>(async (key, value) => {
    values.set(key, value);
  });
  const kv: KeyValueStore = { get, set };
  return { kv, get, set, values };
}

describe('createSnapshotCache', () => {
  it('maps get and set onto the repo~lockfile key', async () => {
    const { kv, get, set } = createFakeKv({ [`${KEY_PREFIX}:octocat~hello-world:lock-abc`]: 'snap-123' });
    const cache = createSnapshotCache(kv);

    await expect(cache.get('octocat/hello-world', 'lock-abc')).resolves.toBe('snap-123');
    await cache.set('octocat/hello-world', 'lock-abc', 'snap-123');

    expect(get.mock.calls).toEqual([[`${KEY_PREFIX}:octocat~hello-world:lock-abc`]]);
    expect(set.mock.calls).toEqual([[`${KEY_PREFIX}:octocat~hello-world:lock-abc`, 'snap-123']]);
  });

  it('flattens every slash so nested names stay one key segment', async () => {
    const { kv, get } = createFakeKv();
    const cache = createSnapshotCache(kv);

    await expect(cache.get('some-org/team/service', 'pnpm-lock.yaml:9f2c')).resolves.toBeNull();

    expect(get.mock.calls).toEqual([
      [`${KEY_PREFIX}:some-org~team~service:pnpm-lock.yaml:9f2c`],
    ]);
  });

  it('keeps repositories and lockfiles independent', async () => {
    const { kv, values } = createFakeKv();
    const cache = createSnapshotCache(kv);

    await cache.set('octocat/hello-world', 'lock-a', 'snap-a');
    await cache.set('octocat/hello-world', 'lock-b', 'snap-b');
    await cache.set('octocat/other-repo', 'lock-a', 'snap-c');

    expect(values.size).toBe(3);
    await expect(cache.get('octocat/hello-world', 'lock-a')).resolves.toBe('snap-a');
    await expect(cache.get('octocat/hello-world', 'lock-b')).resolves.toBe('snap-b');
    await expect(cache.get('octocat/other-repo', 'lock-a')).resolves.toBe('snap-c');
  });
});

const redisUrl = process.env.REDIS_URL;

// Gated on a real Redis: this is the only place that exercises the ioredis
// adapter end to end, so it is skipped on machines without REDIS_URL.
describe.skipIf(!redisUrl)('createRedisKeyValueStore', () => {
  it('round-trips a value and closes the connection', async () => {
    if (!redisUrl) {
      throw new Error('REDIS_URL must be set for the Redis integration test');
    }
    const store = createRedisKeyValueStore(redisUrl);
    const key = `${KEY_PREFIX}:test:${randomUUID()}`;

    try {
      await store.set(key, 'snap-integration');
      await expect(store.get(key)).resolves.toBe('snap-integration');
    } finally {
      await store.close();
    }
  });
});
