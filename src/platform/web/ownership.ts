/**
 * Cross-tab active-session ownership.
 *
 * Web Locks are preferred when present. A transactionally acquired IndexedDB
 * lease is always maintained as the durable fence used by checkpoint writes;
 * BroadcastChannel only announces state changes and is never the lock.
 */

import { requestResult, withTransaction } from './database.js';
import { STORES } from './migrations.js';

export const OWNERSHIP_CHANNEL = 'flashfinger-session-ownership';
export const DEFAULT_LEASE_TTL_MS = 15_000;

export interface OwnershipToken {
  readonly profileId: string;
  readonly ownerId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly expiresAt: number;
}

interface LeaseRecord extends OwnershipToken {
  readonly key: string;
  readonly updatedAt: number;
}

export class OwnershipConflictError extends Error {
  constructor(message = 'Another browser tab owns the active session') {
    super(message);
    this.name = 'OwnershipConflictError';
  }
}

export interface LeaseOptions {
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly ttlMs?: number;
}

function leaseKey(profileId: string): string {
  return `sessionLease:${profileId}`;
}

function optionsWithDefaults(options: LeaseOptions): Required<LeaseOptions> {
  return {
    now: options.now ?? (() => Date.now()),
    randomUUID: options.randomUUID ?? (() => crypto.randomUUID()),
    ttlMs: options.ttlMs ?? DEFAULT_LEASE_TTL_MS,
  };
}

async function readLeaseFromStore(
  store: IDBObjectStore,
  profileId: string,
): Promise<LeaseRecord | undefined> {
  return requestResult<LeaseRecord | undefined>(store.get(leaseKey(profileId)));
}

function tokenMatches(record: LeaseRecord, token: OwnershipToken): boolean {
  return record.profileId === token.profileId
    && record.ownerId === token.ownerId
    && record.leaseId === token.leaseId
    && record.fence === token.fence;
}

function toToken(record: LeaseRecord): OwnershipToken {
  const { profileId, ownerId, leaseId, fence, expiresAt } = record;
  return { profileId, ownerId, leaseId, fence, expiresAt };
}

/** Atomic compare-and-set acquisition used when Web Locks are unavailable. */
export async function acquireLease(
  database: IDBDatabase,
  profileId: string,
  ownerId: string,
  options: LeaseOptions = {},
): Promise<OwnershipToken | null> {
  const resolved = optionsWithDefaults(options);
  return withTransaction(database, [STORES.metadata], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.metadata);
    const current = await readLeaseFromStore(store, profileId);
    const now = resolved.now();

    if (current && current.expiresAt > now && current.ownerId !== ownerId) return null;

    const sameOwner = current?.ownerId === ownerId && current.expiresAt > now;
    const record: LeaseRecord = {
      key: leaseKey(profileId),
      profileId,
      ownerId,
      leaseId: sameOwner ? current.leaseId : resolved.randomUUID(),
      fence: sameOwner ? current.fence : (current?.fence ?? 0) + 1,
      updatedAt: now,
      expiresAt: now + resolved.ttlMs,
    };
    await requestResult(store.put(record));
    return toToken(record);
  });
}

export async function renewLease(
  database: IDBDatabase,
  token: OwnershipToken,
  options: LeaseOptions = {},
): Promise<OwnershipToken | null> {
  const resolved = optionsWithDefaults(options);
  return withTransaction(database, [STORES.metadata], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.metadata);
    const current = await readLeaseFromStore(store, token.profileId);
    const now = resolved.now();
    if (!current || !tokenMatches(current, token) || current.expiresAt <= now) return null;
    const renewed: LeaseRecord = { ...current, updatedAt: now, expiresAt: now + resolved.ttlMs };
    await requestResult(store.put(renewed));
    return toToken(renewed);
  });
}

export async function checkLease(
  database: IDBDatabase,
  token: OwnershipToken,
  now: () => number = () => Date.now(),
): Promise<boolean> {
  return withTransaction(database, [STORES.metadata], 'readonly', async (transaction) => {
    const current = await readLeaseFromStore(transaction.objectStore(STORES.metadata), token.profileId);
    return current !== undefined && current.expiresAt > now() && tokenMatches(current, token);
  });
}

export async function releaseLease(database: IDBDatabase, token: OwnershipToken): Promise<boolean> {
  return withTransaction(database, [STORES.metadata], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.metadata);
    const current = await readLeaseFromStore(store, token.profileId);
    if (!current || !tokenMatches(current, token)) return false;
    await requestResult(store.delete(current.key));
    return true;
  });
}

