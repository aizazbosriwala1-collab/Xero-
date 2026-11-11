import crypto from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger('EncryptionService');

export class EncryptionService {
  private key: Buffer;
  private keyVersion: string;

  constructor() {
    this.keyVersion = process.env.DELIVERY_ENCRYPTION_KEY_VERSION || 'v1';
    const rawKey = process.env.DELIVERY_ENCRYPTION_KEY;

    if (rawKey && rawKey.trim()) {
      this.key = EncryptionService.decodeAndValidateKey(rawKey);
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('FATAL: DELIVERY_ENCRYPTION_KEY environment variable is required in production and must decode to exactly 32 bytes (64 hex characters)');
      }
      // Isolated test/dev deterministic 32-byte key (64 hex chars)
      this.key = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
    }
  }

  /**
   * Decodes and validates an unambiguous encoded 32-byte key.
   * Preferred: 64 hexadecimal characters representing exactly 32 bytes.
   * Also supports base64 encoding if it decodes to exactly 32 bytes.
   * Strictly enforces decodedBuffer.length === 32 and rejects malformed encoding.
   */
  public static decodeAndValidateKey(encodedKey?: string): Buffer {
    if (!encodedKey || typeof encodedKey !== 'string' || !encodedKey.trim()) {
      throw new Error('DELIVERY_ENCRYPTION_KEY is required and must not be empty');
    }

    const trimmed = encodedKey.trim();

    // 1. Strict Hex Validation (preferred: 64 hex characters = 32 bytes)
    const isHex = /^[0-9a-fA-F]+$/.test(trimmed);
    if (isHex) {
      if (trimmed.length % 2 !== 0) {
        throw new Error(`Invalid DELIVERY_ENCRYPTION_KEY: malformed hex encoding with odd length (${trimmed.length} characters)`);
      }
      const buf = Buffer.from(trimmed, 'hex');
      if (buf.length < 32) {
        throw new Error(`Invalid DELIVERY_ENCRYPTION_KEY: decoded key is too short (expected 32 bytes, received ${buf.length} bytes)`);
      }
      if (buf.length > 32) {
        throw new Error(`Invalid DELIVERY_ENCRYPTION_KEY: decoded key is too long (expected 32 bytes, received ${buf.length} bytes)`);
      }
      return buf;
    }

    // 2. Base64 Validation
    const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
    if (isBase64) {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length < 32) {
        throw new Error(`Invalid DELIVERY_ENCRYPTION_KEY: decoded key is too short (expected 32 bytes, received ${buf.length} bytes)`);
      }
      if (buf.length > 32) {
        throw new Error(`Invalid DELIVERY_ENCRYPTION_KEY: decoded key is too long (expected 32 bytes, received ${buf.length} bytes)`);
      }
      return buf;
    }

    // 3. Neither valid hex nor valid base64
    throw new Error('Invalid DELIVERY_ENCRYPTION_KEY: malformed encoding. Must be a 64-character hex string representing exactly 32 bytes.');
  }

  /**
   * Validate key at application startup.
   */
  public validateKeyAtStartup(): { valid: boolean; version: string; keyLength: number } {
    const rawKey = process.env.DELIVERY_ENCRYPTION_KEY;
    if (process.env.NODE_ENV === 'production') {
      if (!rawKey || !rawKey.trim()) {
        throw new Error('FATAL: DELIVERY_ENCRYPTION_KEY environment variable is required in production and must decode to exactly 32 bytes (64 hex characters)');
      }
      const decoded = EncryptionService.decodeAndValidateKey(rawKey);
      if (decoded.length !== 32) {
        throw new Error(`FATAL: DELIVERY_ENCRYPTION_KEY must decode to exactly 32 bytes (received ${decoded.length} bytes)`);
      }
    }

    if (!this.key || this.key.length !== 32) {
      throw new Error(`FATAL: Active encryption key buffer is not 32 bytes (length: ${this.key?.length || 0})`);
    }

    return { valid: true, version: this.keyVersion, keyLength: this.key.length };
  }

  /**
   * Encrypts plaintext credentials using AES-256-GCM authenticated encryption.
   * Format: v1:{iv_hex}:{authTag_hex}:{ciphertext_hex}
   */
  public encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12); // Unique 12-byte IV recommended for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${this.keyVersion}:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts AES-256-GCM ciphertext verifying authentication tag.
   * Throws if tampered, corrupted, or decrypted with wrong key.
   */
  public decrypt(encryptedPayload: string, overrideKey?: Buffer): string {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 4) {
      throw new Error('Invalid encrypted payload format. Expected version:iv:authTag:ciphertext');
    }

    const [version, ivHex, authTagHex, cipherHex] = parts;
    if (version !== this.keyVersion && version !== 'v1') {
      throw new Error(`Unsupported encryption key version: ${version}`);
    }

    const iv = Buffer.from(ivHex, 'hex');
    if (iv.length !== 12) {
      throw new Error(`Invalid IV length: expected 12 bytes, received ${iv.length}`);
    }

    const authTag = Buffer.from(authTagHex, 'hex');
    if (authTag.length !== 16) {
      throw new Error(`Invalid authentication tag length: expected 16 bytes, received ${authTag.length}`);
    }

    const keyToUse = overrideKey || this.key;
    if (keyToUse.length !== 32) {
      throw new Error(`Invalid AES-256 key length: expected 32 bytes, received ${keyToUse.length}`);
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyToUse, iv);
    decipher.setAuthTag(authTag);

    try {
      let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      throw new Error(`Authenticated decryption failed: data may be corrupted, tampered, or key mismatch (${err.message})`);
    }
  }

  /**
   * Decrypts strictly for the owning customer or an authorized administrator.
   */
  public decryptForAuthorizedUser(
    encryptedPayload: string,
    orderOwnerUserId: string,
    requesterUserId: string,
    isAdmin: boolean
  ): string {
    if (requesterUserId !== orderOwnerUserId && !isAdmin) {
      throw new Error('Access denied: Only the owning customer or authorized administrator can access delivered credentials.');
    }
    return this.decrypt(encryptedPayload);
  }

  public getKeyVersion(): string {
    return this.keyVersion;
  }
}

export const encryptionService = new EncryptionService();
