// Descriptor-only Linux metadata. No path reopen, principal lookup or service activation.
namespace portable_metadata {
constexpr size_t kNames = 65536, kCount = 256, kValue = 65536, kTotal = 1048576;
napi_value Property(napi_env env, napi_value object, const char* key) {
  napi_value value;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) throw std::runtime_error("missing input field");
  return value;
}
void Set(napi_env env, napi_value object, const char* key, napi_value value) { napi_set_named_property(env, object, key, value); }
napi_value Text(napi_env env, const std::string& text) { napi_value v; napi_create_string_utf8(env,text.data(),text.size(),&v); return v; }
napi_value Number(napi_env env, uint32_t number) { napi_value v; napi_create_uint32(env,number,&v); return v; }
napi_value Big(napi_env env, uint64_t number) { napi_value v; napi_create_bigint_uint64(env,number,&v); return v; }
napi_value Object(napi_env env) { napi_value v; napi_create_object(env,&v); return v; }
napi_value Bytes(napi_env env, const std::string& bytes) { napi_value v; napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&v); return v; }
std::string String(napi_env env, napi_value v, size_t cap = 256) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env,v,nullptr,0,&size) != napi_ok || size > cap) throw std::runtime_error("invalid bounded string");
  std::string out;
  if (!ReadUtf8(env,v,&out)) throw std::runtime_error("invalid string");
  return out;
}
std::string Buffer(napi_env env, napi_value v, size_t cap) {
  void* data; size_t size;
  if (napi_get_buffer_info(env,v,&data,&size) != napi_ok || size > cap) throw std::runtime_error("invalid bounded buffer");
  return std::string(static_cast<char*>(data),size);
}
uint32_t Integer(napi_env env, napi_value v, uint32_t max) {
  double n;
  if (napi_get_value_double(env,v,&n) != napi_ok || !std::isfinite(n) || n < 0 || n > max || std::floor(n) != n) throw std::runtime_error("invalid integer");
  return static_cast<uint32_t>(n);
}
uint64_t Identity(napi_env env, napi_value v) {
  uint64_t n; bool exact;
  if (napi_get_value_bigint_uint64(env,v,&n,&exact) != napi_ok || !exact) throw std::runtime_error("invalid bigint identity");
  return n;
}
bool Literal(napi_env env, napi_value obj, const char* key, const char* expected) { return String(env,Property(env,obj,key)) == expected; }
napi_value Failure(napi_env env, const char* code, const std::string& message) {
  ThrowCode(env,code,message); return nullptr;
}
#ifdef __linux__
struct Target { int fd; uint64_t dev, ino; bool directory; uint64_t links=1; };
Target ReadTarget(napi_env env, napi_value input) {
  Target t;
  t.fd = Integer(env,Property(env,input,"fd"),INT_MAX);
  t.dev = Identity(env,Property(env,input,"expectedDevice")); t.ino = Identity(env,Property(env,input,"expectedInode"));
  const std::string kind = String(env,Property(env,input,"kind"));
  if (kind != "file" && kind != "directory") throw std::runtime_error("unsupported target kind");
  bool hasLinks=false;
  if(napi_has_named_property(env,input,"expectedLinkCount",&hasLinks)!=napi_ok)throw std::runtime_error("invalid selected link count");
  if(hasLinks){t.links=Identity(env,Property(env,input,"expectedLinkCount"));if(t.links<1||t.links>10000)throw std::runtime_error("selected link count exceeds its bound");}
  t.directory = kind == "directory"; return t;
}
bool Matches(const Target& t, const struct stat& s) {
  return uint64_t(s.st_dev) == t.dev && uint64_t(s.st_ino) == t.ino &&
      (t.directory ? S_ISDIR(s.st_mode) : S_ISREG(s.st_mode) && uint64_t(s.st_nlink) == t.links);
}
struct stat Stat(const Target& t) {
  struct stat s{};
  if (fstat(t.fd,&s) != 0 || !Matches(t,s)) throw std::runtime_error("held target identity/kind/link count differs");
  return s;
}
bool SameObservation(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink &&
      a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_rdev == b.st_rdev &&
      a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
      a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
}
struct Attribute { std::string name, value; int error = 0; bool absent = false; };
Attribute ReadAttribute(int fd, const std::string& name) {
  Attribute a; a.name = name;
  const ssize_t size = fgetxattr(fd,name.c_str(),nullptr,0);
  if (size < 0) { a.error = errno; a.absent = errno == ENODATA; return a; }
  if (size > ssize_t(kValue)) { a.error = E2BIG; return a; }
  // A zero-length value still needs a nonzero-size read to detect concurrent growth.
  std::vector<char> bytes(std::max<ssize_t>(size,1));
  const ssize_t got = fgetxattr(fd,name.c_str(),bytes.data(),bytes.size());
  if (got < 0) { a.error = errno; return a; }
  if (got != size) { a.error = EAGAIN; return a; }
  a.value.assign(bytes.data(),got); return a;
}
struct Inventory { std::vector<Attribute> attributes; int error = 0; };
Inventory ReadInventory(int fd) {
  Inventory out;
  const ssize_t size = flistxattr(fd,nullptr,0);
  if (size < 0) { out.error = errno; return out; }
  if (size > ssize_t(kNames)) { out.error = E2BIG; return out; }
  std::vector<char> bytes(std::max<ssize_t>(size,1));
  const ssize_t got = flistxattr(fd,bytes.data(),bytes.size());
  if (got < 0 || got != size) { out.error = got < 0 ? errno : EAGAIN; return out; }
  size_t offset = 0, total = 0;
  while (offset < size_t(got)) {
    const void* end = std::memchr(bytes.data()+offset,0,size_t(got)-offset);
    if (!end || end == bytes.data()+offset || out.attributes.size() == kCount) { out.error = E2BIG; return out; }
    const std::string name(bytes.data()+offset,static_cast<const char*>(end)-(bytes.data()+offset));
    if (name.size() > 255) { out.error = E2BIG; return out; }
    auto a = ReadAttribute(fd,name); total += a.value.size();
    if (total > kTotal) { out.error = E2BIG; return out; }
    out.attributes.push_back(std::move(a)); offset += name.size()+1;
  }
  std::sort(out.attributes.begin(),out.attributes.end(),[](const Attribute& a,const Attribute& b){return a.name < b.name;});
  for (size_t i=1;i<out.attributes.size();++i) if (out.attributes[i-1].name == out.attributes[i].name) out.error = EAGAIN;
  return out;
}
struct AclEntry { uint16_t tag, permissions; uint32_t id; };
uint16_t LE16(const char* p) { return uint16_t(uint8_t(p[0])) | uint16_t(uint8_t(p[1]))<<8; }
uint32_t LE32(const char* p) { return uint32_t(LE16(p)) | uint32_t(LE16(p+2))<<16; }
void Put32(std::string& s,size_t p,uint32_t n) { for(int i=0;i<4;++i)s[p+i]=char(n>>(8*i)); }
std::vector<AclEntry> ParseAcl(const std::string& raw) {
  if (raw.size()<4 || LE32(raw.data())!=2 || (raw.size()-4)%8 || (raw.size()-4)/8>kCount) throw std::runtime_error("unsupported or malformed Linux POSIX ACL v2");
  std::vector<AclEntry> entries; int phase=0; bool named=false,mask=false; uint32_t last=0; bool have=false;
  for(size_t p=4;p<raw.size();p+=8) {
    AclEntry e{LE16(raw.data()+p),LE16(raw.data()+p+2),LE32(raw.data()+p+4)};
    if(e.permissions>7)throw std::runtime_error("invalid ACL permissions");
    if(e.tag==1 && phase==0) {phase=1;have=false;}
    else if(e.tag==2 && phase==1) {if(e.id==UINT32_MAX || (have && e.id<=last))throw std::runtime_error("invalid ACL user ordering");named=true;last=e.id;have=true;}
    else if(e.tag==4 && phase==1) {phase=2;have=false;}
    else if(e.tag==8 && phase==2) {if(e.id==UINT32_MAX || (have && e.id<=last))throw std::runtime_error("invalid ACL group ordering");named=true;last=e.id;have=true;}
    else if(e.tag==16 && phase==2) {phase=3;mask=true;}
    else if(e.tag==32 && (phase==3 || (phase==2 && !named)))phase=4;
    else throw std::runtime_error("invalid ACL entry order/mask");
    if(e.tag!=2 && e.tag!=8 && e.id!=UINT32_MAX)throw std::runtime_error("invalid ACL undefined principal");
    entries.push_back(e);
  }
  if(phase!=4 || (named && !mask))throw std::runtime_error("incomplete ACL");
  return entries;
}
const char* AclTag(uint16_t tag) {
  switch(tag){case 1:return "owner";case 2:return "user";case 4:return "owning-group";case 8:return "group";case 16:return "mask";default:return "other";}
}
napi_value AttributeValue(napi_env env,const Attribute& a,bool acl,const std::string& qualifier) {
  napi_value out=Object(env); Set(env,out,"name",Bytes(env,a.name));
  const char* state = a.absent ? "absent" : a.error == EOPNOTSUPP ? "unsupported" : a.error ? "error" : "value";
  Set(env,out,"state",Text(env,state));
  if(a.error && !a.absent)Set(env,out,"errorNumber",Number(env,a.error));
  if(!a.error)Set(env,out,"value",Bytes(env,a.value));
  if(acl) {
    Set(env,out,"dialect",Text(env,"linux-posix-acl-v2"));
    if(!a.error) {
      try {
        auto entries=ParseAcl(a.value);napi_value list;napi_create_array_with_length(env,entries.size(),&list);
        for(size_t i=0;i<entries.size();++i) {
          napi_value item=Object(env);Set(env,item,"tag",Text(env,AclTag(entries[i].tag)));Set(env,item,"permissions",Number(env,entries[i].permissions));
          if(entries[i].tag==2 || entries[i].tag==8){Set(env,item,"sourceId",Number(env,entries[i].id));Set(env,item,"sourceQualifier",Text(env,qualifier));}
          napi_set_element(env,list,i,item);
        }
        Set(env,out,"entries",list);
      } catch(const std::exception&) {Set(env,out,"state",Text(env,"unsupported"));}
    }
  }
  return out;
}
napi_value Inspect(napi_env env,const Target& target,const std::string& qualifier) {
  const auto before=Stat(target); const auto inventory=ReadInventory(target.fd);
  const auto access=ReadAttribute(target.fd,"system.posix_acl_access"), defaults=ReadAttribute(target.fd,"system.posix_acl_default");
  const auto after=Stat(target);
  if(!SameObservation(before,after))throw std::runtime_error("metadata changed during inspection");
  napi_value out=Object(env),identity=ExactMetadataEvidence(env,after);
  Set(env,identity,"ownerId",Number(env,after.st_uid));Set(env,identity,"groupId",Number(env,after.st_gid));
  Set(env,out,"supported",Boolean(env,true));Set(env,out,"identity",identity);Set(env,out,"sourceQualifier",Text(env,qualifier));
  Set(env,out,"allNamespacesComplete",Boolean(env,false));
  Set(env,out,"inventoryState",Text(env,inventory.error ? (inventory.error==EOPNOTSUPP ? "unsupported":"error") : "complete-visible"));
  if(inventory.error)Set(env,out,"inventoryErrorNumber",Number(env,inventory.error));
  napi_value attrs;napi_create_array_with_length(env,inventory.attributes.size(),&attrs);
  for(size_t i=0;i<inventory.attributes.size();++i)napi_set_element(env,attrs,i,AttributeValue(env,inventory.attributes[i],false,qualifier));
  Set(env,out,"attributes",attrs);
  Set(env,out,"accessAcl",AttributeValue(env,access,true,qualifier));Set(env,out,"defaultAcl",AttributeValue(env,defaults,true,qualifier));
  napi_value spaces;napi_create_array_with_length(env,5,&spaces);
  const char* names[]={"user","system.posix_acl","security","trusted","other"};
  for(size_t i=0;i<5;++i){auto v=Object(env);Set(env,v,"name",Text(env,names[i]));Set(env,v,"state",Text(env,i==3 ? "not-enumerable":"visible-only"));napi_set_element(env,spaces,i,v);}
  Set(env,out,"namespaces",spaces);return out;
}
struct Mapping {std::string kind;uint32_t source,destination;};
uint32_t MapPrincipal(const std::vector<Mapping>& maps,const std::string& kind,uint32_t source) {
  for(const auto& m:maps)if(m.kind==kind && m.source==source)return m.destination;
  throw std::runtime_error("missing explicit source-qualified principal mapping");
}
std::string MapAcl(const std::string& raw,const std::vector<Mapping>& maps,bool access,uint32_t mode) {
  auto entries=ParseAcl(raw);
  if(access && entries.size()==3)throw std::runtime_error("mode-equivalent access ACL must use explicit absence plus mode");
  uint32_t owner=0,group=0,other=0; bool mask=false;
  for(auto& e:entries) {
    if(e.tag==2 || e.tag==8)e.id=MapPrincipal(maps,e.tag==2 ? "user":"group",e.id);
    if(e.tag==1)owner=e.permissions;
    if(e.tag==4 && !mask)group=e.permissions;
    if(e.tag==16){group=e.permissions;mask=true;}
    if(e.tag==32)other=e.permissions;
  }
  if(access && ((owner<<6)|(group<<3)|other)!=(mode&0777))throw std::runtime_error("mode differs from mapped ACL owner/mask/other");
  std::sort(entries.begin(),entries.end(),[](const AclEntry& a,const AclEntry& b){return a.tag!=b.tag ? a.tag<b.tag:a.id<b.id;});
  std::string out=raw;
  for(size_t i=0;i<entries.size();++i){const auto& e=entries[i];size_t p=4+i*8;out[p]=char(e.tag);out[p+1]=0;out[p+2]=char(e.permissions);out[p+3]=0;Put32(out,p+4,e.id);}
  ParseAcl(out);return out;
}
bool SameInventory(const Inventory& a,const Inventory& b) {
  if(a.error || b.error || a.attributes.size()!=b.attributes.size())return false;
  for(size_t i=0;i<a.attributes.size();++i)if(a.attributes[i].error || b.attributes[i].error || a.attributes[i].name!=b.attributes[i].name || a.attributes[i].value!=b.attributes[i].value)return false;
  return true;
}
napi_value Partial(napi_env env,const std::string& message,napi_value observed) {
  napi_value error,text=Text(env,message);napi_create_error(env,nullptr,text,&error);
  Set(env,error,"code",Text(env,"ERR_PORTABLE_METADATA_PARTIAL"));Set(env,error,"partialStatePossible",Boolean(env,true));Set(env,error,"observed",observed);napi_throw(env,error);return nullptr;
}
#endif
} // namespace portable_metadata

