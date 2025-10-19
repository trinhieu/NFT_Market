function u32ToRGB(n: number) {
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return [r, g, b] as const;
}

export function drawNftToCanvas(
  pixels: Uint8Array,
  palette: number[],
  canvas: HTMLCanvasElement,
  scale = 28 // 9*28 = 252 ≈ khít khung 256px
) {
  if (!pixels || pixels.length !== 81) throw new Error("pixels must be 81 bytes (9×9)");
  if (!palette || palette.length !== 32) throw new Error("palette must be 32 colors");

  const size = 9; // 9×9
  const base = document.createElement("canvas");
  base.width = size; base.height = size;

  const bctx = base.getContext("2d");
  if (!bctx) throw new Error("Cannot get 2D context");

  const img = bctx.createImageData(size, size);

  for (let i = 0; i < 81; i++) {
    const idx = pixels[i]!;
    if (idx < 0 || idx >= 32) throw new Error("pixel index out of range 0..31");
    const [r, g, b] = u32ToRGB(palette[idx]!);
    const off = i * 4;
    img.data[off] = r;
    img.data[off + 1] = g;
    img.data[off + 2] = b;
    img.data[off + 3] = 255;
  }

  bctx.putImageData(img, 0, 0);

  canvas.width = size * scale;
  canvas.height = size * scale;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot get 2D context");

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
}
