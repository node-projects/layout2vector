/**
 * Minimal internal PDF object model.
 * Replaces the external `pdf-lite` dependency with a zero-dependency implementation.
 *
 * Supports: PDF 1.4 with Type1 standard fonts, ExtGState, shading (axial + radial),
 * content streams, and single-page documents.
 */

// ── Serializable interface ──────────────────────────────────────────

interface PdfSerializable {
  serialize(): string;
}

// ── PDF Reference ───────────────────────────────────────────────────

export class PdfReference implements PdfSerializable {
  objNum: number;
  gen: number;
  constructor(objNum: number, gen = 0) {
    this.objNum = objNum;
    this.gen = gen;
  }
  serialize(): string {
    return `${this.objNum} ${this.gen} R`;
  }
}

// ── PDF Primitives ──────────────────────────────────────────────────

export class PdfName implements PdfSerializable {
  constructor(public value: string) {}
  serialize(): string {
    return `/${this.value}`;
  }
}

export class PdfNumber implements PdfSerializable {
  constructor(public value: number) {}
  serialize(): string {
    if (Number.isInteger(this.value)) return this.value.toString();
    // Use enough precision but trim trailing zeros
    const s = this.value.toFixed(6);
    return s.replace(/\.?0+$/, "");
  }
}

export class PdfBoolean implements PdfSerializable {
  constructor(public value: boolean) {}
  serialize(): string {
    return this.value ? "true" : "false";
  }
}

export class PdfArray implements PdfSerializable {
  constructor(public items: PdfSerializable[]) {}
  serialize(): string {
    return `[${this.items.map(i => i.serialize()).join(" ")}]`;
  }
}

export class PdfDictionary implements PdfSerializable {
  private entries = new Map<string, PdfSerializable>();

  set(key: string, value: PdfSerializable): void {
    this.entries.set(key, value);
  }

  get(key: string): PdfSerializable | undefined {
    return this.entries.get(key);
  }

  serialize(): string {
    if (this.entries.size === 0) return "<<>>";
    const parts: string[] = [];
    for (const [key, val] of this.entries) {
      parts.push(`/${key} ${val.serialize()}`);
    }
    return `<<${parts.join(" ")}>>`;
  }
}

// ── PDF Stream ──────────────────────────────────────────────────────

export class PdfStream implements PdfSerializable {
  header: PdfDictionary;
  data: string;
  binaryData?: Uint8Array;

  constructor(opts: { header: PdfDictionary; original?: string; binary?: Uint8Array }) {
    this.header = opts.header;
    this.data = opts.original ?? '';
    this.binaryData = opts.binary;
  }

  serialize(): string {
    if (this.binaryData) {
      // Binary streams are handled specially in PdfDocument.buildPdf
      throw new Error("Binary streams must be serialized by PdfDocument.buildPdf");
    }
    const bytes = new TextEncoder().encode(this.data);
    this.header.set("Length", new PdfNumber(bytes.length));
    return `${this.header.serialize()}\nstream\n${this.data}\nendstream`;
  }
}

// ── PDF Indirect Object ─────────────────────────────────────────────

export class PdfIndirectObject {
  content: PdfSerializable;
  objNum = 0;
  reference: PdfReference;

  constructor(opts: { content: PdfSerializable }) {
    this.content = opts.content;
    this.reference = new PdfReference(0);
  }

  /** Serialize the object body (between "N 0 obj" and "endobj"). */
  serializeBody(): string {
    return this.content.serialize();
  }
}

// ── PDF Font ────────────────────────────────────────────────────────

export class PdfFont extends PdfIndirectObject {
  resourceName = "";

  static fromStandardFont(name: string): PdfFont {
    const dict = new PdfDictionary();
    dict.set("Type", new PdfName("Font"));
    dict.set("Subtype", new PdfName("Type1"));
    dict.set("BaseFont", new PdfName(name));
    // Symbolic fonts (ZapfDingbats, Symbol) use their own built-in encoding
    if (name !== "ZapfDingbats" && name !== "Symbol") {
      dict.set("Encoding", new PdfName("WinAnsiEncoding"));
    }
    return new PdfFont({ content: dict });
  }
}

