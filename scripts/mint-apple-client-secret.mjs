#!/usr/bin/env node
// Mint the JWT that Apple's OAuth endpoint accepts as a client secret for
// Sign in with Apple. Pastes straight into Supabase's Apple provider
// "Secret Key" field. Valid up to 180 days — set a calendar reminder to
// rotate before then.
//
// Usage:
//   node scripts/mint-apple-client-secret.mjs \
//     --key-id <KID> --team-id <TID> --services-id <SID> --p8 <path>
//
// Defaults are baked in for CookYourBooks.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const keyId = arg('key-id', 'C6TC9BBRGJ');
const teamId = arg('team-id', 'YNDYJ3A9CQ');
const servicesId = arg('services-id', 'app.cookyourbooks.web');
const p8Path = resolve(
  arg('p8', `${homedir()}/.appstoreconnect/AuthKey_${keyId}.p8`),
);

const now = Math.floor(Date.now() / 1000);
const expSeconds = 86400 * 180; // Apple's hard cap.

const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
const payload = {
  iss: teamId,
  iat: now,
  exp: now + expSeconds,
  aud: 'https://appleid.apple.com',
  sub: servicesId,
};

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const headerB64 = b64url(JSON.stringify(header));
const payloadB64 = b64url(JSON.stringify(payload));
const signingInput = `${headerB64}.${payloadB64}`;

const privateKey = readFileSync(p8Path, 'utf8');
const signer = createSign('SHA256');
signer.update(signingInput);
const derSig = signer.sign(privateKey);

// Node's ECDSA sign output is DER (SEQUENCE { INTEGER r, INTEGER s });
// JWS ES256 wants the raw concatenation r||s, each padded to 32 bytes.
function derToJoseEs256(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('expected SEQUENCE');
  if (der[i] & 0x80) i += (der[i] & 0x7f) + 1;
  else i += 1;
  if (der[i++] !== 0x02) throw new Error('expected r INTEGER');
  let rLen = der[i++];
  let r = der.slice(i, i + rLen);
  i += rLen;
  if (der[i++] !== 0x02) throw new Error('expected s INTEGER');
  let sLen = der[i++];
  let s = der.slice(i, i + sLen);

  // Strip leading zero pad that DER adds for sign-bit safety.
  if (r[0] === 0x00 && r.length > 32) r = r.slice(1);
  if (s[0] === 0x00 && s.length > 32) s = s.slice(1);
  // Left-pad to 32 bytes if shorter.
  const rPad = Buffer.concat([Buffer.alloc(32 - r.length), r]);
  const sPad = Buffer.concat([Buffer.alloc(32 - s.length), s]);
  return Buffer.concat([rPad, sPad]);
}

const sigB64 = b64url(derToJoseEs256(derSig));
const jwt = `${signingInput}.${sigB64}`;

const expIso = new Date((now + expSeconds) * 1000).toISOString();
process.stderr.write(
  `Signed with kid=${keyId} for sub=${servicesId} iss=${teamId}\n` +
    `Expires ${expIso} (${Math.floor(expSeconds / 86400)} days)\n` +
    `Paste below into Supabase → Auth → Providers → Apple → Secret Key:\n\n`,
);
process.stdout.write(jwt + '\n');
