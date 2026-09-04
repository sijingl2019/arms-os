import { open } from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter, readString } from '../skills/frontmatter'
import { isTextFile, type WalkedFile } from './walk'

export interface Extracted {
  title: string
  excerpt: string
}

/** Collapse whitespace so an excerpt stays one dense, searchable blob. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A human-facing title: frontmatter `title`, else the first markdown heading,
 * else the filename without its extension.
 */
export function titleFor(file: WalkedFile, head: string): string {
  if (head) {
    try {
      const fm = parseFrontmatter(head)
      const declared = readString(fm.data, 'title') ?? readString(fm.data, 'name')
      if (declared) return declared
    } catch {
      /* broken frontmatter just means no declared title */
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(head)
    if (heading?.[1]) return squash(heading[1]).slice(0, 200)
  }
  return path.basename(file.name, path.extname(file.name))
}

/**
 * Read the head of a file for the full-text index.
 *
 * Only the head, and only via a bounded read: the point is that indexing a
 * 200MB log must cost the same as indexing a note. The tail of a long document
 * is therefore not searchable - a deliberate trade recorded in the README.
 */
export async function extract(
  file: WalkedFile,
  opts: { excerptBytes: number; maxFileBytes: number }
): Promise<Extracted> {
  if (!isTextFile(file.name) || file.size > opts.maxFileBytes) {
    return { title: titleFor(file, ''), excerpt: '' }
  }

  let head = ''
  try {
    const handle = await open(file.path, 'r')
    try {
      const length = Math.min(opts.excerptBytes, Math.max(file.size, 1))
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      head = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    // Unreadable is not fatal: the file still belongs in the index by path.
    return { title: titleFor(file, ''), excerpt: '' }
  }

  // A lone replacement character means we cut a multi-byte sequence or the file
  // is not really text; drop the trailing fragment rather than index mojibake.
  const cleaned = head.replace(/�+$/, '')

  return { title: titleFor(file, cleaned), excerpt: squash(cleaned) }
}
