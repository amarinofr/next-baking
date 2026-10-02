/**
 * Identifiers that work wherever the app happens to be opened.
 *
 * `crypto.randomUUID` only exists in a secure context, so it is undefined when a phone opens this app through a plain
 * http LAN address — which is precisely how a phone reaches a hub. Falling back to `crypto.getRandomValues` (available
 * on any origin) keeps ids real v4 UUIDs instead of degrading to timestamps that could collide between two devices
 * editing at the same millisecond, and the last resort covers a browser with no WebCrypto at all.
 */

const HEX = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, "0"));

export function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(bytes, (byte) => HEX[byte]!).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
