/** Human-selected families; settings remain inactive after import. */
export interface ReviewedUserDataSelection {git:boolean;harness:boolean}
/** Inert user-data transport. No source runtime, credential or worktree authority. */
export interface ReviewedGitUserData {
  version:1;format:'sha1'|'sha256';
  objects:Array<{oid:string;type:'blob'|'tree'|'commit'|'tag';dataBase64:string}>;
  refs:Array<{name:string;oid:string;symbolic?:string}>;
  head:{symbolic:string}|{oid:string};
  /** Exact oldest-first local reflog bytes; never source worktree ownership. */
  reflogs:Array<{path:string;dataBase64:string}>;
  index:Array<{mode:string;oid:string;stage:number;path:string}>;
  configurationReview:Array<{key:string;value:string;implicitBoolean?:true}>;
  exclusions:string[];
}
export interface ReviewedUserData {
  version:1;activation:'inert_review_only';selection:ReviewedUserDataSelection;git?:ReviewedGitUserData;
  recreationScope:{absoluteLinks:'refuse';crossRootLinks:'refuse';cyclicLinks:'refuse';specialNodes:'refuse';acl:'not_inspected_preserve_source';xattrs:'not_inspected_preserve_source'};
  providerFiles:Array<{path:string;dataBase64:string;removedSecretFields:boolean}>;
  exclusions:string[];
}
