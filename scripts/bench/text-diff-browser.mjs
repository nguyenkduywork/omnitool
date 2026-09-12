// Build first. This optional Chromium harness measures the actual production
// worker and UI at normal speed and 4x CPU throttling using real file uploads.
// Timings end at the next animation frame; they are local observations, not CI thresholds.
/* global window, document, requestAnimationFrame, MutationObserver */
import { chromium } from 'playwright';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { preview } from 'vite';
import os from 'node:os';
const url = 'http://127.0.0.1:4175/#/text-diff';
const p95 = a => [...a].sort((x, y) => x - y)[Math.ceil(a.length * .95) - 1] ?? 0;
function typical(total) {
    const count = Math.floor(total / 240);
    const lines = Array.from({ length: count }, (_, i) => `${String(i).padStart(6, '0')} ${'source content '.repeat(8)}`.slice(0, 119));
    const a = lines.join('\n') + '\n';
    lines[Math.floor(count / 2)] = lines[Math.floor(count / 2)].replace('source', 'edited');
    lines[count - 1] = lines[count - 1].replace('source', 'edited');
    return [a, lines.join('\n') + '\n'];
}
const fixtures = [
    ['small prose', ['Launch plan\nMonday\nDesktop support\n', 'Launch plan\nWednesday\nDesktop and mobile support\n']],
    ['source code', [Array.from({ length: 500 }, (_, i) => `export const value${i} = ${i};`).join('\n'), Array.from({ length: 500 }, (_, i) => `export const value${i} = ${i % 7 ? i : i + 1};`).join('\n')]],
    ['repetitive', ['repeat\n'.repeat(20000), 'repeat\n'.repeat(10000) + 'changed\n' + 'repeat\n'.repeat(9999)]],
    ['unrelated', [Array.from({ length: 20000 }, (_, i) => `original-${i}`).join('\n'), Array.from({ length: 20000 }, (_, i) => `revised-${i}`).join('\n')]],
    ['1 MiB typical', typical(1024 * 1024)], ['10 MiB typical', typical(10 * 1024 * 1024)],
    ['200k combined lines', [Array.from({ length: 100000 }, (_, i) => `${i.toString(36)}\n`).join(''), Array.from({ length: 100000 }, (_, i) => `${i % 2 ? 'x' : ''}${i.toString(36)}\n`).join('')]],
    ['minified', ['a'.repeat(512000), 'a'.repeat(255999) + 'b' + 'a'.repeat(256000)]],
    ['long Unicode line', ['a'.repeat(3999) + '😀' + 'e\u0301'.repeat(5000), 'a'.repeat(3999) + '😀' + 'e\u0301'.repeat(4999) + 'Z']],
];
const tempRoot = await mkdtemp(join(os.tmpdir(), 'omnitool-diff-bench-'));
const safeTempRoot = resolve(tempRoot);
let server, browser;
const results = [];
const output = process.argv[2];
try {
    server = await preview({ preview: { host: '127.0.0.1', port: 4175, strictPort: true } });
    browser = await chromium.launch({ headless: true });
    const environment = { os: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGiB: os.totalmem() / 1024 ** 3, node: process.version, browser: browser.version(), viewport: { width: 1440, height: 900 }, comparisonSamples: 3, interactionSamples: 20 };
    for (const rate of [1, 4]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
        for (const [name, pair] of fixtures) {
            const paths = [join(tempRoot, 'original.txt'), join(tempRoot, 'revised.txt')];
            await Promise.all(paths.map((path, i) => writeFile(path, pair[i])));
            const page = await context.newPage();
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate });
            await page.addInitScript(() => {
                window.__diffPerf = { runs: [], tasks: [], events: [] };
                new PerformanceObserver(list => window.__diffPerf.tasks.push(...list.getEntries().map(x => ({ start: x.startTime, duration: x.duration })))).observe({ entryTypes: ['longtask'] });
                const Native = window.Worker;
                window.Worker = class extends Native {
                    constructor(...args) {
                        super(...args);
                        this.addEventListener('message', event => {
                            const msg = event.data, run = window.__diffPerf.runs.findLast(x => x.revision === msg.revision);
                            window.__diffPerf.events.push({ kind: msg.kind, time: performance.now() });
                            if (msg.kind === 'ready' && run)
                                run.ready = performance.now();
                            if (msg.kind === 'window' && run && !run.window) {
                                run.window = performance.now();
                                requestAnimationFrame(() => { run.render = performance.now(); run.rows = document.querySelectorAll('.tdw__row').length; });
                            }
                        });
                    }
                    postMessage(msg, ...args) { if (msg.kind === 'compare')
                        window.__diffPerf.runs.push({ revision: msg.revision, start: performance.now() }); return super.postMessage(msg, ...args); }
                };
            });
            await page.goto(url);
            await page.locator('.tdw[data-ready="true"]').waitFor();
            const runs = [];
            for (let repeat = 0; repeat < 3; repeat++) {
                if (repeat) {
                    await page.getByRole('button', { name: 'Inputs', exact: true }).click();
                    await page.getByRole('button', { name: 'Start over', exact: true }).click();
                }
                const before = await page.evaluate(() => window.__diffPerf.runs.length);
                for (let side = 0; side < 2; side++)
                    await page.locator('.tdw__source input[type=file]').nth(side).setInputFiles(paths[side]);
                await page.waitForFunction(() => [...document.querySelectorAll('.tdw__source-status')].every(n => n.textContent.startsWith('File') && !n.textContent.includes('checking')));
                if (pair[0].length + pair[1].length > 250000 || Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]) > 1024 * 1024)
                    await page.getByRole('button', { name: 'Compare now', exact: true }).click();
                await page.waitForFunction(count => window.__diffPerf.runs.slice(count).some(x => x.render), before, { timeout: 60000 });
                const run = await page.evaluate(count => window.__diffPerf.runs.slice(count).find(x => x.render), before);
                runs.push({ start: run.start, ready: run.ready - run.start, window: run.window - run.start, render: run.render - run.start, rows: run.rows });
            }
            await page.getByRole('button', { name: 'Review changes', exact: true }).click();
            const interactions = await page.evaluate(async () => {
                const timings = [], button = [...document.querySelectorAll('.tdw__toolbar button')].find(x => x.textContent.startsWith('Wrap'));
                for (let i = 0; i < 20; i++) {
                    const start = performance.now();
                    button.click();
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    timings.push(performance.now() - start);
                }
                return timings;
            });
            const navigation = await page.evaluate(async () => {
                const timings = [], rows = document.querySelector('.tdw__rows'), button = [...document.querySelectorAll('.tdw__toolbar button')].find(x => x.textContent === 'Next change');
                if (button.disabled)
                    return timings;
                for (let i = 0; i < 10; i++) {
                    const start = performance.now();
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Navigation did not render')); }, 5000);
                        const observer = new MutationObserver(() => { observer.disconnect(); clearTimeout(timeout); requestAnimationFrame(resolve); });
                        observer.observe(rows, { childList: true });
                        button.click();
                    });
                    timings.push(performance.now() - start);
                }
                return timings;
            });
            const cancellation = [];
            await page.getByRole('button', { name: 'Inputs', exact: true }).click();
            // Clear and Undo make the existing comparison stale through visible
            // controls, leaving Compare now available even for small sources.
            await page.evaluate(() => {
                const buttons = [...document.querySelector('.tdw__source').querySelectorAll('button')];
                buttons.find(x => x.textContent === 'Clear').click();
                buttons.find(x => x.textContent === 'Undo').click();
            });
            for (let i = 0; i < 3; i++) {
                cancellation.push(await page.evaluate(async () => {
                    const buttons = [...document.querySelectorAll('.tdw button')];
                    const compare = buttons.find(x => x.textContent === 'Compare now');
                    if (compare.hidden || compare.disabled)
                        throw new Error('Compare now is not available');
                    compare.click();
                    const cancel = buttons.find(x => x.textContent === 'Cancel comparison');
                    if (cancel.hidden || cancel.disabled)
                        throw new Error('Cancel not available after comparison dispatch');
                    const start = performance.now();
                    cancel.click();
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    return performance.now() - start;
                }));
            }
            const typing = [];
            if (name === 'small prose') {
                const editor = page.getByRole('textbox', { name: 'Original text', exact: true });
                await editor.focus();
                await page.evaluate(() => {
                    window.__diffPerf.typing = [];
                    document.querySelector('.tdw__textarea').addEventListener('input', () => {
                        const start = performance.now();
                        requestAnimationFrame(() => window.__diffPerf.typing.push(performance.now() - start));
                    }, { capture: true });
                });
                for (let i = 0; i < 20; i++) {
                    await editor.press('x');
                    await page.waitForFunction(count => window.__diffPerf.typing.length >= count, i + 1);
                }
                typing.push(...await page.evaluate(() => window.__diffPerf.typing));
            }
            const state = await page.evaluate(() => window.__diffPerf);
            const entry = { name, rate, bytes: Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]), runs, firstWindowP95: p95(runs.map(x => x.render)), wrapP95: p95(interactions), navigationP95: p95(navigation), cancelP95: p95(cancellation), typingP95: typing.length ? p95(typing) : null, longTaskMax: Math.max(0, ...state.tasks.map(x => x.duration)), tasks: state.tasks, events: state.events };
            results.push(entry);
            if (output)
                await writeFile(output, JSON.stringify({ date: new Date().toISOString(), environment, results }, null, 2));
            console.log(`${rate}x ${name}: compare dispatch → first window frame p95 ${entry.firstWindowP95.toFixed(1)}ms; wrap ${entry.wrapP95.toFixed(1)}ms; next change ${entry.navigationP95.toFixed(1)}ms; cancel ${entry.cancelP95.toFixed(1)}ms; typing ${entry.typingP95 === null ? 'n/a' : `${entry.typingP95.toFixed(1)}ms`}; maximum main task ${entry.longTaskMax.toFixed(1)}ms`);
            await page.close();
        }
        await context.close();
    }
    console.log(JSON.stringify({ environment, measurements: results.length }));
}
finally {
    await browser?.close();
    if (server)
        await new Promise(resolveClose => server.httpServer.close(resolveClose));
    if (resolve(tempRoot) === safeTempRoot && safeTempRoot.startsWith(resolve(os.tmpdir()) + sep))
        await rm(safeTempRoot, { recursive: true, force: true });
}