/** Verify a token inside the caller's transaction, fencing stale checkpoint writers. */
export async function assertLeaseForWrite(
  metadata: IDBObjectStore,
  token: OwnershipToken,
  now: number,
): Promise<void> {
  const current = await readLeaseFromStore(metadata, token.profileId);
  if (!current || current.expiresAt <= now || !tokenMatches(current, token)) {
    throw new OwnershipConflictError('The active-session ownership token is stale');
  }
}

/** Verify and renew a lease in the same transaction as a checkpoint write. */
export async function renewLeaseForWrite(
  metadata: IDBObjectStore,
  token: OwnershipToken,
  now: number,
  ttlMs = DEFAULT_LEASE_TTL_MS,
): Promise<OwnershipToken> {
  const current = await readLeaseFromStore(metadata, token.profileId);
  if (!current || current.expiresAt <= now || !tokenMatches(current, token)) {
    throw new OwnershipConflictError('The active-session ownership token is stale');
  }
  const renewed: LeaseRecord = { ...current, updatedAt: now, expiresAt: now + ttlMs };
  await requestResult(metadata.put(renewed));
  return toToken(renewed);
}

export interface OwnershipCoordinatorOptions extends LeaseOptions {
  readonly ownerId?: string;
  readonly forceLeaseFallback?: boolean;
  readonly lockManager?: LockManager | null;
  readonly channelFactory?: ((name: string) => BroadcastChannel) | null;
}

export class BrowserSessionOwnership {
  readonly ownerId: string;
  private readonly leaseOptions: LeaseOptions;
  private readonly lockManager: LockManager | null;
  private readonly channelFactory: ((name: string) => BroadcastChannel) | null;
  private readonly webLockReleases = new Map<string, () => void>();
  private channel: BroadcastChannel | null = null;

  constructor(
    private readonly database: IDBDatabase,
    options: OwnershipCoordinatorOptions = {},
  ) {
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.leaseOptions = { now: options.now, randomUUID: options.randomUUID, ttlMs: options.ttlMs };
    const browserLocks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    this.lockManager = options.forceLeaseFallback ? null : (options.lockManager ?? browserLocks ?? null);
    this.channelFactory = options.channelFactory === undefined
      ? (typeof BroadcastChannel === 'undefined' ? null : (name) => new BroadcastChannel(name))
      : options.channelFactory;
  }

  private broadcast(profileId: string, action: 'acquired' | 'renewed' | 'released'): void {
    try {
      if (!this.channel && this.channelFactory) this.channel = this.channelFactory(OWNERSHIP_CHANNEL);
      this.channel?.postMessage({ profileId, ownerId: this.ownerId, action });
    } catch {
      // Notifications are best effort and never affect lock correctness.
    }
  }

  private async acquireWebLock(profileId: string): Promise<boolean> {
    if (!this.lockManager) return true;
    const name = `flashfinger:session:${profileId}`;
    let releaseHold: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    let report: ((acquired: boolean) => void) | undefined;
    const acquired = new Promise<boolean>((resolve) => { report = resolve; });

    void this.lockManager.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      report?.(lock !== null);
      if (lock) await hold;
    });
    const didAcquire = await acquired;
    if (didAcquire && releaseHold) this.webLockReleases.set(profileId, releaseHold);
    return didAcquire;
  }

  async acquire(profileId: string): Promise<OwnershipToken | null> {
    if (!(await this.acquireWebLock(profileId))) return null;
    try {
      const token = await acquireLease(this.database, profileId, this.ownerId, this.leaseOptions);
      if (!token) {
        this.webLockReleases.get(profileId)?.();
        this.webLockReleases.delete(profileId);
      } else {
        this.broadcast(profileId, 'acquired');
      }
      return token;
    } catch (error) {
      this.webLockReleases.get(profileId)?.();
      this.webLockReleases.delete(profileId);
      throw error;
    }
  }

  async renew(token: OwnershipToken): Promise<OwnershipToken | null> {
    const renewed = await renewLease(this.database, token, this.leaseOptions);
    if (renewed) this.broadcast(token.profileId, 'renewed');
    return renewed;
  }

  async owns(token: OwnershipToken): Promise<boolean> {
    return checkLease(this.database, token, this.leaseOptions.now);
  }

  async release(token: OwnershipToken): Promise<boolean> {
    let released = false;
    try {
      released = await releaseLease(this.database, token);
    } finally {
      this.webLockReleases.get(token.profileId)?.();
      this.webLockReleases.delete(token.profileId);
    }
    if (released) this.broadcast(token.profileId, 'released');
    return released;
  }

  close(): void {
    for (const release of this.webLockReleases.values()) release();
    this.webLockReleases.clear();
    this.channel?.close();
    this.channel = null;
  }
}
