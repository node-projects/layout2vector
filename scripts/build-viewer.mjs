/**
 * Build a PDF viewer HTML page by embedding base64 PDF data.
 * Run: node --loader ts-node/esm scripts/build-viewer.mjs
 */
import fs from "node:fs";
import path from "node:path";

const outputDir = "tests/output";
const files = fs.readdirSync(outputDir).filter((f) => f.endsWith(".pdf")).sort();

const pdfData = {};
for (const file of files) {
  const data = fs.readFileSync(path.join(outputDir, file));
  pdfData[path.basename(file, ".pdf")] = data.toString("base64");
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PDF Viewer</title>
<style>
body { font-family: Arial, sans-serif; margin: 20px; background: #eee; }
.pdf-section { margin: 20px 0; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
h2 { color: #333; margin: 0 0 10px; }
canvas { border: 1px solid #ccc; display: block; }
</style>
</head><body>
<h1>Generated PDFs</h1>
${files.map((f) => {
  const name = path.basename(f, ".pdf");
  return `<div class="pdf-section"><h2>${name}</h2><canvas id="c_${name}"></canvas></div>`;
}).join("\n")}
<script type="module">
import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";

const pdfs = ${JSON.stringify(pdfData)};

for (const [name, b64] of Object.entries(pdfs)) {
  const raw = atob(b64);
  const data = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
  try {
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const scale = 1.5;
    const viewport = page.getViewport({ scale });
    const canvas = document.getElementById("c_" + name);
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (e) {
    console.error(name, e);
    document.getElementById("c_" + name).parentElement.innerHTML += "<p style='color:red'>Error: " + e.message + "</p>";
  }
}
</script>
</body></html>`;

fs.writeFileSync(path.join(outputDir, "viewer.html"), html);
console.log("Created viewer.html with", files.length, "PDFs embedded");