// ── PDF Page ────────────────────────────────────────────────────────

export class PdfPage extends PdfIndirectObject {
  mediaBox: number[] = [];
  contents: PdfReference | null = null;
  resources: PdfReference | null = null;
  parent: PdfPages | null = null;

  constructor() {
    super({ content: new PdfDictionary() });
  }

  override serializeBody(): string {
    const dict = new PdfDictionary();
    dict.set("Type", new PdfName("Page"));
    if (this.parent) dict.set("Parent", this.parent.reference);
    if (this.mediaBox.length === 4) {
      dict.set("MediaBox", new PdfArray(this.mediaBox.map(n => new PdfNumber(n))));
    }
    if (this.resources) dict.set("Resources", this.resources);
    if (this.contents) dict.set("Contents", this.contents);
    return dict.serialize();
  }
}

// ── PDF Pages ───────────────────────────────────────────────────────

export class PdfPages extends PdfIndirectObject {
  kids: PdfArray = new PdfArray([]);
  count = 0;

  constructor() {
    super({ content: new PdfDictionary() });
  }

  override serializeBody(): string {
    const dict = new PdfDictionary();
    dict.set("Type", new PdfName("Pages"));
    dict.set("Kids", this.kids);
    dict.set("Count", new PdfNumber(this.count));
    return dict.serialize();
  }
}

// ── PDF Document ────────────────────────────────────────────────────

export class PdfDocument {
  private objects: PdfIndirectObject[] = [];
  private nextObjNum = 1;
  trailerDict = new PdfDictionary();
  private serialized: Uint8Array | null = null;

  add(obj: PdfIndirectObject): void {
    obj.objNum = this.nextObjNum++;
    obj.reference.objNum = obj.objNum;
    this.objects.push(obj);
  }

  async finalize(): Promise<void> {
    this.serialized = this.buildPdf();
  }

  toBytes(): Uint8Array {
    if (!this.serialized) throw new Error("Call finalize() first");
    return this.serialized;
  }

  private buildPdf(): Uint8Array {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets = new Map<number, number>();
    let pos = 0;

    const write = (s: string): void => {
      const bytes = encoder.encode(s);
      chunks.push(bytes);
      pos += bytes.length;
    };

    const writeBinary = (data: Uint8Array): void => {
      chunks.push(data);
      pos += data.length;
    };

    // Header
    write("%PDF-1.4\n");
    // Binary comment to indicate binary content
    write("%\xE2\xE3\xCF\xD3\n");

    // Body: indirect objects
    for (const obj of this.objects) {
      offsets.set(obj.objNum, pos);
      write(`${obj.objNum} 0 obj\n`);

      // Check for binary stream content
      if (obj.content instanceof PdfStream && obj.content.binaryData) {
        const stream = obj.content;
        const binaryData = stream.binaryData!;
        stream.header.set("Length", new PdfNumber(binaryData.length));
        write(`${stream.header.serialize()}\nstream\n`);
        writeBinary(binaryData);
        write("\nendstream");
      } else {
        write(obj.serializeBody());
      }

      write("\nendobj\n");
    }

    // Cross-reference table
    const xrefOffset = pos;
    const totalObjs = this.nextObjNum; // includes object 0
    write("xref\n");
    write(`0 ${totalObjs}\n`);
    // Object 0: free entry
    write("0000000000 65535 f \n");
    for (let i = 1; i < totalObjs; i++) {
      const offset = offsets.get(i) ?? 0;
      write(`${offset.toString().padStart(10, "0")} 00000 n \n`);
    }

    // Trailer
    this.trailerDict.set("Size", new PdfNumber(totalObjs));
    write("trailer\n");
    write(this.trailerDict.serialize());
    write("\nstartxref\n");
    write(`${xrefOffset}\n`);
    write("%%EOF\n");

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
