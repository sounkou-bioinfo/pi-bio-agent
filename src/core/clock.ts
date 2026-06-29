// The single, named system-clock adapter: the ONE place the library is allowed to read the wall clock, so an
// ambient timestamp is one auditable, mockable seam instead of scattered `new Date()` fallbacks — the same
// discipline that keeps global fetch confined to index-networked.ts. Every timestamped seam takes an injected
// `now: string`; `systemClock()` is only the LAST-RESORT default when a caller (a test, a bare host entry)
// omits it. The strict endpoint — making `now` required everywhere and removing even this fallback — is
// recorded as a refinement; this funnel is the proportionate step that removes the *hidden* scattered reads.
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
