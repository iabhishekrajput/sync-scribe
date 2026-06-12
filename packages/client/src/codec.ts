// Varint frame codec mirroring apps/api/internal/sync/protocol.go. The
// framing is stock y-protocols: [msgType: varint] [body...].
import { MSG_AWARENESS, MSG_SYNC } from "@syncscribe/proto";

export class ByteCursor {
  private index = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readVarUint(): number | null {
    let value = 0;
    let shift = 0;
    while (this.index < this.bytes.length) {
      const byte = this.bytes[this.index++];
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7;
      if (shift > 35) return null;
    }
    return null;
  }

  readVarBytes(): Uint8Array | null {
    const len = this.readVarUint();
    if (len === null) return null;
    if (this.index + len > this.bytes.length) return null;
    const out = this.bytes.slice(this.index, this.index + len);
    this.index += len;
    return out;
  }

  done(): boolean {
    return this.index === this.bytes.length;
  }
}

export function encodeYjsSyncFrame(kind: number, payload: Uint8Array): Uint8Array {
  return concatBytes(encodeVarUint(MSG_SYNC), encodeVarUint(kind), encodeVarBytes(payload));
}

export function encodeYjsAwarenessFrame(payload: Uint8Array): Uint8Array {
  return concatBytes(encodeVarUint(MSG_AWARENESS), encodeVarBytes(payload));
}

export function encodeVarBytes(payload: Uint8Array): Uint8Array {
  return concatBytes(encodeVarUint(payload.length), payload);
}

export function encodeVarUint(value: number): Uint8Array {
  const bytes: number[] = [];
  let next = value >>> 0;
  while (next > 0x7f) {
    bytes.push((next & 0x7f) | 0x80);
    next >>>= 7;
  }
  bytes.push(next);
  return Uint8Array.from(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function base64ToBytes(value: string): Uint8Array {
  const typed = Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (input: string) => Uint8Array;
  };
  if (typeof typed.fromBase64 === "function") {
    return typed.fromBase64(value);
  }
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
