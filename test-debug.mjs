import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage();

// Capture console from page
page.on('console', msg => console.log('PAGE:', msg.text()));

// Load the page
await page.goto('file:///' + path.resolve(__dirname, 'tests/demos/images.html').replace(/\\/g, '/'));

// Inject library - read from dist
const distDir = path.join(__dirname, 'dist');
const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js')).sort();
let allCode = '';
for (const f of files) {
  let code = fs.readFileSync(path.join(distDir, f), 'utf-8');
  // Strip ESM syntax 
  code = code.replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+(function|class|const|let|var|async)\s/gm, '$1 ')
    .replace(/^import\s+.*$/gm, '// import removed');
  allCode += code + '\n';
}
const script = `(function(){\n${allCode}\nwindow.__HC = { extractIR, extractImageGeometry, isImageElement, preloadImages, renderIR, traverseDOM, flattenStackingOrder, extractStyle, isVisible, createsStackingContext, isSVGElement, isSVGRoot, extractHTMLGeometry, extractSVGSubtree, hasBackgroundImage, extractBackgroundImage, isMathMLRoot, isMathMLElement, extractMathMLFeatures };\n})();`;
await page.addScriptTag({ content: script });

// Check if lib loaded
const hasLib = await page.evaluate(() => typeof window.__HC !== 'undefined' && typeof window.__HC.extractIR === 'function');
console.log('Library loaded:', hasLib);

if (hasLib) {
  // Call extractIR
  const ir = await page.evaluate(() => {
    const root = document.getElementById("root") ?? document.body;
    return window.__HC.extractIR(root, {
      boxType: "border",
      includeText: true,
      includeImages: true,
    });
  });

  const imageNodes = ir.filter(n => n.type === 'image');
  console.log(`Image nodes: ${imageNodes.length}`);
  for (const n of imageNodes) {
    const firstPixels = n.rgbData ? n.rgbData.slice(0, 6) : null;
    console.log(`z=${n.zIndex} w=${n.width}x${n.height} du=${n.dataUrl.substring(0, 25)} rgb=${firstPixels ? firstPixels.join(',') : 'none'}`);
  }
}

await browser.close();
