// Deno equivalent of the decodeUpload() helper duplicated across the Node
// backend's media.ts/payments.ts. Uses the same validation (content-type
// allowlist, base64 charset check, size ceiling) but returns a Uint8Array
// instead of a Node Buffer, since Deno doesn't have Buffer without a
// polyfill and Supabase Storage's upload() accepts Uint8Array directly.
export function decodeUpload(base64: string, contentType: string, maxBytes: number, allowed: RegExp): Uint8Array {
  if (!allowed.test(contentType)) throw new Error("Unsupported file type");
  const normalized = base64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error("Invalid file data");
  let binaryString: string;
  try {
    binaryString = atob(normalized);
  } catch {
    throw new Error("Invalid file data");
  }
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  if (!bytes.length || bytes.length > maxBytes) throw new Error("File exceeds the permitted size");
  return bytes;
}
