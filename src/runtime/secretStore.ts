/**
 * Secret Store — encrypted at-rest storage for API keys, tokens, and
 * other sensitive runtime credentials.
 *
 * Uses AES-256-GCM with a PBKDF2-derived key. The master passphrase
 * is read from the FUSION_SECRET_KEY environment variable (or a
 * hard-coded development default). Encrypted values are stored as
 * base64-encoded JSON blobs: { iv, tag, ciphertext, kdf: { salt, iter } }.
 *
 * Never writes plaintext credentials to disk.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  timingSafeEqual,
} from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptedBlob {
  /** Base64-encoded ciphertext */
  ciphertext: string
  /** Base64-encoded initialization vector (12 bytes for GCM) */
  iv: string
  /** Base64-encoded authentication tag (16 bytes) */
  tag: string
  /** KDF parameters (for key rotation support) */
  kdf: {
    /** Base64-encoded salt */
    salt: string
    /** PBKDF2 iterations */
    iterations: number
  }
}

export interface SecretStore {
  /** Encrypt a plaintext string. Returns a JSON-serializable blob. */
  encrypt(plaintext: string): EncryptedBlob
  /** Decrypt a previously encrypted blob. Returns null on failure. */
  decrypt(blob: EncryptedBlob): string | null
  /** Securely compare two strings in constant time. */
  constantTimeEqual(a: string, b: string): boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const PBKDF2_ITERATIONS = 600_000
const SALT_LENGTH = 32

function getMasterPassphrase(): string {
  return process.env.FUSION_SECRET_KEY ?? 'fusion-dev-default-key-change-in-production'
}

function deriveKey(salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(getMasterPassphrase(), salt, iterations, KEY_LENGTH, 'sha512')
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createSecretStore(): SecretStore {
  return {
    encrypt(plaintext: string): EncryptedBlob {
      const salt = randomBytes(SALT_LENGTH)
      const iv = randomBytes(IV_LENGTH)
      const key = deriveKey(salt, PBKDF2_ITERATIONS)

      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()

      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        kdf: {
          salt: salt.toString('base64'),
          iterations: PBKDF2_ITERATIONS,
        },
      }
    },

    decrypt(blob: EncryptedBlob): string | null {
      try {
        const salt = Buffer.from(blob.kdf.salt, 'base64')
        const iv = Buffer.from(blob.iv, 'base64')
        const tag = Buffer.from(blob.tag, 'base64')
        const ciphertext = Buffer.from(blob.ciphertext, 'base64')

        const key = deriveKey(salt, blob.kdf.iterations)

        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
        decipher.setAuthTag(tag)

        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString('utf-8')
      } catch {
        return null
      }
    },

    constantTimeEqual(a: string, b: string): boolean {
      if (a.length !== b.length) {
        // Constant-time comparison: pad shorter string to match length
        const maxLen = Math.max(a.length, b.length)
        const aPadded = Buffer.alloc(maxLen, 0)
        const bPadded = Buffer.alloc(maxLen, 0)
        aPadded.write(a)
        bPadded.write(b)
        timingSafeEqual(aPadded, bPadded)
        return false
      }
      return timingSafeEqual(Buffer.from(a), Buffer.from(b))
    },
  }
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

let _defaultStore: SecretStore | null = null

export function getDefaultSecretStore(): SecretStore {
  if (!_defaultStore) {
    _defaultStore = createSecretStore()
  }
  return _defaultStore
}

export function setDefaultSecretStore(store: SecretStore): void {
  _defaultStore = store
}