napi_value InspectExtendedMetadata(napi_env env,napi_callback_info info) {
#ifdef __linux__
  try {
    size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
    if(argc!=1)throw std::runtime_error("one metadata input required");
    auto t=portable_metadata::ReadTarget(env,args[0]);auto q=portable_metadata::String(env,portable_metadata::Property(env,args[0],"sourceQualifier"));
    if(q.empty())throw std::runtime_error("source host/user namespace qualifier required");
    return portable_metadata::Inspect(env,t,q);
  }catch(const std::exception& e){return portable_metadata::Failure(env,"ERR_PORTABLE_METADATA_INSPECT",e.what());}
#else
  return portable_metadata::Failure(env,"ERR_PORTABLE_METADATA_UNSUPPORTED","Extended metadata requires Linux fd xattrs/POSIX ACL v2; platform metadata is not empty");
#endif
}

napi_value ApplyExtendedMetadata(napi_env env,napi_callback_info info) {
#ifdef __linux__
  using namespace portable_metadata;
  bool attempted=false;Target target{};std::string qualifier,destinationQualifier;
  try {
    size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(argc!=1)throw std::runtime_error("one restore input required");
    auto input=args[0];target=ReadTarget(env,input);auto before=Stat(target);
    if(!Literal(env,input,"restore","replace-user-and-posix-acl"))throw std::runtime_error("explicit exact selected restore required");
    qualifier=String(env,Property(env,input,"sourceQualifier"));if(qualifier.empty())throw std::runtime_error("source qualifier required");
    destinationQualifier=String(env,Property(env,input,"destinationQualifier"));if(destinationQualifier.empty())throw std::runtime_error("destination host/user namespace qualifier required");
    const uint32_t sourceOwner=Integer(env,Property(env,input,"sourceOwnerId"),UINT32_MAX-1),sourceGroup=Integer(env,Property(env,input,"sourceGroupId"),UINT32_MAX-1);
    const uint32_t owner=Integer(env,Property(env,input,"destinationOwnerId"),UINT32_MAX-1),group=Integer(env,Property(env,input,"destinationGroupId"),UINT32_MAX-1);
    const uint32_t mode=Integer(env,Property(env,input,"mode"),07777);
    if(before.st_uid!=owner || before.st_gid!=group)throw std::runtime_error("destination ownership differs; no chown performed");
    std::vector<Mapping> maps;auto mapping=Property(env,input,"principalMappings");uint32_t count;bool array=false;
    if(napi_is_array(env,mapping,&array)!=napi_ok || !array || napi_get_array_length(env,mapping,&count)!=napi_ok || count>2*kCount+2)throw std::runtime_error("invalid bounded principal mappings");
    for(uint32_t i=0;i<count;++i){napi_value item;napi_get_element(env,mapping,i,&item);Mapping m;
      if(String(env,Property(env,item,"sourceQualifier"))!=qualifier)throw std::runtime_error("foreign source qualifier");
      m.kind=String(env,Property(env,item,"kind"));m.source=Integer(env,Property(env,item,"sourceId"),UINT32_MAX-1);m.destination=Integer(env,Property(env,item,"destinationId"),UINT32_MAX-1);
      if(m.kind!="user" && m.kind!="group")throw std::runtime_error("unknown principal kind");
      for(const auto& prior:maps)if(prior.kind==m.kind && prior.source==m.source)throw std::runtime_error("duplicate principal mapping");maps.push_back(m);
    }
    if(MapPrincipal(maps,"user",sourceOwner)!=owner || MapPrincipal(maps,"group",sourceGroup)!=group)throw std::runtime_error("owner/group mapping differs from destination");
    auto acl=[&](const char* name,bool access){auto value=Property(env,input,name);napi_valuetype type;napi_typeof(env,value,&type);return type==napi_null ? Attribute{access ? "system.posix_acl_access":"system.posix_acl_default","",ENODATA,true}:Attribute{access ? "system.posix_acl_access":"system.posix_acl_default",MapAcl(Buffer(env,value,kValue),maps,access,mode),0,false};};
    auto access=acl("accessAcl",true),defaults=acl("defaultAcl",false);
    if(!target.directory && !defaults.absent)throw std::runtime_error("default ACL requires directory");
    auto attrs=Property(env,input,"attributes");array=false;
    if(napi_is_array(env,attrs,&array)!=napi_ok || !array || napi_get_array_length(env,attrs,&count)!=napi_ok || count>kCount)throw std::runtime_error("invalid bounded user attributes");
    Inventory wanted;size_t total=access.value.size()+defaults.value.size();
    for(uint32_t i=0;i<count;++i){napi_value item;napi_get_element(env,attrs,i,&item);Attribute a;
      a.name=Buffer(env,Property(env,item,"name"),255);a.value=Buffer(env,Property(env,item,"value"),kValue);
      if(a.name.size()<=5 || a.name.compare(0,5,"user.")!=0 || a.name.find('\0')!=std::string::npos)throw std::runtime_error("unsupported required xattr namespace; only user.* can be applied");
      total+=a.value.size();if(total>kTotal)throw std::runtime_error("aggregate xattr cap exceeded");wanted.attributes.push_back(std::move(a));
    }
    std::sort(wanted.attributes.begin(),wanted.attributes.end(),[](const Attribute& a,const Attribute& b){return a.name<b.name;});
    for(size_t i=1;i<wanted.attributes.size();++i)if(wanted.attributes[i-1].name==wanted.attributes[i].name)throw std::runtime_error("duplicate user attribute");
    const auto original=ReadInventory(target.fd);if(original.error)throw std::runtime_error("destination namespace inventory unavailable");
    for(const auto& a:original.attributes){
      if(a.error)throw std::runtime_error("destination attribute value unreadable");
      if(a.name.compare(0,5,"user.")!=0 && a.name!="system.posix_acl_access" && a.name!="system.posix_acl_default")
        throw std::runtime_error("destination has unsupported security/trusted/other namespace; no policy metadata changed");
    }
    const auto oldAccess=ReadAttribute(target.fd,access.name),oldDefault=ReadAttribute(target.fd,defaults.name);
    if((oldAccess.error && !oldAccess.absent) || (oldDefault.error && !oldDefault.absent))throw std::runtime_error("destination ACL unsupported/unreadable");
    if(!access.absent)wanted.attributes.push_back(access);if(!defaults.absent)wanted.attributes.push_back(defaults);
    if(wanted.attributes.size()>kCount)throw std::runtime_error("destination namespace count cap exceeded");
    std::sort(wanted.attributes.begin(),wanted.attributes.end(),[](const Attribute& a,const Attribute& b){return a.name<b.name;});
    if(!SameObservation(before,Stat(target)))throw std::runtime_error("destination changed before mutation");
    attempted=true;
    auto remove=[&](const std::string& name){if(fremovexattr(target.fd,name.c_str())!=0 && errno!=ENODATA)throw std::runtime_error(std::string("selected xattr removal failed: ")+std::strerror(errno));};
    for(const auto& a:original.attributes)if(a.name.compare(0,5,"user.")==0 && std::none_of(wanted.attributes.begin(),wanted.attributes.end(),[&](const Attribute& w){return w.name==a.name;}))remove(a.name);
    for(const auto& a:wanted.attributes)if(a.name.compare(0,5,"user.")==0 && fsetxattr(target.fd,a.name.c_str(),a.value.data(),a.value.size(),0)!=0)throw std::runtime_error(std::string("selected user xattr application failed: ")+std::strerror(errno));
    for(const auto& a:{access,defaults}) {if(a.absent)remove(a.name);else if(fsetxattr(target.fd,a.name.c_str(),a.value.data(),a.value.size(),0)!=0)throw std::runtime_error(std::string("mapped POSIX ACL application failed: ")+std::strerror(errno));}
    if(fchmod(target.fd,mode)!=0)throw std::runtime_error(std::string("ACL-compatible mode application failed: ")+std::strerror(errno));
    const auto after=Stat(target);if(after.st_uid!=owner || after.st_gid!=group || (after.st_mode&07777)!=mode || !SameInventory(wanted,ReadInventory(target.fd)))throw std::runtime_error("exact extended metadata readback differs");
    const auto finalAccess=ReadAttribute(target.fd,access.name),finalDefault=ReadAttribute(target.fd,defaults.name);
    auto same=[](const Attribute& a,const Attribute& b){return a.absent ? b.absent:!b.error && b.value==a.value;};
    if(!same(access,finalAccess) || !same(defaults,finalDefault))throw std::runtime_error("exact ACL absence/readback differs");
    return Inspect(env,target,destinationQualifier);
  } catch(const std::exception& e) {
    if(!attempted)return Failure(env,"ERR_PORTABLE_METADATA_PREFLIGHT",e.what());
    napi_value observed=Null(env);try{observed=Inspect(env,target,destinationQualifier);}catch(const std::exception&){}
    return Partial(env,e.what(),observed);
  }
#else
  return portable_metadata::Failure(env,"ERR_PORTABLE_METADATA_UNSUPPORTED","Extended metadata application requires Linux; no metadata changed");
#endif
}

