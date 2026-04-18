/**
 * Minimal zlib/deflate inflater sufficient for PNG IDAT chunks.
 * Keeps browser builds free of Node-only decompression dependencies.
 */
export function inflateZlibSync(data: Uint8Array): Uint8Array | null {
  if (data.length < 6) return null;

  const cmf = data[0];
  if ((cmf & 0x0F) !== 8) return null;

  let pos = 2;
  const output: number[] = [];
  let bitBuf = 0;
  let bitCount = 0;

  function readBits(n: number): number {
    while (bitCount < n) {
      if (pos >= data.length) return -1;
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }

    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  }

  function readHuffman(lengths: number[], maxBits: number): number {
    const counts = new Array(maxBits + 1).fill(0);
    for (const length of lengths) {
      if (length > 0) counts[length] += 1;
    }

    const offsets = new Array(maxBits + 2).fill(0);
    for (let index = 1; index <= maxBits; index += 1) {
      offsets[index + 1] = offsets[index] + counts[index];
    }

    const symbols = new Array(lengths.length);
    for (let index = 0; index < lengths.length; index += 1) {
      const length = lengths[index];
      if (length > 0) symbols[offsets[length]++] = index;
    }

    let code = 0;
    let first = 0;
    let symbolIndex = 0;
    for (let bitLength = 1; bitLength <= maxBits; bitLength += 1) {
      code |= readBits(1);
      const count = counts[bitLength];
      if (code < first + count) return symbols[symbolIndex + code - first];
      symbolIndex += count;
      first = (first + count) << 1;
      code <<= 1;
    }

    return -1;
  }

  const fixedLitLen: number[] = [];
  for (let index = 0; index <= 143; index += 1) fixedLitLen.push(8);
  for (let index = 144; index <= 255; index += 1) fixedLitLen.push(9);
  for (let index = 256; index <= 279; index += 1) fixedLitLen.push(7);
  for (let index = 280; index <= 287; index += 1) fixedLitLen.push(8);
  const fixedDist: number[] = new Array(32).fill(5);

  const lenBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const lenExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  let isFinalBlock = 0;
  while (!isFinalBlock) {
    isFinalBlock = readBits(1);
    const blockType = readBits(2);

    if (blockType === 0) {
      bitBuf = 0;
      bitCount = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      for (let index = 0; index < len; index += 1) {
        output.push(data[pos++]);
      }
      continue;
    }

    let litLenLens: number[];
    let distLens: number[];

    if (blockType === 1) {
      litLenLens = fixedLitLen;
      distLens = fixedDist;
    } else if (blockType === 2) {
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      const codeLenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const codeLenLens = new Array(19).fill(0);

      for (let index = 0; index < hclen; index += 1) {
        codeLenLens[codeLenOrder[index]] = readBits(3);
      }

      const allLens: number[] = [];
      while (allLens.length < hlit + hdist) {
        const sym = readHuffman(codeLenLens, 7);
        if (sym < 16) {
          allLens.push(sym);
        } else if (sym === 16) {
          const repeat = readBits(2) + 3;
          const value = allLens[allLens.length - 1] || 0;
          for (let index = 0; index < repeat; index += 1) allLens.push(value);
        } else if (sym === 17) {
          const repeat = readBits(3) + 3;
          for (let index = 0; index < repeat; index += 1) allLens.push(0);
        } else if (sym === 18) {
          const repeat = readBits(7) + 11;
          for (let index = 0; index < repeat; index += 1) allLens.push(0);
        } else {
          return null;
        }
      }

      litLenLens = allLens.slice(0, hlit);
      distLens = allLens.slice(hlit, hlit + hdist);
    } else {
      return null;
    }

    while (true) {
      const sym = readHuffman(litLenLens, 15);
      if (sym < 0) return null;
      if (sym === 256) break;

      if (sym < 256) {
        output.push(sym);
        continue;
      }

      const lenIndex = sym - 257;
      const length = lenBase[lenIndex] + readBits(lenExtra[lenIndex]);
      const distSym = readHuffman(distLens, 15);
      if (distSym < 0) return null;
      const distance = distBase[distSym] + readBits(distExtra[distSym]);
      if (distance > output.length) return null;

      for (let index = 0; index < length; index += 1) {
        output.push(output[output.length - distance]);
      }
    }
  }

  return new Uint8Array(output);
}