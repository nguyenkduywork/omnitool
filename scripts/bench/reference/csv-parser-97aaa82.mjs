// scripts/bench/reference/csv-parser-97aaa82.mjs — the implementation as it stood at
// commit 97aaa82, BEFORE the optimisation in 7d0e86d.
//
// This is a golden reference, not duplicated live code: it is pinned to a
// commit and must never be "kept up to date". Its whole job is to be the thing
// the current implementation is checked against, so that "the rewrite did not
// change any answer" stays a fact anyone can re-establish rather than a claim
// in an old commit message.
//
// Extracted verbatim with `git show 97aaa82:src/tools/data/csv-json.op.ts` and stripped of its type
// annotations, which is the only edit made to it.

export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
      if (text[i] === '\n') i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new Error(`unterminated quoted field starting near character ${i}`);
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
