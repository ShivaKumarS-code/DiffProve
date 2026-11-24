/**
 * Lockfile-keyed environment snapshot cache (architecture guardrail #4).
 *
 * Repeat PR runs for the same repo + lockfile hash boot from a cached E2B
 * snapshot instead of reinstalling dependencies, which is what keeps the
 * p50 run under 30 seconds.
 *
 * `createSnapshotCache` is a pure key-mapping adapter over any key/value store,
 * so it is unit-tested with a fake. `createRedisKeyValueStore` is the only
 * place that talks to Redis; importing this module connects to nothing.
 */

import { Redis } from 'ioredis';

import type { EnvSnapshotCache } from './types.js';

const KEY_PREFIX = 'diffprove:env-snapshots';

/** Minimal async key/value contract (satisfied by ioredis in production). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/**
 * `repoFullName` contains a '/', which is not a useful separator inside a flat
 * Redis keyspace; '~' keeps keys readable and unambiguous.
 */
function snapshotKey(repoFullName: string, lockfileKey: string): string {
  return `${KEY_PREFIX}:${repoFullName.replaceAll('/', '~')}:${lockfileKey}`;
}

export function createSnapshotCache(kv: KeyValueStore): EnvSnapshotCache {
  return {
    get: (repoFullName, lockfileKey) => kv.get(snapshotKey(repoFullName, lockfileKey)),
    set: (repoFullName, lockfileKey, templateRef) =>
      kv.set(snapshotKey(repoFullName, lockfileKey), templateRef),
  };
}

/**
 * Redis-backed key/value store. Only this factory opens a connection (ioredis
 * is lazy, but the client is created here and nowhere else).
 *
 * `maxRetriesPerRequest: null` matches the BullMQ connections elsewhere in the
 * codebase: commands wait for the reconnect instead of failing fast.
 */
export function createRedisKeyValueStore(
  redisUrl: string,
): KeyValueStore & { close(): Promise<void> } {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  return {
    get: (key) => redis.get(key),
    set: async (key, value) => {
      await redis.set(key, value);
    },
    close: async () => {
      await redis.quit();
    },
  };
}
