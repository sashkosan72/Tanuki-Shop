import {pbkdf2Async} from '@noble/hashes/pbkdf2.js';
import {sha256} from '@noble/hashes/sha2.js';

// Preserve the exact stored PBKDF2 parameters when hosted WebCrypto caps iterations.
export async function derivePassword(password, salt, iterations, subtle = crypto.subtle) {
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 1000000) throw new Error('Invalid password hashing configuration');
  const bytes = new TextEncoder().encode(password);
  try {
    const key = await subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,256));
  } catch (error) {
    if (error.name !== 'NotSupportedError') throw error;
    return pbkdf2Async(sha256, bytes, salt, {c:iterations,dkLen:32,asyncTick:10});
  }
}
