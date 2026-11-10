import nacl from "tweetnacl";
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fill = (length: number, seed: number): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (seed * 31 + i * 7) & 255;
  return out;
};
const sk1 = fill(32, 1);
const sk2 = fill(32, 2);
const kp1 = nacl.box.keyPair.fromSecretKey(sk1);
const kp2 = nacl.box.keyPair.fromSecretKey(sk2);
const shared = nacl.box.before(kp2.publicKey, kp1.secretKey);
const sharedBack = nacl.box.before(kp1.publicKey, kp2.secretKey);
const nonce = fill(nacl.box.nonceLength, 3);
const message = new TextEncoder().encode("hello relay, 你好");
const sealed = nacl.box.after(message, nonce, shared);
const opened = nacl.box.open.after(sealed, nonce, sharedBack);
const tampered = new Uint8Array(sealed);
tampered[0] ^= 1;
const scalar = nacl.scalarMult(sk1, kp2.publicKey);
const random = nacl.randomBytes(16);
const fresh = nacl.box.keyPair();
console.log(JSON.stringify({
  pk1: hex(kp1.publicKey),
  shared: hex(shared),
  sharedMatches: hex(shared) === hex(sharedBack),
  sealed: hex(sealed),
  opened: opened ? new TextDecoder().decode(opened) : null,
  tamperedOpens: nacl.box.open.after(tampered, nonce, sharedBack) !== null,
  scalar: hex(scalar),
  verifySame: nacl.verify(shared, sharedBack),
  verifyDifferent: nacl.verify(shared, scalar),
  lengths: [random.length, fresh.publicKey.length, fresh.secretKey.length, nacl.box.sharedKeyLength],
}));
