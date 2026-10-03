import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Repository inventory only: no AgentStore, data-directory or provider startup.
export function inventoryProjectDomain(root) {
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:32*1024**2});
  const tracked=git('ls-files','-z').split('\0').filter(Boolean).sort(),files=[];
  for(const name of tracked){
    const file=join(root,name),stat=lstatSync(file);if(!stat.isFile())continue;
    if(stat.size>16*1024**2)throw Error(`Tracked file exceeds inventory bound: ${name}`);
    const bytes=readFileSync(file);if(bytes.subarray(0,8192).includes(0))continue;
    const lines=bytes.toString('utf8').split('\n'),locations=[];
    for(let i=0;i<lines.length;i++)if(/\b(?:[A-Za-z_]*[Pp]roject(?:[A-Z_][A-Za-z0-9_]*|s(?:[A-Z_][A-Za-z0-9_]*)?)?|project_id)\b/u.test(lines[i]))locations.push(i+1);
    if(!locations.length&&!/project/iu.test(name))continue;
    const category=/\/schema\/\d+[^/]*\.sql$/u.test(name)?'deployed_schema_requires_immutable_upgrade_reader':
      /(?:^|\/)test(?:\/|s\/)|\.test\.|\.check\./u.test(name)?'test_or_fixture_requires_classification':
      /^(?:docs\/|README|AGENTS)|\.md$/u.test(name)?'documentation_requires_current_vs_historical_classification':'active_source_or_tool_requires_caller_trace';
    files.push({path:name,category,lines:locations,filenameMatch:/project/iu.test(name),sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return {version:1,status:'inventory_only',head:git('rev-parse','HEAD').trim(),
    sourceWorktreeDirty:git('status','--porcelain','--untracked-files=all').trim()!=='',
    activeDomainRemovalVerified:false,exceptionsReviewed:false,files,
    counts:{files:files.length,matchingLines:files.reduce((n,file)=>n+file.lines.length,0)},
    limitations:['Tracked repository text and filenames only; generated/package outputs require a separate scan.',
      'A match is not an approved exception. Caller tracing and historical/generic classification remain required.',
      'This report does not inspect operator data, determine resource ownership or authorize migration.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3)throw Error('Usage: node project-domain-inventory.mjs <repository>');
  process.stdout.write(`${JSON.stringify(inventoryProjectDomain(resolve(process.argv[2])),null,2)}\n`);
}
