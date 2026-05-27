# ADR-003: Secret Key Management

**Date:** 2025-05-26
**Status:** Accepted

## Context

FusionWorkspace handles provider API keys (Anthropic, OpenAI, MiniMax), WeChat/Feishu channel tokens, and HMAC signing keys. These must be stored securely at rest and never appear in plaintext in logs, config files, or audit trails.

## Decision

We implement a two-tier approach:

1. **Environment variables** for initial key loading — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. These are the single source of truth at startup.

2. **AES-256-GCM encrypted storage** (`SecretStore`) for runtime persistence. Keys are encrypted with a PBKDF2-derived key (600K iterations, SHA-512) from `FUSION_SECRET_KEY`. Encrypted blobs are safe to persist in the config database.

3. **Redaction at all output boundaries** — The `redactSensitive()` function in `externalReviewer.ts` strips API keys, tokens, and secrets from LLM prompts. StructuredLogger never logs raw credential fields.

## Rationale

- **Environment variables are the industry standard for bootstrap secrets.** They integrate with Docker secrets, Kubernetes secrets, and CI/CD secret managers without code changes.
- **AES-256-GCM provides authenticated encryption.** Tampering with the ciphertext or IV is detectable via auth tag verification.
- **PBKDF2 key derivation resists brute-force.** Even if the encrypted blob is exfiltrated, 600K SHA-512 iterations make offline cracking expensive.
- **Redaction at output boundaries follows defense-in-depth.** Even if a provider key leaks into a log message, it is replaced with `[REDACTED_KEY]` before writing.

## Consequences

- `FUSION_SECRET_KEY` must be set in production. Without it, secrets are encrypted with a known default key — acceptable for development, not for production.
- Key rotation requires re-encrypting all stored blobs with the new master key. The `kdf` parameters in `EncryptedBlob` support this by tracking salt and iteration count per blob.
- `SecretStore` does not integrate with cloud KMS (AWS KMS, GCP KMS). That is deferred to a future ADR.
