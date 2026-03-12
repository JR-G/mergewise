interface Store {
  save(data: Record<string, unknown>): void
}

function persistData(store: Store, data: Record<string, unknown>): void {
  const enriched = { ...data, timestamp: Date.now() }
  store.save(enriched)
}
