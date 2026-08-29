// src/main.ts — the entry point. Boots the shell and nothing else.
//
// Nothing heavy is imported here, statically or otherwise: the engines
// (pdf-lib, pdfjs-dist, fflate, qrcode) are reached only through the registry's
// lazy `load()` thunks, and `core/pipeline` is itself dynamically imported by the
// shell. That is what holds the §1 budget: initial JS <= 40 KB gzip.

import './styles/tokens.css';
import './styles/app.css';
import { mountShell } from './ui/shell';

const root = document.getElementById('app');
if (!root) throw new Error('omnitool: #app is missing from index.html');

mountShell(root);
