import { createHash } from 'node:crypto';

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import type { DownloadedFile } from '@veriko-mx/sdk-runtime';

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

export class ArtifactLimitError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(`El archivo de ${size} bytes supera el límite de recursos de ${limit} bytes.`);
    this.name = 'ArtifactLimitError';
    this.size = size;
    this.limit = limit;
  }
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = 32,
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
      mimeType: file.contentType,
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
    'artefactos_veriko',
    new ResourceTemplate('veriko://artifact/{id}', {
      list: async () => ({
        resources: store.list().map((artifact) => ({
          uri: artifact.uri,
          name: artifact.name,
          mimeType: artifact.mimeType,
          description: `Archivo Veriko (${artifact.size} bytes, sha256 ${artifact.sha256})`,
        })),
      }),
    }),
    { description: 'Archivos descargados de Veriko durante esta sesión.' },
    async (uri, variables) => {
      const id = variables.id;
      const artifact = typeof id === 'string' ? store.get(id) : undefined;
      if (!artifact) throw new Error(`No existe el artefacto ${String(id)}.`);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.mimeType,
            blob: Buffer.from(artifact.content).toString('base64'),
          },
        ],
      };
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
