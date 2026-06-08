import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import { COVER_MAX_EDGE, coverObjectKey, reencodeCover } from './coverEncode.ts';

// A 2000x1500 PNG with some structure (so it isn't trivially tiny).
async function makeLargePng(): Promise<Uint8Array> {
  const img = new Image(2000, 1500);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      img.setPixelAt(x + 1, y + 1, Image.rgbToColor((x * 13) % 256, (y * 7) % 256, (x + y) % 256));
    }
  }
  return await img.encode();
}

Deno.test('reencodeCover downscales to the edge cap and shrinks the bytes', async () => {
  const png = await makeLargePng();
  const out = await reencodeCover(png, 'image/png');
  assertEquals(out.ext, 'jpg');
  assertEquals(out.contentType, 'image/jpeg');
  assert(out.bytes.length < png.length, 'expected re-encode to be smaller');
  const decoded = await Image.decode(out.bytes);
  assert(Math.max(decoded.width, decoded.height) <= COVER_MAX_EDGE, 'longest edge capped');
});

Deno.test('reencodeCover passes through undecodable bytes', async () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  const out = await reencodeCover(junk, 'image/webp');
  assertEquals(out.bytes, junk);
  assertEquals(out.ext, 'webp');
});

Deno.test('coverObjectKey is content-addressed and stable', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const a = await coverObjectKey('u1/recipes', 'r1', bytes, 'jpg');
  const b = await coverObjectKey('u1/recipes', 'r1', bytes, 'jpg');
  assertEquals(a, b);
  assert(a.startsWith('u1/recipes/r1-'));
  assert(a.endsWith('.jpg'));
  const other = await coverObjectKey('u1/recipes', 'r1', new Uint8Array([1]), 'jpg');
  assert(a !== other, 'different bytes -> different key');
});
