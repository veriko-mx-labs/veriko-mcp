import { createHash } from 'node:crypto';

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { DownloadedFile as SdkDownloadedFile } from '@veriko-mx/sdk-runtime';

/** The parts of a download the server reads. The response headers are not needed here. */
export type DownloadedFile = Pick<SdkDownloadedFile, 'filename' | 'contentType' | 'content'>;

export interface ArtifactReference {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

interface StoredArtifact extends ArtifactReference {
  content: Uint8Array;
}

/** Metadata of a downloaded file, without storing it. The URI comes from the hash. */
export function describeArtifact(file: DownloadedFile): ArtifactReference {
  const sha256 = createHash('sha256').update(file.content).digest('hex');
  return {
    uri: `veriko://artifact/${sha256.slice(0, 32)}`,
    name: file.filename,
    mimeType: resolveMimeType(file),
    size: file.content.byteLength,
    sha256,
  };
}

export class ArtifactLimitError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(`The ${size}-byte file exceeds the resource limit of ${limit} bytes.`);
    this.name = 'ArtifactLimitError';
    this.size = size;
    this.limit = limit;
  }
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private totalBytes = 0;

  constructor(
    readonly maxEntries = 32,
    private readonly maxTotalBytes = 64 * 1024 * 1024,
  ) {}

  put(file: DownloadedFile): ArtifactReference {
    if (file.content.byteLength > this.maxTotalBytes) {
      throw new ArtifactLimitError(file.content.byteLength, this.maxTotalBytes);
    }
    const sha256 = createHash('sha256').update(file.content).digest('hex');
    const id = sha256.slice(0, 32);
    const artifact: StoredArtifact = {
      uri: `veriko://artifact/${id}`,
      name: file.filename,
      mimeType: resolveMimeType(file),
      size: file.content.byteLength,
      sha256,
      content: file.content,
    };
    const previous = this.artifacts.get(id);
    if (previous) {
      this.totalBytes -= previous.size;
      this.artifacts.delete(id);
    }
    this.artifacts.set(id, artifact);
    this.totalBytes += artifact.size;
    while (this.artifacts.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldestId = this.artifacts.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.artifacts.get(oldestId);
      this.artifacts.delete(oldestId);
      if (oldest) this.totalBytes -= oldest.size;
    }
    return this.reference(artifact);
  }

  get(id: string): StoredArtifact | undefined {
    return this.artifacts.get(id);
  }

  list(): ArtifactReference[] {
    return [...this.artifacts.values()].map((artifact) => this.reference(artifact));
  }

  private reference(artifact: StoredArtifact): ArtifactReference {
    const { content: _content, ...reference } = artifact;
    return reference;
  }
}

export function registerArtifactResources(server: McpServer, store: ArtifactStore): void {
  server.registerResource(
    'veriko_artifacts',
    new ResourceTemplate('veriko://artifact/{id}', {
      complete: {
        id: (typed) => store.list().map((artifact) => artifact.uri.split('/').pop() ?? '').filter((id) => id.startsWith(typed)),
      },
      list: async () => ({
        resources: store.list().map((artifact) => ({
          uri: artifact.uri,
          name: artifact.name,
          mimeType: artifact.mimeType,
          description: `Veriko file (${artifact.size} bytes, sha256 ${artifact.sha256})`,
        })),
      }),
    }),
    { description: 'Files downloaded from Veriko during this session.' },
    async (uri, variables) => {
      const id = variables.id;
      const artifact = typeof id === 'string' ? store.get(id) : undefined;
      if (!artifact) {
        throw new Error(
          `Artifact ${String(id)} is not available: the server keeps the last ${store.maxEntries} files of this session and drops the oldest. Download it again.`,
        );
      }
      return { contents: [resourceContents(artifact.uri, artifact.mimeType, artifact.content)] };
    },
  );
}

export function isDownloadedFile(value: unknown): value is DownloadedFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DownloadedFile>;
  return (
    candidate.content instanceof Uint8Array &&
    typeof candidate.contentType === 'string' &&
    typeof candidate.filename === 'string'
  );
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  json: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/**
 * The media type of a download. The API sometimes answers `application/octet-stream`
 * for files whose type is known (an XLSX export, an import template); the file
 * name and the leading bytes say what they are.
 */
export function resolveMimeType(file: DownloadedFile): string {
  const declared = file.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    return declared;
  }
  const extension = file.filename.split('.').pop()?.toLowerCase() ?? '';
  const byName = EXTENSION_TYPES[extension];
  if (byName) return byName;
  const bytes = file.content;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Whether a media type is text a model can read directly. */
export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/xml' ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+xml') ||
    mimeType.endsWith('+json')
  );
}

/** Resource contents: `text` for text media types, `blob` (base64) for the rest. */
export function resourceContents(
  uri: string,
  mimeType: string,
  content: Uint8Array,
): { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string } {
  if (isTextMimeType(mimeType)) {
    return { uri, mimeType, text: new TextDecoder().decode(content) };
  }
  return { uri, mimeType, blob: Buffer.from(content).toString('base64') };
}
