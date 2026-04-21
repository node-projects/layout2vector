import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderIR } from "../dist/pipeline.js";
import { EMFWriter } from "../dist/writers/emf-writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "tests", "output", "paint-emf-probes");

const EMR = {
  HEADER: 0x0001,
  SETWINDOWEXTEX: 0x0009,
  SETWINDOWORGEX: 0x000A,
  EOF: 0x000E,
  SETMAPMODE: 0x0011,
  SETBKMODE: 0x0012,
  SETPOLYFILLMODE: 0x0013,
  INTERSECTCLIPRECT: 0x001E,
  SETTEXTALIGN: 0x0016,
  SETTEXTCOLOR: 0x0018,
  SETWORLDTRANSFORM: 0x0023,
  SELECTOBJECT: 0x0025,
  CREATEPEN: 0x0026,
  CREATEBRUSHINDIRECT: 0x0027,
  DELETEOBJECT: 0x0028,
  ROUNDRECT: 0x002C,
  SAVEDC: 0x0021,
  RESTOREDC: 0x0022,
  BEGINPATH: 0x003B,
  ENDPATH: 0x003C,
  CLOSEFIGURE: 0x003D,
  FILLPATH: 0x003E,
  SELECTCLIPPATH: 0x0043,
  STRETCHDIBITS: 0x0051,
  EXTCREATEFONTINDIRECTW: 0x0052,
  EXTTEXTOUTW: 0x0054,
  POLYGON16: 0x0056,
  POLYLINE16: 0x0057,
  POLYPOLYLINE16: 0x005A,
  POLYPOLYGON16: 0x005B,
};

const RECORD_NAMES = new Map(Object.entries(EMR).map(([name, value]) => [value, name]));
const BOILERPLATE_RECORDS = new Set([
  "HEADER",
  "SETMAPMODE",
  "SETWINDOWORGEX",
  "SETWINDOWEXTEX",
  "SETBKMODE",
  "SETTEXTALIGN",
  "SAVEDC",
  "RESTOREDC",
  "SELECTOBJECT",
  "CREATEPEN",
  "CREATEBRUSHINDIRECT",
  "DELETEOBJECT",
  "SETTEXTCOLOR",
  "EOF",
]);

const SAMPLE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVQIW2P8z8AARAwMjDAGACwBA/+8RVWvAAAAAElFTkSuQmCC";
const SAMPLE_RGB_DATA = [
  255, 0, 0,
  0, 255, 0,
  0, 0, 255,
  255, 255, 0,
];

