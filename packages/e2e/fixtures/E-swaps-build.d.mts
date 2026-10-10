export interface BuildProof {
  manifestName: string;
  manifestVersion: string;
  distFiles: number;
  /** SHA-256 over every file's path and SHA-256, sorted. */
  distTreeSha256: string;
  /** Present only when EXTENSION_ZIP was given and matched the directory exactly. */
  zip: { file: string; sha256: string; entries: number; matchesDist: true } | null;
}
export function readZip(buffer: Buffer): Map<string, Buffer>;
export function proveBuild(input: { distDir: string; zipPath?: string | undefined; expectZipSha256?: string | undefined }): BuildProof;
