/**
 * WP-2423 Q11: a minimal QR Code Model 2 encoder (ISO/IEC 18004) for printed table codes: byte
 * mode, error correction level M (about 15 % of a dirty or scratched sticker can be lost), the
 * smallest version that fits, and the mask with the lowest penalty. Server-side only; it encodes
 * a public table URL and never a secret.
 */
const eccCodewordsPerBlockM = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const errorCorrectionBlocksM = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** Format information bits for level M. */
const formatBitsM = 0;
/** Bounds-checked read; every index below is inside its array by construction. */
const at = (values: readonly number[], index: number): number => values[index] ?? 0;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
function dataCodewords(version: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    at(eccCodewordsPerBlockM, version) * at(errorCorrectionBlocksM, version)
  );
}
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(at(result, j), root);
      if (j + 1 < result.length) result[j] = at(result, j) ^ at(result, j + 1);
    }
    root = multiply(root, 0x02);
  }
  return result;
}
function remainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    generator.forEach((coefficient, index) => {
      result[index] = at(result, index) ^ multiply(coefficient, factor);
    });
  }
  return result;
}
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

export interface QrMatrix {
  readonly size: number;
  readonly version: number;
  /** modules[y][x], true when dark. */
  readonly modules: readonly (readonly boolean[])[];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 40; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > 40) throw new Error("QR_TEXT_TOO_LONG");
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));

  // Error correction blocks, interleaved.
  const blockCount = at(errorCorrectionBlocksM, version);
  const eccLength = at(eccCodewordsPerBlockM, version);
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  const generator = divisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = remainder(block, generator);
    if (i < shortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i <= shortLength; i++)
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(at(block, i));
    });

  const size = version * 4 + 17;
  // Row-major grids: index y * size + x.
  const modules = new Array<boolean>(size * size).fill(false);
  const reserved = new Array<boolean>(size * size).fill(false);
  const set = (x: number, y: number, dark: boolean) => {
    modules[y * size + x] = dark;
    reserved[y * size + x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
      }
  const positions = alignmentPositions(version);
  positions.forEach((py, i) =>
    positions.forEach((px, j) => {
      const last = positions.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number) => {
    const value = (formatBitsM << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((value << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const value = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((value >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3),
        b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y * size + x] !== true && index < codewords.length * 8) {
          modules[y * size + x] = ((at(codewords, index >>> 3) >>> (7 - (index & 7))) & 1) !== 0;
          index++;
        }
      }
  }
  const masks: readonly ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (mask: number) => {
    const inverts = masks[mask];
    if (inverts === undefined) throw new Error("QR_MASK_INVALID");
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (reserved[y * size + x] !== true && inverts(x, y))
          modules[y * size + x] = modules[y * size + x] !== true;
  };
  const rows = () =>
    Array.from({ length: size }, (_, y) => modules.slice(y * size, (y + 1) * size));
  let best = 0,
    lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(rows());
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return Object.freeze({
    size,
    version,
    modules: Object.freeze(rows().map((row) => Object.freeze(row))),
  });
}

/** ISO 18004 penalty: runs, 2×2 blocks, finder-like patterns, dark/light balance. */
function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push([...(modules[i] ?? [])]);
    lines.push(modules.map((row) => row[i] === true));
  }
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    for (let start = 0; start < size;) {
      let end = start;
      while (end < size && line[end] === line[start]) end++;
      if (end - start >= 5) score += 3 + (end - start - 5);
      start = end;
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (!finder.every((dark, k) => line[i + k] === dark)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
      const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const top = modules[y] ?? [],
        bottom = modules[y + 1] ?? [];
      const dark = top[x];
      if (top[x + 1] === dark && bottom[x] === dark && bottom[x + 1] === dark) score += 3;
    }
  const darkCount = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** An SVG drawing of the matrix with the standard four-module light margin. */
export function renderQrSvg(matrix: QrMatrix, label: string): string {
  const margin = 4;
  const name = label.replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
  const extent = matrix.size + margin * 2;
  let path = "";
  matrix.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" role="img" aria-label="${name}">` +
    `<rect width="${extent}" height="${extent}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
