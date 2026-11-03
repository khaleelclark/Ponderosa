import {redactPortableDiagnostic} from './portable-secrets.js';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {promises as fs} from '@ponderosa/native-host/fs';
import {applyExactFileMetadata} from '@ponderosa/native-host';
import {openPortableRegular} from './portable-held-regular.js';

export type NativeGitPermissionNode={path:string;device:bigint;inode:bigint;creationMode?:number;originalMode?:number;unshared?:true};
type Context={gitDir:string;privateDir?:string;worktreePath:string};

/** Configuration reads only: the complete include closure is already owned and relocated. */
function configuration(context:Context,args:string[]):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    execFile('git',['--no-pager','--git-dir='+ (context.privateDir??context.gitDir),'--work-tree='+context.worktreePath,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','config','--includes','--null',...args],{
      cwd:context.gitDir,encoding:'buffer',timeout:30000,maxBuffer:32*1024*1024,
      env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0'},
    },(error,stdout,stderr)=>{
      if(!error&&!stderr.length){resolve(stdout);return;}
      const detail=redactPortableDiagnostic([error?.message,stderr.toString('utf8')].filter(Boolean).join('\n'));
      reject(Object.assign(new Error('Native Git shared-permission configuration failed: '+detail,{cause:error??new Error(detail)}),{code:'ERR_GIT_SHARED_CONFIGURATION'}));
    });
  });
}

/** Git 2.53 setup.c git_config_perm; native Boolean parsing handles its fallback syntax. */
async function sharedRepository(context:Context):Promise<number>{
  const bytes=await configuration(context,['--list']);
  if(!bytes.length||bytes.at(-1)!==0)throw new Error('Native Git returned incomplete configuration records');
  let selected:{value:string;implicit:boolean}|undefined;
  for(const item of new TextDecoder('utf-8',{fatal:true}).decode(bytes).slice(0,-1).split('\0')){
    const split=item.indexOf('\n'),key=split<0?item:item.slice(0,split);
    if(key.toLowerCase()==='core.sharedrepository')selected={value:split<0?'':item.slice(split+1),implicit:split<0};
  }
  if(!selected)return 0;
  if(selected.implicit)return 0o660;
  const value=selected.value;
  if(value==='umask')return 0;
  if(value==='group')return 0o660;
  if(['all','world','everybody'].includes(value))return 0o664;
  const octal=/^[ \t\r\n\v\f]*([+-]?)([0-7]+)$/.exec(value);
  let number:number;
  if(value==='')number=0;
  else if(octal){
    let wide=BigInt('0o'+octal[2]!)*(octal[1]==='-'?-1n:1n);
    // The qualified Linux 64-bit Git build uses strtol followed by int storage.
    // Match its saturation/conversion instead of floating-point truncation.
    if(wide>0x7fffffffffffffffn)wide=0x7fffffffffffffffn;
    if(wide< -0x8000000000000000n)wide= -0x8000000000000000n;
    number=Number(BigInt.asIntN(32,wide));
  }else{
    const bool=await configuration(context,['--type=bool','--get','core.sharedRepository']);
    if(bool.equals(Buffer.from('true\0')))return 0o660;
    if(bool.equals(Buffer.from('false\0')))return 0;
    throw new Error('Native Git returned an invalid shared-permission Boolean');
  }
  if(number===0)return 0;
  if(number===1)return 0o660;
  if(number===2)return 0o664;
  if((number&0o600)!==0o600)throw new Error('Git shared file mode must retain owner read and write access');
  return -(number&0o666);
}

/** Git path.c calc_shared_perm/adjust_shared_perm, with Linux directory inheritance. */
function modeFor(base:number,shared:number,directory:boolean,inheritedSpecial=0):number{
  let mode=base|inheritedSpecial;
  if(!shared)return mode;
  let grants=Math.abs(shared);
  if(!(mode&0o200))grants&=~0o222;
  if(mode&0o100)grants|=(grants&0o444)>>2;
  mode=shared<0?(mode&~0o777)|grants:mode|grants;
  if(directory){mode|=(mode&0o444)>>2;if(mode&0o060)mode|=0o2000;}
  return mode;
}

/** Fresh owned Git nodes only; working-folder root metadata is finalized separately. */
export async function applyNativeGitPermissions(context:Context,directories:NativeGitPermissionNode[],files:NativeGitPermissionNode[]):Promise<void>{
  const shared=await sharedRepository(context);
  if(process.platform!=='linux'||!['x64','arm64','ppc64','s390x','loong64'].includes(process.arch)){
    if(shared)throw Object.assign(new Error('Native shared Git permission semantics are not qualified on this platform'),{code:'ERR_GIT_SHARED_MODE_PLATFORM'});
    return; // Do not claim POSIX modes on the ordinary non-Linux transport path.
  }
  const uid=BigInt(process.geteuid!()),groups=new Set([process.getegid!(),...process.getgroups!()].map(BigInt));
  const repository=await fs.lstat(context.gitDir,{bigint:true});
  if(!repository.isDirectory()||repository.uid!==uid)throw new Error('Native Git sharing requires its currently owned storage directory');
  const all=[...files.map(node=>({node,directory:false})),...directories.map(node=>({node,directory:true})).sort((a,b)=>b.node.path.length-a.node.path.length)];
  // Preflight all actual owners/groups before changing any permission. Never
  // adopt source principals, chown, or silently clear a denied setgid request.
  const plans:Array<{node:NativeGitPermissionNode;directory:boolean;mode:number;group:bigint}>=[];
  for(const {node,directory} of all){
    const stat=await fs.lstat(node.path,{bigint:true}),sharing=node.unshared?0:shared;
    if(stat.dev!==node.device||stat.ino!==node.inode||stat.uid!==uid||(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1n))throw new Error('Native Git permission node identity or owner changed');
    const creationMode=node.creationMode??(Number(stat.mode)&0o7777);
    const mode=node.originalMode??modeFor(creationMode&0o777,sharing,directory,creationMode&0o7000);
    if((mode&0o2070)&&(!groups.has(stat.gid)||sharing&&stat.gid!==repository.gid))throw new Error('Native Git sharing requires the observed storage group and current group membership');
    plans.push({node,directory,mode,group:stat.gid});
  }
  for(const {node,directory,mode,group} of plans){
    const handle=directory?await fs.open(node.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW):await openPortableRegular(node.path);
    try{
      const before=await handle.stat({bigint:true});
      if(before.dev!==node.device||before.ino!==node.inode||before.uid!==uid||before.gid!==group||(directory?!before.isDirectory():!before.isFile()||before.nlink!==1n))throw new Error('Native Git permission descriptor changed before application');
      const observed=applyExactFileMetadata({fd:handle.fd,expectedDevice:node.device,expectedInode:node.inode,kind:directory?'directory':'file',mode,mtimeNs:before.mtimeNs});
      const after=await handle.stat({bigint:true}),named=await fs.lstat(node.path,{bigint:true});
      if(observed.mode!==mode||observed.mtimeNs!==before.mtimeNs||after.dev!==node.device||after.ino!==node.inode||after.uid!==before.uid||after.gid!==before.gid||Number(after.mode&0o7777n)!==mode||named.dev!==node.device||named.ino!==node.inode||named.uid!==after.uid||named.gid!==after.gid)throw new Error('Native Git shared permissions differ after exact application');
      await handle.sync();
    }finally{await handle.close();}
  }
}
