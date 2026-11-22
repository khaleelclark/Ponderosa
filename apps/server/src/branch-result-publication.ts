import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BranchPublishedResultDto, BranchResult, BranchResultFileDto } from '@ponderosa/core';

const sha256 = /^[a-f0-9]{64}$/u;

/** A structured result can report creation or reuse of one named JSON document.
 * Verify its stored bytes before turning the reported digest into a download. */
export function branchPublishedResult(output?: string): { publication: BranchPublishedResultDto; content: string } | undefined {
  if (!output?.trimStart().startsWith('{')) return undefined;
  let envelope: unknown;
  try { envelope = JSON.parse(output); } catch { return undefined; }
  if (!envelope || typeof envelope !== 'object') return undefined;
  const { id, saved, sha256: digest } = envelope as Record<string, unknown>;
  if (typeof id !== 'string' || (saved !== 'created' && saved !== 'reused') || typeof digest !== 'string' || !sha256.test(digest)) return undefined;

  for (const [name, value] of Object.entries(envelope)) {
    if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id) continue;
    const content = JSON.stringify(value, null, 2) + '\n';
    if (createHash('sha256').update(content).digest('hex') !== digest) continue;
    const title = name.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ').trim().slice(0, 80);
    const label = title ? title[0]!.toUpperCase() + title.slice(1) : 'Saved result';
    return { publication: { label, sha256: digest, reused: saved === 'reused' }, content };
  }
}

export function readPublishedBranchResult(db: Database.Database, branchId: string, digest: string): string | undefined {
  if (!sha256.test(digest)) return undefined;
  const candidates = db.prepare(`SELECT json_extract(result.result_json, '$.output') output
    FROM branch_executions execution JOIN branch_sealed_results result ON result.execution_id=execution.id
    WHERE execution.branch_id=? AND json_extract(result.result_json, '$.failed')=0
      AND instr(json_extract(result.result_json, '$.output'), ?) > 0`);
  for (const row of candidates.iterate(branchId, digest) as Iterable<{ output: string }>) {
    const found = branchPublishedResult(row.output);
    if (found?.publication.sha256 === digest) return found.content;
  }
}

/** Discover only links to the existing authorized managed-artifact route. */
export function branchResultFiles(result?: BranchResult): BranchResultFileDto[] {
  if (result?.failed !== false || !result.output) return [];
  const files = new Map<string, BranchResultFileDto>();
  for (const [, label, href] of result.output.matchAll(/\[([^\]\n]{1,160})\]\((\/api\/(?:branches\/engine\/)?projects\/[\w-]+\/artifacts\/[\w.:%-]+\/download)\)/gu)) {
    const canonical = href!.replace('/api/branches/engine/', '/api/');
    files.set(canonical, { label: label!, href: canonical });
    if (files.size === 20) break;
  }
  return [...files.values()];
}
