/** Local account authority only. Provider approval facts are never cached here. */
export class AccountState {
  private rows = new Map<string, Record<string, SqlStorageValue>[]>();
  readonly sql: SqlStorage;

  constructor(private storage: DurableObjectStorage, source = storage.sql) {
    this.sql = new Proxy(source, { get: (target, property) => {
      if (property !== "exec") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string, ...bindings: SqlStorageValue[]) => {
        // Cache only the account tables owned by this object. Every SQL write,
        // including OAuth refresh and pairing, invalidates before it executes.
        const lookup = !query.includes(";") && /^SELECT\b/i.test(query) && /\bFROM (?:devices|account_integrations|sessions)\b/i.test(query);
        if (query.includes(";") || !/^SELECT\b|^PRAGMA\b/i.test(query)) this.clear();
        if (!lookup) return source.exec(query, ...bindings);
        const expiring = /(?:sessions\.)?expires_at > \?/.test(query);
        const storedQuery = expiring
          ? query.replace(/^SELECT /, "SELECT sessions.expires_at AS _account_expiry, ").replace(/ AND (?:sessions\.)?expires_at > \?/, "")
          : query;
        const arguments_ = expiring ? bindings.slice(0, -1) : bindings;
        const key = JSON.stringify([storedQuery, ...arguments_]);
        let rows = this.rows.get(key);
        if (!rows) {
          rows = source.exec(storedQuery, ...arguments_).toArray();
          // Bound the per-object memory even with many unauthenticated lookups.
          if (this.rows.size >= 1024) this.clear();
          this.rows.set(key, rows);
        }
        const result = structuredClone(expiring ? rows.filter(row => Number(row._account_expiry) > Math.floor(Date.now() / 1000)) : rows)
          .map(row => { delete row._account_expiry; return row; });
        // Callers of the cached lookups use toArray; do not impersonate a SQL
        // cursor or report fabricated cursor accounting for cache hits.
        return { toArray: () => result, [Symbol.iterator]: () => result[Symbol.iterator]() };
      };
    }});
  }

  clear(): void { this.rows.clear(); }

  transaction<T>(callback: () => T): T {
    try { return this.storage.transactionSync(callback); }
    finally { this.clear(); } // A rollback must also discard reads made inside it.
  }
}
