/** Explicit import authority; export family selection never implies activation. */
export interface ReviewedUserDataActivation {git:boolean;harness:boolean}
/** Human-selected export families; native import activation is a separate choice. */
export interface ReviewedUserDataSelection {git:boolean;harness:boolean;source?:'live'|'retained_originals'}
/** Inert user-data transport. No source runtime, credential or worktree authority. */
export interface ReviewedGitUserData {
  version:1;format:'sha1'|'sha256';
  /** Exact selected common stack; null denotes file ref storage. */
  reftableReview:null|{source:'common_repository';tablesListBase64:string;tables:Array<{name:string;dataBase64:string}>};
  objects:Array<{oid:string;type:'blob'|'tree'|'commit'|'tag';dataBase64:string}>;
  refs:Array<{name:string;oid:string;symbolic?:string}>;
  head:{symbolic:string}|{oid:string};
  /** Exact selected-worktree historical pointer and logs/ORIG_HEAD bytes or absences; never active refs. */
  origHeadReview:{path:'ORIG_HEAD';source:'selected_worktree';dataBase64:string|null;reflogDataBase64:string|null};
  /** Exact selected-worktree fetched-head records or absence; never active fetch/merge authority. */
  fetchHeadReview:{path:'FETCH_HEAD';source:'selected_worktree';dataBase64:string|null};
  /** Exact oldest-first local reflog bytes; never source worktree ownership. */
  /** Exact nonzero reflog endpoints absent from the complete selected object inventory. */
  reflogMissingObjects:string[];
  /** Unknown uppercase extensions are optional observations, never active index instructions. */
  indexOptionalReview:Array<{source:'index'|'sharedindex';signature:string;dataBase64:string}>;
  reflogs:Array<{path:string;dataBase64:string}>;
  index:Array<{mode:string;oid:string;stage:number;path:string;intentToAdd:boolean;assumeUnchanged:boolean;skipWorktree:boolean}>;
  /** Saved conflict stages, in byte-path/stage order; absent stages have no fabricated mode or OID. */
  resolveUndo:Array<{path:string;stages:Array<{stage:number;mode:string;oid:string}>}>;
  /** Exact patterns and collapsed directory originals; destination index is full and settings stay inactive. */
  sparseReview:{patternsBase64:string|null;directories:ReviewedGitUserData['index']};
  /** Exact common-repository originals or explicit absence, in path order; never active Git settings. */
  infoReview:Array<{path:'info/attributes'|'info/exclude';source:'common_repository';dataBase64:string|null}>;
  /** Exact common shallow boundary bytes or absence; applies only to the separate review graph. */
  shallowReview:{path:'shallow';source:'common_repository';dataBase64:string|null};
  /** Exact bounded source retention evidence and index-ordered object times; never active GC policy. */
  packRetentionReview:Array<{packOid:string;packDataBase64:string;indexDataBase64:string;keepDataBase64:string|null;mtimesDataBase64:string|null;objects:Array<{oid:string;mtime:number|null}>}>;
  /** Exact surviving source spans and explicit absence; includes remain literal inactive declarations. */
  configurationOriginalReview:Array<{path:'config'|'config.worktree';source:'common_repository'|'selected_worktree';dataBase64:string|null;removedFields:boolean}>;
  configurationReview:Array<{key:string;value:string;implicitBoolean?:true;source?:'config.worktree'}>;
  exclusions:string[];
}
export interface ReviewedUserData {
  version:1;activation:'inert_review_only';selection:Pick<ReviewedUserDataSelection,'git'|'harness'>;git?:ReviewedGitUserData;
  recreationScope:{absoluteLinks:'refuse';crossRootLinks:'refuse';cyclicLinks:'refuse'|'passive_in_root';specialNodes:'refuse';acl:'not_inspected_preserve_source';xattrs:'not_inspected_preserve_source'};
  /** Selected harness metadata is evidence, never permission to apply executable modes. */
  providerDirectories:Array<{path:string;mode:number;mtimeNs:string}>;
  providerFiles:Array<{path:string;dataBase64:string;removedSecretFields:boolean;metadata?:{mode:number;mtimeNs:string}}>;
  exclusions:string[];
}
