/**
 * Reads an optional property of an internal object only if it is an own property, so a polluted
 * `Object.prototype` (`where`, `select`, `take`, `skip`...) can never feed values into a query.
 */
export function own<T extends object, K extends keyof T>(source: T, key: K): T[K] | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}
