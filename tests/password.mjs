import assert from 'node:assert/strict';
import {pbkdf2Sync, webcrypto} from 'node:crypto';
import {derivePassword} from '../src/password.js';
const capped = {importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle), deriveBits: async () => {throw new DOMException('Hosted PBKDF2 iteration cap', 'NotSupportedError');}};
for (const password of ['test-password-2026', 'Тестовий-пароль-🦝']) {
  const salt = new Uint8Array(16).fill(17);
  const expected = pbkdf2Sync(password,salt,180000,32,'sha256');
  assert.deepEqual(Buffer.from(await derivePassword(password,salt,180000,capped)),expected);
  assert.deepEqual(Buffer.from(await derivePassword(password,salt,180000,webcrypto.subtle)),expected);
}
await assert.rejects(derivePassword('test',new Uint8Array(16),99999));
console.log('PASS: native and capped-runtime fallback match Node PBKDF2 at 180000 iterations');
