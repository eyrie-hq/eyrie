/**
 * A value from a constant table keyed by a name taken from parsed code, or
 * undefined. Plain objects inherit `toString`, `constructor`,
 * `hasOwnProperty` … from `Object.prototype`, so `TABLE[name]` returns a
 * function for those names; only the table's own keys count here.
 */
export function ownValue<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}
