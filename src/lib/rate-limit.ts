interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

const cleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, bucket] of store.entries()) {
      if (now > bucket.resetAt) store.delete(key);
    }
  },
  10 * 60 * 1000
);
cleanupTimer.unref();

export function checkRateLimit(key: string, maxReqs: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (store.size >= 50_000) {
      for (const [existingKey, existingBucket] of store.entries()) {
        if (now > existingBucket.resetAt) store.delete(existingKey);
      }
      if (store.size >= 50_000) store.delete(store.keys().next().value as string);
    }
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxReqs) return false;
  bucket.count++;
  return true;
}
