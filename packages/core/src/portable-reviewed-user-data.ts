/** Human-selected families; settings remain inactive after import. */
export interface ReviewedUserDataSelection {git:boolean;harness:boolean;source?:'live'|'retained_originals'}
/** Inert user-data transport. No source runtime, credential or worktree authority. */
export interface ReviewedGitUserData {
  version:1;format:'sha1'|'sha256';
  objects:Array<{oid:string;type:'blob'|'tree'|'commit'|'tag';dataBase64:string}>;
  refs:Array<{name:string;oid:string;symbolic?:string}>;
  head:{symbolic:string}|{oid:string};
  /** Exact oldest-first local reflog bytes; never source worktree ownership. */
  reflogs:Array<{path:string;dataBase64:string}>;
  index:Array<{mode:string;oid:string;stage:number;path:string;intentToAdd:boolean;assumeUnchanged:boolean;skipWorktree:boolean}>;
  /** Saved conflict stages, in byte-path/stage order; absent stages have no fabricated mode or OID. */
  resolveUndo:Array<{path:string;stages:Array<{stage:number;mode:string;oid:string}>}>;
  /** Exact patterns and collapsed directory originals; destination index is full and settings stay inactive. */
  sparseReview:{patternsBase64:string|null;directories:ReviewedGitUserData['index']};
  /** Exact common-repository originals or explicit absence, in path order; never active Git settings. */
  infoReview:Array<{path:'info/attributes'|'info/exclude';source:'common_repository';dataBase64:string|null}>;
  configurationReview:Array<{key:string;value:string;implicitBoolean?:true;source?:'config.worktree'}>;
  exclusions:string[];
}
export interface ReviewedUserData {
  version:1;activation:'inert_review_only';selection:Pick<ReviewedUserDataSelection,'git'|'harness'>;git?:ReviewedGitUserData;
  recreationScope:{absoluteLinks:'refuse';crossRootLinks:'refuse';cyclicLinks:'refuse'|'passive_in_root';specialNodes:'refuse';acl:'not_inspected_preserve_source';xattrs:'not_inspected_preserve_source'};
  providerFiles:Array<{path:string;dataBase64:string;removedSecretFields:boolean}>;
  exclusions:string[];
}
