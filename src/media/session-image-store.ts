import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpeg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export interface StoredImageRef {
  type: "image";
  source: {
    type: "file";
    path: string;
    media_type: string;
  };
}

/**
 * Store a base64-encoded image to disk, returning a file reference.
 * Deduplicates by SHA-256 hash of the raw image data.
 *
 * @param sessionsDir The agent's sessions directory (dirname of sessions.json)
 * @param data Base64-encoded image data
 * @param mimeType MIME type (e.g. "image/jpeg")
 * @returns A StoredImageRef with a relative path suitable for JSONL persistence
 */
export function storeSessionImage(
  sessionsDir: string,
  data: string,
  mimeType: string,
): StoredImageRef {
  const ext = MIME_TO_EXT[mimeType] ?? ".jpeg";
  const buffer = Buffer.from(data, "base64");
  const hash = createHash("sha256").update(buffer).digest("hex");
  const relativePath = `media/${hash}${ext}`;
  const absolutePath = join(sessionsDir, relativePath);

  if (!existsSync(absolutePath)) {
    mkdirSync(join(sessionsDir, "media"), { recursive: true });
    writeFileSync(absolutePath, buffer);
  }

  return {
    type: "image",
    source: {
      type: "file",
      path: relativePath,
      media_type: mimeType,
    },
  };
}

/**
 * Resolve a file-referenced image back to base64.
 *
 * @param sessionsDir The agent's sessions directory
 * @param ref The stored image reference
 * @returns Object with base64 data and media type, or null if file not found
 */
export function resolveSessionImage(
  sessionsDir: string,
  ref: { source: { path: string; media_type: string } },
): { data: string; media_type: string } | null {
  const absolutePath = join(sessionsDir, ref.source.path);
  if (!existsSync(absolutePath)) {
    return null;
  }
  const buffer = readFileSync(absolutePath);
  return {
    data: buffer.toString("base64"),
    media_type: ref.source.media_type,
  };
}

/**
 * Check if a content block is a file-referenced image.
 */
export function isFileImageRef(
  block: unknown,
): block is { type: "image"; source: { type: "file"; path: string; media_type: string } } {
  if (!block || typeof block !== "object") {return false;}
  const b = block as Record<string, unknown>;
  if (b.type !== "image") {return false;}
  const source = b.source as Record<string, unknown> | undefined;
  return source?.type === "file" && typeof source.path === "string";
}

/**
 * Check if a content block is a base64 image (inline).
 */
export function isBase64ImageBlock(
  block: unknown,
): block is { type: "image"; data: string; mimeType: string } {
  if (!block || typeof block !== "object") {return false;}
  const b = block as Record<string, unknown>;
  return b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string";
}

/**
 * Resolve all file-referenced images in a messages array, replacing them with base64 inline images.
 * Mutates the messages in place.
 */
export function resolveFileImageRefs(sessionsDir: string, messages: unknown[]): void {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {continue;}
    const m = msg as Record<string, unknown>;
    const content = m.content;
    if (!Array.isArray(content)) {continue;}

    for (let i = 0; i < content.length; i++) {
      if (isFileImageRef(content[i])) {
        const resolved = resolveSessionImage(sessionsDir, content[i]);
        if (resolved) {
          content[i] = {
            type: "image",
            data: resolved.data,
            mimeType: resolved.media_type,
          };
        }
      }
    }
  }
}

/**
 * Post-process a session JSONL file: replace inline base64 images with file references.
 * Only scans from the given byte offset (or the last 64KB if not provided) to avoid
 * re-scanning the entire file on every turn. Uses atomic write (temp + rename) for safety.
 *
 * @param sessionFile Full path to the JSONL session file
 * @param scanTailBytes How many bytes from the end to scan (default 64KB, enough for most turns)
 */
export function externalizeSessionImages(sessionFile: string, scanTailBytes = 65536): void {
  if (!existsSync(sessionFile)) {return;}

  const sessionsDir = dirname(sessionFile);
  const raw = readFileSync(sessionFile, "utf-8");

  // Quick check: if no base64 image pattern exists in the tail, skip entirely
  const tail = new Set(raw.slice(-scanTailBytes));
  if (!tail.has('"type":"image"') && !tail.has('"type": "image"')) {return;}

  const lines = raw.split(/\r?\n/);
  let modified = false;

  // Only scan lines that start within the tail region
  const tailStartByte = Math.max(0, raw.length - scanTailBytes);
  let bytePos = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1; // +1 for newline
    if (bytePos + lineLen <= tailStartByte) {
      bytePos += lineLen;
      continue;
    }
    bytePos += lineLen;

    const line = lines[i];
    if (!line.trim()) {continue;}

    try {
      const entry = JSON.parse(line);
      if (!entry?.message?.content || !Array.isArray(entry.message.content)) {continue;}

      let entryModified = false;
      for (let j = 0; j < entry.message.content.length; j++) {
        const block = entry.message.content[j];
        if (isBase64ImageBlock(block)) {
          const ref = storeSessionImage(sessionsDir, block.data, block.mimeType);
          entry.message.content[j] = ref;
          entryModified = true;
        }
      }

      if (entryModified) {
        lines[i] = JSON.stringify(entry);
        modified = true;
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (modified) {
    const tmpFile = sessionFile + ".tmp";
    writeFileSync(tmpFile, lines.join("\n"));
    renameSync(tmpFile, sessionFile);
  }
}

/**
 * Replace base64 image blocks in messages with file references.
 * Stores images to disk and mutates messages in place.
 */
export function replaceBase64WithFileRefs(sessionsDir: string, messages: unknown[]): void {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {continue;}
    const m = msg as Record<string, unknown>;
    const content = m.content;
    if (!Array.isArray(content)) {continue;}

    for (let i = 0; i < content.length; i++) {
      if (isBase64ImageBlock(content[i])) {
        const block = content[i] as { data: string; mimeType: string };
        const ref = storeSessionImage(sessionsDir, block.data, block.mimeType);
        content[i] = ref;
      }
    }
  }
}
