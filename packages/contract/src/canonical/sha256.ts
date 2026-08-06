import { canonicalize } from "./jcs.js";

/** Lowercase-hex SHA-256 via WebCrypto (Node >=20, Workers, browsers). */
export async function sha256Hex(
  input: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 over the RFC 8785 canonical form. The basis of every Muster hash. */
export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalize(value));
}
