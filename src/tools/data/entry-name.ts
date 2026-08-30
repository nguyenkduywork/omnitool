// src/tools/data/entry-name.ts — sanitising archive entry names.
//
// Entry names inside an archive are attacker-controlled strings and are never
// trusted verbatim. This neutralises path traversal (leading "../" or "/"
// segments) and Windows drive prefixes ("C:\") by dropping every ".."/"."/
// empty path segment, so a sanitised name can never resolve outside the
// extraction root. Shared by zip-extract and tar-extract so the two can never
// drift apart; tests/fixtures/traversal.zip proves it on the ZIP side.

/**
 * Returns a name that cannot escape the extraction root, or null when nothing
 * safe remains (e.g. the entry was literally "..", "/", or ".").
 */
export function sanitizeEntryName(rawName: string): string | null {
  const normalized = rawName.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '');
  const segments = normalized.split('/').filter((seg) => seg !== '' && seg !== '.' && seg !== '..');
  if (segments.length === 0) return null;
  return segments.join('/');
}
