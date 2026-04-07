import { test } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import type { IRNode } from '../../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const demosDir = path.resolve(__dirname, '..', 'demos');

test('verify shadow DOM text quads fixed', async ({ page }) => {
  const fileUrl = pathToFileURL(path.join(demosDir, 'text.html')).href;
  await page.goto(fileUrl, { waitUntil: 'load' });

  const { injectBoxQuadsPolyfill, injectLibrary } = await import('../helpers.js');
  await injectBoxQuadsPolyfill(page);
  await injectLibrary(page);

  const ir: IRNode[] = await page.evaluate(() => {
    const root = document.getElementById('root') || document.body;
    return (window as any).__HC.extractIR(root, {
      boxType: 'border',
      includeText: true,
      includeImages: true,
    });
  });

  const textNodes = ir.filter(n => n.type === 'text');
  for (const t of textNodes) {
    if (t.type === 'text') {
      const q = t.quad;
      console.log('TEXT: "' + t.text.substring(0, 30) + '" quad[0]=(' + Math.round(q[0].x) + ',' + Math.round(q[0].y) + ') quad[3]=(' + Math.round(q[3].x) + ',' + Math.round(q[3].y) + ')');
    }
  }
});
