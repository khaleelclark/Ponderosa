import { readdir, unlink, rmdir } from '@ponderosa/native-host/fs/promises';
import path from 'node:path';

/** Caller has validated the directory identity and its ownership marker.
 * Directory ownership never authorizes deleting content added by the user. */
export async function removeEmptyTombstone(directory: string, marker: string): Promise<void> {
  if (path.basename(marker) !== marker) throw new Error('Invalid tombstone marker');
  const entries = await readdir(directory);
  if (entries.some(entry => entry !== marker)) throw new Error(`Cleanup preserved unexpected files in ${directory}`);
  await unlink(path.join(directory, marker));
  // A concurrent addition makes rmdir fail while preserving the added bytes.
  await rmdir(directory);
}
