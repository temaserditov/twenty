export async function processNext(store, twenty) {
  const row = store.next();
  if (!row) return 'idle';
  const event = JSON.parse(row.payload);
  if (store.isStale(event)) { store.finish(row, true); return 'stale'; }
  try {
    await twenty.apply(event);
    store.finish(row);
    return 'applied';
  } catch {
    store.retry(row);
    // Do not log payloads, tokens, provider responses or customer identifiers.
    return 'retry';
  }
}
