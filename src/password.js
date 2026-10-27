const encoder = new TextEncoder();
export const PASSWORD_ITERATIONS = 100000;
export const PASSWORD_SCHEME = 'pbkdf2-sha256-hmac-v1$';
export function isCurrentPassword(hash) { return typeof hash === 'string' && /^pbkdf2-sha256-hmac-v1\$[0-9a-f]{64}$/.test(hash); }
export async function derivePassword(password, salt, iterations, pepper, subtle = crypto.subtle) {
  if (iterations !== PASSWORD_ITERATIONS) throw new Error('Password reset required for legacy hash');
  if (typeof pepper !== 'string' || !/^[0-9a-f]{64}$/.test(pepper)) throw new Error('Password secret is not configured');
  const key = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = await subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,256);
  const pepperBytes = Uint8Array.from(pepper.match(/../g), x => parseInt(x,16));
  const hmacKey = await subtle.importKey('raw',pepperBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const protectedHash = new Uint8Array(await subtle.sign('HMAC',hmacKey,digest));
  return PASSWORD_SCHEME + Array.from(protectedHash,x=>x.toString(16).padStart(2,'0')).join('');
}