namespace portable_metadata {
#ifdef __linux__
struct Parent { int fd; uint64_t dev,ino; std::string leaf; };
Parent ReadParent(napi_env env,napi_value input) {
  Parent p;
  p.fd=Integer(env,Property(env,input,"parentFd"),INT_MAX);
  p.dev=Identity(env,Property(env,input,"expectedParentDevice"));p.ino=Identity(env,Property(env,input,"expectedParentInode"));
  p.leaf=String(env,Property(env,input,"leaf"),255);
  if(!SafeLeaf(p.leaf))throw std::runtime_error("one canonical leaf required");
  return p;
}
void CheckParent(const Parent& p) {
  struct stat s{};
  if(fstat(p.fd,&s)!=0 || !S_ISDIR(s.st_mode) || uint64_t(s.st_dev)!=p.dev || uint64_t(s.st_ino)!=p.ino)throw std::runtime_error("held parent identity differs");
}
struct timespec Time(napi_env env,napi_value value) {
  size_t count=0;
  if(napi_get_value_bigint_words(env,value,nullptr,&count,nullptr)!=napi_ok || count>2)throw std::runtime_error("nanosecond timestamp outside native representation");
  uint64_t words[2]={};size_t capacity=2;int negative=0;
  if(napi_get_value_bigint_words(env,value,&negative,&capacity,words)!=napi_ok || words[1]>>63)throw std::runtime_error("invalid nanosecond timestamp");
  __int128 n=static_cast<__int128>((static_cast<unsigned __int128>(words[1])<<64)|words[0]);if(negative)n=-n;
  __int128 sec=n/1000000000,ns=n%1000000000;if(ns<0){--sec;ns+=1000000000;}
  if(sec<static_cast<__int128>(std::numeric_limits<time_t>::lowest()) || sec>static_cast<__int128>(std::numeric_limits<time_t>::max()))throw std::runtime_error("timestamp does not fit time_t");
  return {static_cast<time_t>(sec),static_cast<long>(ns)};
}
bool Special(mode_t mode) {return S_ISFIFO(mode)||S_ISSOCK(mode)||S_ISCHR(mode)||S_ISBLK(mode);}
struct stat ReadNode(const Parent& p,int fd) {
  CheckParent(p);struct stat held{},named{},after{};
  if(fstat(fd,&held)!=0 || !Special(held.st_mode) || held.st_nlink!=1 ||
      fstatat(p.fd,p.leaf.c_str(),&named,AT_SYMLINK_NOFOLLOW)!=0 || !SameObservation(held,named) ||
      held.st_rdev!=named.st_rdev || fstat(fd,&after)!=0 || !SameObservation(held,after))throw std::runtime_error("persistent node identity/type/link/parent binding differs");
  CheckParent(p);return after;
}
napi_value NodeEvidence(napi_env env,const Parent& p,const struct stat& s) {
  auto out=ExactMetadataEvidence(env,s);
  Set(env,out,"kind",Text(env,S_ISFIFO(s.st_mode)?"fifo":S_ISSOCK(s.st_mode)?"socket":S_ISCHR(s.st_mode)?"character":"block"));
  Set(env,out,"linkCount",Big(env,s.st_nlink));Set(env,out,"ownerId",Number(env,s.st_uid));Set(env,out,"groupId",Number(env,s.st_gid));
  Set(env,out,"deviceMajor",Number(env,major(s.st_rdev)));Set(env,out,"deviceMinor",Number(env,minor(s.st_rdev)));
  Set(env,out,"parentDevice",Big(env,p.dev));Set(env,out,"parentInode",Big(env,p.ino));return out;
}
#endif
}

