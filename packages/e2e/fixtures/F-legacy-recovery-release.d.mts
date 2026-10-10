export const PINNED_CHROME_ZIP_SHA256: string;
export function readZipEntries(zip: Buffer): { name: string; data: Buffer }[];
export function verifyUnpackedRelease(args: { dir: string; zip: string; expectedSha256: string }): {
  zipSha256: string;
  files: number;
  version: string;
  sourceCommit: string | null;
};
