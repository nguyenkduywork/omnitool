// Types for the golden reference, so tests/unit/data.test.ts can import it
// under `strict` without the reference itself having to be TypeScript — it is
// a frozen copy of an old commit, and editing it (even to annotate it) would
// defeat the point of pinning it.

export declare function parseCsv(text: string, delimiter: string): string[][];
