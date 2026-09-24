/**
 * Read an 8-bit PNG's samples exactly, without a canvas.
 *
 * A canvas hands back colours, premultiplied and possibly colour-managed; the files this viewer
 * reads carry *data* in their channels — a legend class in a palette index, or a scene's timeline
 * in R and G — and a unit of drift would misread them. So the file is decoded here: chunks, the
 * browser's own zlib inflate, and the five scanline filters. Colour types 0, 2, 3, 4 and 6 at eight
 * bits, no interlacing, which covers everything the pipeline writes.
 */
export interface DecodedPng {
  width: number
  height: number
  /** Samples per pixel: 1 (grey or palette index), 2, 3 (RGB) or 4 (RGBA). */
  channels: number
  data: Uint8Array
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export async function decodePng(buf: Uint8Array): Promise<DecodedPng | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat: Uint8Array<ArrayBuffer>[] = []
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos)
    const kind = String.fromCharCode(...buf.subarray(pos + 4, pos + 8))
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (kind === 'IHDR') {
      width = view.getUint32(pos + 8)
      height = view.getUint32(pos + 12)
      if (body[8] !== 8 || body[12] !== 0) return null // 8-bit, non-interlaced only
      channels = CHANNELS[body[9]] ?? 0
      if (!channels) return null
    } else if (kind === 'IDAT') idat.push(body.slice())
    else if (kind === 'IEND') break
    pos += 12 + len
  }
  if (!width || !height || !idat.length) return null
  const raw = new Uint8Array(
    await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer(),
  )
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[dst + i - channels] : 0
      const b = y ? out[up + i] : 0
      const c = y && i >= channels ? out[up + i - channels] : 0
      let p = 0
      if (f === 1) p = a
      else if (f === 2) p = b
      else if (f === 3) p = (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[dst + i] = (raw[src + i] + p) & 0xff
    }
  }
  return { width, height, channels, data: out }
}

export async function fetchPng(url: string): Promise<DecodedPng | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  return decodePng(new Uint8Array(await res.arrayBuffer()))
}
