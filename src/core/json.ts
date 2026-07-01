// The JSON value/schema types shared across specs (resource params, operation input/output schemas, run I/O).
// These lived in tool-spec.ts; that file's BioToolSpec self-description machinery was removed (a hand-maintained,
// unenforced, drifted catalog of the agent's own tools), so the still-used JSON types live here on their own.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue | undefined };
