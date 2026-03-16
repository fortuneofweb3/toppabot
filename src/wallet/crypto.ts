import crypto from 'node:crypto';

/**
 * Private Key Encryption — AES-256-GCM
 *
 * Encrypts user wallet private keys at rest using a server-side secret.
 * Each key gets a unique random IV for security.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits for GCM

/**
 * Derive a stable 256-bit encryption key from the env var
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!envKey || envKey.length < 16) {
    throw new Error('WALLET_ENCRYPTION_KEY must be set (minimum 16 characters)');
  }
  return crypto.createHash('sha256').update(envKey).digest();
}

/**
 * Encrypt a private key using AES-256-GCM
 */
export function encryptPrivateKey(privateKey: string): {
  encrypted: string;
  iv: string;
  authTag: string;
} {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt a private key using AES-256-GCM
 */
export function decryptPrivateKey(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
