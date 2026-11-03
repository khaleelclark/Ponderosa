/** Explicit import authority; export family selection never implies activation. */
export interface ReviewedUserDataActivation {git:boolean;harness:boolean;
  /** Human-selected absolute prefix relocation into the explicitly imported destination roots. */
  gitPathMappings?:Array<{source:string;destination:string}>;
}
/** Human-selected export families; native import activation is a separate choice. */
export interface ReviewedUserDataSelection {
  git:boolean;harness:boolean;source?:'live'|'retained_originals';
  /** Explicit capture of configured nonsecret Git files/hooks outside the selected working roots. */
  externalGitDependencies?:true;
  /** Explicit complete nonsecret user.* names AND values; absence never grants capture. */
  extendedMetadata?:{userXattrs:boolean;posixAcl:boolean};
  /** Metadata only. Evidence for devices/sockets never grants recreation or adoption. */
  persistentNodes?:{fifo:boolean;evidenceOnly:boolean};
}
/** Separate current human restore choice, never authority imported from a package. */
export interface ReviewedMetadataActivation {
  sourceQualifier:string;destinationQualifier:string;
  principalMappings:Array<{sourceQualifier:string;kind:'user'|'group';sourceId:string;destinationId:string}>;
  replaceInheritedUserAndPosixAcl:true;
  rootRefs:string[];
  fifo:boolean;
}
/** Incoming source Agent selectors, resolved only inside one selected full export. */
export interface GitStorageSelection {
  id:string;worktreeAgentId:string;storageAgentId:string;relativePath:string;role:'common'|'private'|'module';
}
/** Inert package topology. Both roots must belong to the final package closure. */
export interface PortableGitStorageBinding {
  id:string;worktreeRootRef:string;storageRootRef:string;relativePath:string;role:'common'|'private'|'module';
  /** Exact captured source association. Historical evidence, never current source/destination authority. */
  capture?:{version:1;currentAuthority:false;reviewSha256?:string;roots:Array<{rootRef:string;sourcePath:string;identity:string}>;
    records:Array<{rootRef:string;relativePath:string;identity:string;dataBase64?:string;absent?:true;
      /** Nonsecret exact core.worktree scalar bound to the original config hash. */
      moduleWorktree?:{value:string;sha256:string}}>};
}
/** Selected visible filesystem metadata. Historical IDs require an explicit destination map. */
export interface PortableFilesystemMetadata {
  version:1;sourceQualifier:string;allNamespacesComplete:false;
  nodes:Array<{path:string;kind:'file'|'directory';mode:number;mtimeNs:string;ownerId:string;groupId:string;
    userAttributes:Array<{nameBase64:string;valueBase64:string}>;accessAclBase64:string|null;defaultAclBase64:string|null}>;
  persistentNodes:Array<{path:string;kind:'fifo'|'socket'|'character'|'block';mode:number;mtimeNs:string;ownerId:string;groupId:string;deviceMajor:number;deviceMinor:number;extendedMetadata?:Pick<PortableFilesystemMetadata['nodes'][number],'userAttributes'|'accessAclBase64'|'defaultAclBase64'>}>;
}
/** Inert user-data transport. No source runtime, credential or worktree authority. */
export interface ReviewedGitUserData {
  version:1;format:'sha1'|'sha256';
  /** Historical path-resolution provenance for includes; never a source read or destination grant. */
  configurationSourceDirectories?:{common:string;private:string;home?:string};
  /** Exact selected common stack; null denotes file ref storage. */
  reftableReview:null|{source:'common_repository';tablesListBase64:string;tables:Array<{name:string;dataBase64:string}>;
    /** Original selected linked-worktree stack, independently ordered from the common stack. */
    selectedWorktree?:{tablesListBase64:string;tables:Array<{name:string;dataBase64:string}>}};
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
  /** Recursively selected native modules; paths are inert original provenance. */
  modules?:Array<{name:string;source:{storagePath:string;worktreePath:string;coreWorktree:string;configurationSha256:string;initialized:boolean;embedded?:true};
    worktreeRelativePath:string|null;git:ReviewedGitUserData;originals:ReviewedUserData['providerFiles']}>;
  exclusions:string[];
}
export interface ReviewedUserData {
  version:1;activation:'inert_review_only';
  /** Retained verbatim with the canonical original; never activates or recaptures source paths. */
  associationReview?:PortableGitStorageBinding[];
  gitExternalDependencies?:ReviewedGitExternalDependencies;
  selection:Omit<ReviewedUserDataSelection,'source'>;git?:ReviewedGitUserData;
  filesystemMetadata?:PortableFilesystemMetadata;
  recreationScope:{absoluteLinks:'refuse';crossRootLinks:'refuse';cyclicLinks:'refuse'|'passive_in_root';specialNodes:'refuse';acl:'not_inspected_preserve_source';xattrs:'not_inspected_preserve_source'};
  /** Selected harness metadata is evidence, never permission to apply executable modes. */
  providerDirectories:Array<{path:string;mode:number;mtimeNs:string}>;
  providerFiles:Array<{path:string;dataBase64:string;removedSecretFields:boolean;metadata?:{mode:number;mtimeNs:string}}>;
  exclusions:string[];
}

export interface ReviewedGitExternalDependencies {
  version:1;
  files:Array<{sourcePath:string;dataBase64:string;mode:number;mtimeNs:string;config?:true;removedSecretFields?:true}>;
  directories:Array<{sourcePath:string;mode:number;mtimeNs:string;root?:true}>;
  links:Array<{sourcePath:string;targetSourcePath:string;kind:'symlink'|'hardlink';mtimeNs?:string}>;
  absentPaths:string[];
  omittedPaths:string[];
  bindings:Array<{kind:'include'|'hooks'|'attributes'|'excludes';sourceConfigPath:string;rawValue:string;resolvedPath:string;context:'config'|'worktree'|'gitdir'}>;
}
