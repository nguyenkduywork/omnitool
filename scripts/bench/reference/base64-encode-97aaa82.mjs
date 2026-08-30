// scripts/bench/reference/base64-encode-97aaa82.mjs — the implementation as it stood at
// commit 97aaa82, BEFORE the optimisation in 7d0e86d.
//
// This is a golden reference, not duplicated live code: it is pinned to a
// commit and must never be "kept up to date". Its whole job is to be the thing
// the current implementation is checked against, so that "the rewrite did not
// change any answer" stays a fact anyone can re-establish rather than a claim
// in an old commit message.
//
// Extracted verbatim with `git show 97aaa82:src/tools/data/base64.op.ts` and stripped of its type
// annotations, which is the only edit made to it.

const CHUNK_SIZE = 0x8000;

function bytesToBinaryString(bytes) {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

/** The pre-optimisation encode route, end to end: bytes -> base64 -> bytes. */
export function encodeBase64(bytes) {
  return new TextEncoder().encode(btoa(bytesToBinaryString(bytes)));
}