napi_value InspectPersistentNode(napi_env env,napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH)
  using namespace portable_metadata;
  try {
    size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(argc!=1)throw std::runtime_error("one persistent node input required");
    const auto parent=ReadParent(env,args[0]);CheckParent(parent);DescriptorSet owned;
    const int fd=openat(parent.fd,parent.leaf.c_str(),O_PATH|O_NOFOLLOW|O_CLOEXEC);
    if(fd<0)throw std::runtime_error(std::string("metadata-only node open failed: ")+std::strerror(errno));owned.values.push_back(fd);
    return NodeEvidence(env,parent,ReadNode(parent,fd));
  }catch(const std::exception& e){return Failure(env,"ERR_PERSISTENT_NODE_INSPECT",e.what());}
#else
  return portable_metadata::Failure(env,"ERR_PERSISTENT_NODE_UNSUPPORTED","Persistent node inspection requires Linux O_PATH; no content opened");
#endif
}

napi_value CreatePersistentNode(napi_env env,napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH) && defined(AT_EMPTY_PATH) && defined(SYS_fchmodat2)
  using namespace portable_metadata;
  bool attempted=false;Parent parent{};int fd=-1;DescriptorSet owned;
  try {
    size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);if(argc!=1)throw std::runtime_error("one persistent node creation input required");
    auto input=args[0];parent=ReadParent(env,input);CheckParent(parent);
    if(!Literal(env,input,"kind","fifo"))throw std::runtime_error("only FIFO creation supported; sockets need service ownership, devices need explicit device mapping/grant");
    const uint32_t mode=Integer(env,Property(env,input,"mode"),07777);const auto modified=Time(env,Property(env,input,"mtimeNs"));
    // Probe only invalid descriptors; never chmod/touch the parent to discover support.
    errno=0;const long chmod_probe=syscall(SYS_fchmodat2,-1,"",0,AT_EMPTY_PATH);
    if(chmod_probe!=-1 || errno!=EBADF)throw std::runtime_error("descriptor-only fchmodat2 AT_EMPTY_PATH unavailable");
    const struct timespec probe[2]={{0,0},{0,0}};
    errno=0;const int time_probe=utimensat(-1,"",probe,AT_EMPTY_PATH);
    if(time_probe!=-1 || errno!=EBADF)throw std::runtime_error("descriptor-only utimensat AT_EMPTY_PATH unavailable");
    const auto inherited=ReadAttribute(parent.fd,"system.posix_acl_default");
    if(!inherited.absent && inherited.error!=EOPNOTSUPP)throw std::runtime_error("parent default ACL present/unreadable; FIFO ACL restoration unavailable on O_PATH");
    CheckParent(parent);
    attempted=true;
    if(mknodat(parent.fd,parent.leaf.c_str(),S_IFIFO|0600,0)!=0)throw std::runtime_error(std::string("exclusive FIFO creation failed; existing entries are never replaced: ")+std::strerror(errno));
    fd=openat(parent.fd,parent.leaf.c_str(),O_PATH|O_NOFOLLOW|O_CLOEXEC);
    if(fd<0)throw std::runtime_error(std::string("created FIFO metadata-only open failed: ")+std::strerror(errno));owned.values.push_back(fd);
    const auto before=ReadNode(parent,fd);
    if(!S_ISFIFO(before.st_mode) || before.st_rdev!=0)throw std::runtime_error("created FIFO identity/type differs");
    const struct timespec times[2]={{0,UTIME_OMIT},modified};
    if(utimensat(fd,"",times,AT_EMPTY_PATH)!=0)throw std::runtime_error(std::string("created FIFO exact timestamp application failed: ")+std::strerror(errno));
    if(syscall(SYS_fchmodat2,fd,"",mode,AT_EMPTY_PATH)!=0)throw std::runtime_error(std::string("created FIFO exact mode application failed: ")+std::strerror(errno));
    const auto after=ReadNode(parent,fd);
    if(before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || before.st_uid!=after.st_uid || before.st_gid!=after.st_gid ||
        !S_ISFIFO(after.st_mode) || after.st_rdev!=0 || (after.st_mode&07777)!=mode ||
        after.st_mtim.tv_sec!=modified.tv_sec || after.st_mtim.tv_nsec!=modified.tv_nsec)throw std::runtime_error("created FIFO exact readback differs");
    return NodeEvidence(env,parent,after);
  }catch(const std::exception& e){
    if(!attempted)return Failure(env,"ERR_PERSISTENT_NODE_PREFLIGHT",e.what());
    napi_value observed=Null(env);try{if(fd>=0)observed=NodeEvidence(env,parent,ReadNode(parent,fd));}catch(const std::exception&){}
    return Partial(env,e.what(),observed);
  }
#else
  return portable_metadata::Failure(env,"ERR_PERSISTENT_NODE_UNSUPPORTED","FIFO creation requires Linux O_PATH, fchmodat2 and AT_EMPTY_PATH; no node created");
#endif
}