function rectQuad(x, y, width, height) {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function rotatedRectQuad(x, y, width, height, angleDeg) {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const p0 = { x, y };
  const p1 = { x: x + width * cos, y: y + width * sin };
  const p3 = { x: x - height * sin, y: y + height * cos };
  const p2 = { x: p1.x + (p3.x - p0.x), y: p1.y + (p3.y - p0.y) };
  return [p0, p1, p2, p3];
}

function parseRecordSequence(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let offset = 0;

  while (offset + 8 <= bytes.byteLength) {
    const type = view.getUint32(offset, true);
    const size = view.getUint32(offset + 4, true);
    if (size < 8 || offset + size > bytes.byteLength) break;
    records.push({
      offset,
      type,
      size,
      name: RECORD_NAMES.get(type) ?? `0x${type.toString(16)}`,
    });
    offset += size;
    if (type === EMR.EOF) break;
  }

  return records;
}

function getUniqueInterestingRecordNames(bytes) {
  return [...new Set(
    parseRecordSequence(bytes)
      .map((record) => record.name)
      .filter((name) => !BOILERPLATE_RECORDS.has(name)),
  )];
}

function requireRecord(bytes, type, probeName) {
  const record = parseRecordSequence(bytes).find((entry) => entry.type === type);
  if (!record) {
    throw new Error(`${probeName}: missing expected record ${RECORD_NAMES.get(type) ?? type}`);
  }
  return record;
}

function validateDashedPen(bytes, probeName) {
  const records = parseRecordSequence(bytes).filter((entry) => entry.type === EMR.CREATEPEN);
  const penRecord = records[0];
  if (!penRecord) {
    throw new Error(`${probeName}: missing CREATEPEN record`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const penStyle = view.getUint32(penRecord.offset + 12, true);
  if (penStyle !== 0x0001) {
    throw new Error(`${probeName}: expected PS_DASH pen style, found ${penStyle}`);
  }
}

function validateTallFrame(bytes, probeName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameHeight = view.getInt32(36, true);
  if (frameHeight !== 0xffff) {
    throw new Error(`${probeName}: expected capped tall frame height 65535, found ${frameHeight}`);
  }
}

function createCompoundPathNodes() {
  const outer = [
    { x: 20, y: 20 },
    { x: 180, y: 20 },
    { x: 180, y: 120 },
    { x: 20, y: 120 },
  ];
  const inner = [
    { x: 70, y: 50 },
    { x: 130, y: 50 },
    { x: 130, y: 90 },
    { x: 70, y: 90 },
  ];

  return [{
    type: "polyline",
    points: [...outer, ...inner],
    closed: true,
    style: {
      fill: "#7f8c8d",
      fillRule: "evenodd",
      pathSubpaths: [
        { points: outer, closed: true },
        { points: inner, closed: true },
      ],
    },
    zIndex: 0,
  }];
}

function createSingleClosedPathNodes(fillRule = "nonzero") {
  const points = [
    { x: 20, y: 20 },
    { x: 180, y: 20 },
    { x: 180, y: 120 },
    { x: 20, y: 120 },
  ];

  return [{
    type: "polyline",
    points,
    closed: true,
    style: {
      fill: "#95a5a6",
      fillRule,
      pathSubpaths: [
        { points, closed: true },
      ],
    },
    zIndex: 0,
  }];
}

function createCompoundPathNodesWithFillRule(fillRule = "evenodd") {
  const nodes = createCompoundPathNodes();
  nodes[0].style.fillRule = fillRule;
  return nodes;
}

const probes = [
  {
    name: "01-basic-polygon",
    width: 220,
    height: 140,
    purpose: "Filled polygon only; isolates basic brush, pen, and POLYGON16 output.",
    nodes: [{
      type: "polygon",
      points: rectQuad(20, 20, 180, 100),
      style: { fill: "#2ecc71" },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.POLYGON16, this.name);
    },
  },
  {
    name: "02-basic-text",
    width: 220,
    height: 140,
    purpose: "Text only; isolates EXTCREATEFONTINDIRECTW and EXTTEXTOUTW handling.",
    nodes: [{
      type: "text",
      quad: rectQuad(18, 32, 170, 24),
      text: "Paint text probe",
      style: {
        color: "#111111",
        fontFamily: "Arial",
        fontSize: "18px",
      },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.EXTCREATEFONTINDIRECTW, this.name);
      requireRecord(bytes, EMR.EXTTEXTOUTW, this.name);
    },
  },
  {
    name: "03-polygon-and-text",
    width: 220,
    height: 140,
    purpose: "Simple shape and text together; checks whether Paint fails only once text is combined with normal drawing.",
    nodes: [
      {
        type: "polygon",
        points: rectQuad(20, 20, 180, 100),
        style: { fill: "#f4d03f" },
        zIndex: 0,
      },
      {
        type: "text",
        quad: rectQuad(34, 52, 140, 24),
        text: "Shape + text",
        style: {
          color: "#1f2d3d",
          fontFamily: "Arial",
          fontSize: "18px",
        },
        zIndex: 1,
      },
    ],
    verify(bytes) {
      requireRecord(bytes, EMR.POLYGON16, this.name);
      requireRecord(bytes, EMR.EXTTEXTOUTW, this.name);
    },
  },
  {
    name: "04-roundrect",
    width: 220,
    height: 140,
    purpose: "Rounded rectangle only; isolates ROUNDRECT records.",
    nodes: [{
      type: "polygon",
      points: rectQuad(20, 30, 180, 80),
      style: {
        fill: "#3498db",
        borderRadius: "24px",
      },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.ROUNDRECT, this.name);
    },
  },
  {
    name: "05-clipped-polygon",
    width: 220,
    height: 140,
    purpose: "Polygon clipped with CSS clip-path; isolates path clipping records.",
    nodes: [{
      type: "polygon",
      points: rectQuad(20, 20, 180, 100),
      style: {
        fill: "#e74c3c",
        clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
      },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.BEGINPATH, this.name);
      requireRecord(bytes, EMR.ENDPATH, this.name);
      requireRecord(bytes, EMR.SELECTCLIPPATH, this.name);
    },
  },
  {
    name: "06-bitmap",
    width: 220,
    height: 140,
    purpose: "Bitmap only; isolates STRETCHDIBITS without transforms.",
    nodes: [{
      type: "image",
      quad: rectQuad(50, 30, 120, 80),
      dataUrl: SAMPLE_DATA_URL,
      width: 2,
      height: 2,
      rgbData: SAMPLE_RGB_DATA,
      style: {},
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.STRETCHDIBITS, this.name);
    },
  },
  {
    name: "07-rotated-bitmap",
    width: 220,
    height: 160,
    purpose: "Bitmap with rotation; isolates SETWORLDTRANSFORM plus STRETCHDIBITS.",
    nodes: [{
      type: "image",
      quad: rotatedRectQuad(72, 28, 90, 70, 24),
      dataUrl: SAMPLE_DATA_URL,
      width: 2,
      height: 2,
      rgbData: SAMPLE_RGB_DATA,
      style: {},
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.SETWORLDTRANSFORM, this.name);
      requireRecord(bytes, EMR.STRETCHDIBITS, this.name);
    },
  },
  {
    name: "08-dashed-polyline",
    width: 220,
    height: 140,
    purpose: "Stroke-only dashed line; isolates dashed CREATEPEN style and POLYLINE16 output.",
    nodes: [{
      type: "polyline",
      points: [
        { x: 20, y: 70 },
        { x: 200, y: 70 },
      ],
      closed: false,
      style: {
        stroke: "#8e44ad",
        strokeWidth: "6px",
        strokeDasharray: "16 8",
      },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.POLYLINE16, this.name);
      validateDashedPen(bytes, this.name);
    },
  },
  {
    name: "09-tall-polygon",
    width: 220,
    height: 3000,
    purpose: "Very tall page with shape only; isolates Paint behavior on capped tall-page headers without text.",
    nodes: [{
      type: "polygon",
      points: rectQuad(20, 20, 180, 120),
      style: { fill: "#1abc9c" },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.POLYGON16, this.name);
      validateTallFrame(bytes, this.name);
    },
  },
  {
    name: "10-tall-text",
    width: 220,
    height: 3000,
    purpose: "Very tall page with text only; isolates tall-page header plus EMF text records.",
    nodes: [{
      type: "text",
      quad: rectQuad(20, 40, 160, 24),
      text: "Tall text probe",
      style: {
        color: "#111111",
        fontFamily: "Arial",
        fontSize: "18px",
      },
      zIndex: 0,
    }],
    verify(bytes) {
      requireRecord(bytes, EMR.EXTCREATEFONTINDIRECTW, this.name);
      requireRecord(bytes, EMR.EXTTEXTOUTW, this.name);
      validateTallFrame(bytes, this.name);
    },
  },
  {
    name: "11-evenodd-compound-path",
    width: 220,
    height: 140,
    purpose: "Compound evenodd fill; checks whether Paint fails on multi-subpath fill content without text or images.",
    nodes: createCompoundPathNodes(),
    verify(bytes) {
      requireRecord(bytes, EMR.SETPOLYFILLMODE, this.name);
      requireRecord(bytes, EMR.POLYPOLYGON16, this.name);
    },
  },
  {
    name: "12-single-path-winding-fill",
    width: 220,
    height: 140,
    purpose: "Single closed path filled via POLYPOLYGON16 with winding fill; isolates whether Paint accepts classic polygon-path painting.",
    nodes: createSingleClosedPathNodes("nonzero"),
    verify(bytes) {
      requireRecord(bytes, EMR.SETPOLYFILLMODE, this.name);
      requireRecord(bytes, EMR.POLYPOLYGON16, this.name);
    },
  },
  {
    name: "13-single-path-evenodd-fill",
    width: 220,
    height: 140,
    purpose: "Single closed path filled via POLYPOLYGON16 with evenodd fill; isolates whether Paint rejects ALTERNATE fill mode even without compound geometry.",
    nodes: createSingleClosedPathNodes("evenodd"),
    verify(bytes) {
      requireRecord(bytes, EMR.SETPOLYFILLMODE, this.name);
      requireRecord(bytes, EMR.POLYPOLYGON16, this.name);
    },
  },
  {
    name: "14-compound-path-winding-fill",
    width: 220,
    height: 140,
    purpose: "Compound path filled with winding fill; isolates whether the failure needs multiple subpaths or specifically evenodd compound filling.",
    nodes: createCompoundPathNodesWithFillRule("nonzero"),
    verify(bytes) {
      requireRecord(bytes, EMR.SETPOLYFILLMODE, this.name);
      requireRecord(bytes, EMR.POLYPOLYGON16, this.name);
    },
  },
];

function buildManifestMarkdown(entries) {
  const lines = [
    "# Paint EMF Probes",
    "",
    "Open each .emf file in Paint and note whether it opens at all.",
    "",
    "Reply with lines like:",
    "- 01-basic-polygon: works",
    "- 02-basic-text: fails",
    "",
    "Files:",
  ];

  for (const entry of entries) {
    lines.push(`- ${entry.file}: ${entry.purpose} Key records: ${entry.keyRecords.join(", ") || "none"}.`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const manifestEntries = [];
  for (const probe of probes) {
    const writer = new EMFWriter({ width: probe.width, height: probe.height });
    const bytes = await renderIR(probe.nodes, writer);
    probe.verify(bytes);

    const file = `${probe.name}.emf`;
    const filePath = path.join(outputDir, file);
    fs.writeFileSync(filePath, bytes);

    manifestEntries.push({
      file,
      width: probe.width,
      height: probe.height,
      purpose: probe.purpose,
      keyRecords: getUniqueInterestingRecordNames(bytes),
    });
  }

  fs.writeFileSync(
    path.join(outputDir, "manifest.json"),
    `${JSON.stringify(manifestEntries, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    buildManifestMarkdown(manifestEntries),
    "utf8",
  );

  console.log(`Wrote ${manifestEntries.length} EMF probes to ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});