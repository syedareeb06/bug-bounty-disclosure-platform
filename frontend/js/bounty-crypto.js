/* Cryptography used by BountyChain (all done in the browser with the Web Crypto API):
 *  - RSA-OAEP 2048 / SHA-256 key pairs for companies: the public key (SPKI) is published
 *    on-chain with the bounty program, the private key (PKCS#8) stays off-chain in the
 *    company's vault and can be backed up as a .pem file
 *  - hybrid encryption of a report: AES-256-GCM encrypts the report, RSA-OAEP wraps the
 *    random AES key so that only the company can unwrap it
 *  - a canonical (fixed field order) report JSON with a random salt, so its SHA-256 is a
 *    hiding commitment that can be checked again later
 */
(function () {
  const RSA_PARAMS = { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const RSA_IMPORT = { name: "RSA-OAEP", hash: "SHA-256" };
  const FORMAT = "bountychain-report/1";
  const ALG = "RSA-OAEP-2048-SHA256 + AES-256-GCM";

  // ---------------- RSA key pairs ----------------
  async function generateKeyPair() {
    const kp = await crypto.subtle.generateKey(RSA_PARAMS, true, ["encrypt", "decrypt"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const publicKey = UI.bytesToBase64(spki);
    return { publicKey, privateKey: UI.bytesToBase64(pkcs8), fingerprint: await fingerprint(publicKey), spkiBytes: spki.length };
  }

  /** SHA-256 of the SPKI public key: a short ID that both sides can compare. */
  const fingerprint = (spkiB64) => UI.sha256(UI.base64ToBytes(spkiB64));

  const importPublic = (spkiB64) => crypto.subtle.importKey("spki", UI.base64ToBytes(spkiB64), RSA_IMPORT, false, ["encrypt"]);
  const importPrivate = (pkcs8B64, extractable = false) =>
    crypto.subtle.importKey("pkcs8", UI.base64ToBytes(pkcs8B64), RSA_IMPORT, extractable, ["decrypt"]);

  /** Derive the public key (SPKI base64) that belongs to a private key, to check a restored backup. */
  async function publicFromPrivate(pkcs8B64) {
    const priv = await importPrivate(pkcs8B64, true);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true }, RSA_IMPORT, true, [
      "encrypt",
    ]);
    return UI.bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pub)));
  }

  function toPem(b64, label) {
    return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  }

  function fromPem(pem) {
    const m = String(pem).match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
    if (!m) throw new Error("This is not a PEM key file.");
    return { label: m[1], b64: m[2].replace(/\s+/g, "") };
  }

  // ---------------- Reports ----------------
  /** Canonical report JSON. The fixed field order makes the SHA-256 commitment reproducible;
   *  the random salt stops anyone from guessing the content from the public hash. */
  function canonicalReport(r) {
    return JSON.stringify({
      format: "bountychain-plaintext/1",
      programId: Number(r.programId),
      title: String(r.title),
      asset: String(r.asset),
      severity: Number(r.severity),
      steps: String(r.steps),
      impact: String(r.impact),
      salt: String(r.salt),
    });
  }

  function parseReport(text) {
    const r = JSON.parse(text);
    if (!r || r.format !== "bountychain-plaintext/1") throw new Error("Not a BountyChain report.");
    return r;
  }

  // ---------------- Hybrid encryption ----------------
  /** Encrypt with a fresh random AES-256-GCM key. Returns the raw key so it can be wrapped. */
  async function aesEncrypt(plaintext) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = UI.randomBytes(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, UI.toBytes(plaintext)));
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    return { rawKey, iv, ciphertext };
  }

  async function aesDecrypt(rawKey, iv, ciphertext) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    try {
      return UI.utf8.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
    } catch {
      throw new Error("AES-GCM authentication failed: the ciphertext was modified.");
    }
  }

  /** RSA-OAEP: encrypt (wrap) the AES key with the company's public key. */
  async function wrapKey(rawKey, spkiB64) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, await importPublic(spkiB64), rawKey));
  }

  async function unwrapKey(wrapped, pkcs8B64) {
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, await importPrivate(pkcs8B64), wrapped));
    } catch {
      throw new Error("RSA-OAEP decryption failed: this private key does not match the program's public key.");
    }
  }

  /** The encrypted package that goes to the report server (off-chain). Only its hash goes on-chain. */
  function buildPackage({ programId, keyFingerprint, wrappedKey, iv, ciphertext }) {
    return JSON.stringify({
      format: FORMAT,
      alg: ALG,
      programId: Number(programId),
      keyFingerprint,
      wrappedKey: UI.bytesToBase64(wrappedKey),
      iv: UI.bytesToBase64(iv),
      ciphertext: UI.bytesToBase64(ciphertext),
    });
  }

  function parsePackage(text) {
    let p;
    try {
      p = JSON.parse(text);
    } catch {
      throw new Error("The package is not valid JSON.");
    }
    if (!p || p.format !== FORMAT) throw new Error("Not a BountyChain encrypted package.");
    return {
      programId: p.programId,
      keyFingerprint: p.keyFingerprint,
      wrappedKey: UI.base64ToBytes(p.wrappedKey),
      iv: UI.base64ToBytes(p.iv),
      ciphertext: UI.base64ToBytes(p.ciphertext),
    };
  }

  /** Full hybrid decryption of a package with the company's private key. */
  async function decryptPackage(text, pkcs8B64) {
    const p = parsePackage(text);
    const rawKey = await unwrapKey(p.wrappedKey, pkcs8B64);
    const plaintext = await aesDecrypt(rawKey, p.iv, p.ciphertext);
    rawKey.fill(0);
    return plaintext;
  }

  window.BountyCrypto = {
    ALG,
    generateKeyPair,
    fingerprint,
    publicFromPrivate,
    toPem,
    fromPem,
    canonicalReport,
    parseReport,
    aesEncrypt,
    aesDecrypt,
    wrapKey,
    unwrapKey,
    buildPackage,
    parsePackage,
    decryptPackage,
  };
})();
