// `deno test supabase/functions/video-import/youtube.test.ts`
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { canonicalYouTubeUrl } from './youtube.ts';

const CANON = 'https://www.youtube.com/watch?v=Oxeyj8gWxmE';

Deno.test('strips share-sheet tracking params (the reported bug)', () => {
  assertEquals(
    canonicalYouTubeUrl('https://youtube.com/watch?v=Oxeyj8gWxmE&si=HMDcW4Am716Pn-QB'),
    CANON,
  );
});

Deno.test('keeps a clean watch url canonical', () => {
  assertEquals(canonicalYouTubeUrl('https://www.youtube.com/watch?v=Oxeyj8gWxmE'), CANON);
});

Deno.test('normalizes youtu.be short links', () => {
  assertEquals(canonicalYouTubeUrl('https://youtu.be/Oxeyj8gWxmE?si=abc'), CANON);
});

Deno.test('normalizes m.youtube.com', () => {
  assertEquals(canonicalYouTubeUrl('https://m.youtube.com/watch?v=Oxeyj8gWxmE&t=42s'), CANON);
});

Deno.test('normalizes /shorts/, /live/, /embed/ paths', () => {
  assertEquals(canonicalYouTubeUrl('https://www.youtube.com/shorts/Oxeyj8gWxmE'), CANON);
  assertEquals(canonicalYouTubeUrl('https://youtube.com/live/Oxeyj8gWxmE?feature=share'), CANON);
  assertEquals(canonicalYouTubeUrl('https://www.youtube.com/embed/Oxeyj8gWxmE'), CANON);
});

Deno.test('drops playlist/index params, keeps only the video id', () => {
  assertEquals(
    canonicalYouTubeUrl('https://www.youtube.com/watch?v=Oxeyj8gWxmE&list=PLxyz&index=3'),
    CANON,
  );
});

Deno.test('returns input unchanged when no valid id can be recovered', () => {
  assertEquals(canonicalYouTubeUrl('https://www.youtube.com/watch?v=tooShort'), 'https://www.youtube.com/watch?v=tooShort');
  assertEquals(canonicalYouTubeUrl('not a url'), 'not a url');
  assertEquals(canonicalYouTubeUrl('https://www.youtube.com/feed/subscriptions'), 'https://www.youtube.com/feed/subscriptions');
});
