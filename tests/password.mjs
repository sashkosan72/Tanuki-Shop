import assert from 'node:assert/strict';
import {pbkdf2Sync,createHmac,webcrypto} from 'node:crypto';
import {derivePassword,isCurrentPassword,PASSWORD_SCHEME} from '../src/password.js';
const pepper='ab'.repeat(32),salt=new Uint8Array(16).fill(17);
for(const password of ['test-password-2026','Тестовий-пароль-🦝']) {
 const hash=await derivePassword(password,salt,100000,pepper,webcrypto.subtle);
 const expected=PASSWORD_SCHEME+createHmac('sha256',Buffer.from(pepper,'hex')).update(pbkdf2Sync(password,salt,100000,32,'sha256')).digest('hex');
 assert.equal(hash,expected);assert.ok(isCurrentPassword(hash));
 assert.notEqual(hash,await derivePassword(password,salt,100000,'cd'.repeat(32),webcrypto.subtle));
}
await assert.rejects(derivePassword('test',salt,180000,pepper));
await assert.rejects(derivePassword('test',salt,100000,''));
assert.equal(isCurrentPassword('ab'.repeat(32)),false);
console.log('PASS: versioned PBKDF2 + separate HMAC pepper, Unicode, changed/missing key and legacy guards');
