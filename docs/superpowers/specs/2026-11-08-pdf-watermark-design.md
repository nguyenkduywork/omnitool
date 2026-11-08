# PDF merge and text watermarks

The requested merge workflow already exists as `pdf-merge`: multiple PDFs are combined in file-tray order and downloaded as `merged.pdf`. Preserve it and verify the production flow.

Add `pdf-watermark` alongside the PDF tools. Use the existing declarative options panel and worker loader so it is searchable, bookmarkable, batch-capable, and available for result reuse. Stamp every page with editable single-line text; offer diagonal, centre, and four corner positions, relative text size, and opacity. Default to CONFIDENTIAL, diagonal, 6% of the shorter page side, and 35% opacity in black. Reuse the stamp icon.

Approaches considered: rasterizing pages would discard selectable text and add rendering cost; drawing PDF text with the already installed pdf-lib preserves the original content and needs no new dependency. Choose pdf-lib and the existing options panel. No new editor or network service is needed.

Fit long labels within each visible page. Position relative to the visible crop box, respecting page rotation. Preserve page dimensions, rotation, and document metadata. Return one `<source>-watermarked.pdf` per input. Reject empty, multiline, or unsupported font characters with an actionable InvalidOptions error. Use the built-in Helvetica Bold font and document its Latin-text limitation.

Validate input magic bytes, name corrupt/password-protected files in typed errors, report monotonic progress per page and file, and honour cancellation before completion. Tests cover output bytes, all positions, crop/rotation, fitting, invalid options, corrupt/encrypted files, cancellation, and the existing merge flow. No dependency changes or visual redesign.

User preference: text watermarks (confirmed in chat). Defaults and placement controls are implementation choices within the requested feature.
