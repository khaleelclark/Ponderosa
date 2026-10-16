// Retained physical storage for platforms without traversable descriptor paths.
// The registry is process-local and shared by native file workers and SQLite.
struct PortableRoot {
  std::string path;
  std::string sqlPrefix;
  int descriptor = -1;
  bool exported = false;
  bool readOnly = false;
#ifdef _WIN32
  HANDLE lease = INVALID_HANDLE_VALUE;
#endif
  ~PortableRoot() {
#ifdef _WIN32
    if(lease!=INVALID_HANDLE_VALUE)CloseHandle(lease);
#endif
    if (descriptor < 0) return;
#ifdef _WIN32
    RuntimeCloseDescriptor(descriptor);
#else
    if (!exported && !readOnly) flock(descriptor, LOCK_UN);
    close(descriptor);
#endif
  }
};
struct PortableOwner { std::shared_ptr<PortableRoot> root; };
std::recursive_mutex storage_mutex;
std::map<std::string, std::weak_ptr<PortableRoot>> storage_roots;
struct StorageFile {std::shared_ptr<PortableRoot> root;std::string relative;};
std::map<int, StorageFile> storage_files;
#ifdef _WIN32
std::map<HANDLE, std::shared_ptr<PortableRoot>> storage_handles;
#endif
std::map<std::string, std::weak_ptr<PortableRoot>> storage_sql_roots;

std::string StorageName(std::string path) {
#ifdef _WIN32
  for (char& c : path) { if (c == '\\') c = '/'; if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; }
#endif
  while (path.size() > 1 && path.back() == '/') path.pop_back();
  return path;
}
std::shared_ptr<PortableRoot> StorageRoot(const std::string& input, std::string* relative, bool* matched) {
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  if (input.rfind("ponderosa-db-",0)==0) {
    *matched=true;
    const size_t separator=input.find('~');
    if(separator!=std::string::npos) {
      auto found=storage_sql_roots.find(input.substr(0,separator+1));
      if(found!=storage_sql_roots.end()) {
        *matched=true;auto root=found->second.lock();if(!root){errno=EBADF;return nullptr;}
        std::string encoded=input.substr(separator+1);size_t i=0;relative->clear();
        while(i+1<encoded.size() && std::isxdigit(static_cast<unsigned char>(encoded[i])) && std::isxdigit(static_cast<unsigned char>(encoded[i+1]))) {
          relative->push_back(static_cast<char>(std::stoi(encoded.substr(i,2),nullptr,16)));i+=2;
        }
        relative->append(encoded.substr(i));return root;
      }
    }
    errno=EBADF;return nullptr;
  }
  const std::string name = StorageName(input);
  size_t longest = 0; std::weak_ptr<PortableRoot> value;
  for (const auto& entry : storage_roots) {
    if ((name == entry.first || (name.size() > entry.first.size() &&
        name.compare(0, entry.first.size(), entry.first) == 0 && name[entry.first.size()] == '/')) &&
        entry.first.size() > longest) { longest = entry.first.size(); value = entry.second; }
  }
  *matched = longest != 0;
  if (!*matched) {
    if(name.find("/.__ponderosa_storage__/")!=std::string::npos){*matched=true;errno=EBADF;}
    return nullptr;
  }
  *relative = name.size() == longest ? "" : input.substr(longest + 1);
  auto root = value.lock();
  if (!root) { errno = EBADF; return nullptr; }
  return root;
}
#ifdef _WIN32
HANDLE RootHandle(const PortableRoot& root) { return reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(root.descriptor)); }
int DuplicateRootDescriptor(int source) {
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(source)),
      GetCurrentProcess(), &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) return -1;
  int fd = RuntimeOpenDescriptor(reinterpret_cast<intptr_t>(duplicate), _O_RDONLY | _O_BINARY);
  if (fd < 0) CloseHandle(duplicate);
  return fd;
}
#else
int DuplicateRootDescriptor(int source) { return fcntl(source, F_DUPFD_CLOEXEC, 3); }
#endif
void StorageError(napi_env env, const char* operation) {
#ifdef _WIN32
  DWORD windows_error = GetLastError();
  if (windows_error == ERROR_FILE_NOT_FOUND || windows_error == ERROR_PATH_NOT_FOUND) errno = ENOENT;
  else if (windows_error == ERROR_ALREADY_EXISTS || windows_error == ERROR_FILE_EXISTS) errno = EEXIST;
  else if (windows_error == ERROR_DIRECTORY) errno = ENOTDIR;
  else if (windows_error == ERROR_DIR_NOT_EMPTY) errno = ENOTEMPTY;
  else if (windows_error == ERROR_SHARING_VIOLATION || windows_error == ERROR_ACCESS_DENIED) errno = EACCES;
#endif
  const char* code = errno == ENOENT ? "ENOENT" : errno == EEXIST ? "EEXIST" :
      errno == ENOTDIR ? "ENOTDIR" : errno == ENOTEMPTY ? "ENOTEMPTY" :
      errno == ELOOP ? "ELOOP" : errno == EBADF ? "EBADF" :
      errno == EINVAL ? "EINVAL" : errno == EXDEV ? "EXDEV" : "EACCES";
  std::string detail=std::string(operation)+" refused by retained storage authority";
#ifdef _WIN32
  detail+=" (Windows error "+std::to_string(windows_error)+")";
#endif
  ThrowCode(env, code, detail);
}
// Every component is opened relative to a held parent. No traversal escapes the
// admitted root, even after replacement of the originally selected pathname.
int StorageOpen(const std::shared_ptr<PortableRoot>& root, const std::string& relative, int flags, int mode) {
  if (!root) { errno = EBADF; return -1; }
  if (root->readOnly && ((flags & 3) != 0 || (flags &
#ifdef _WIN32
      (_O_CREAT|_O_TRUNC|_O_APPEND)
#else
      (O_CREAT|O_TRUNC|O_APPEND)
#endif
      ))) { errno = EACCES; return -1; }
  if (relative.empty()) {
#ifndef _WIN32
    // dup() shares a directory cursor with the lease descriptor. Each reader
    // needs an independent open description while retaining the same root.
    return openat(root->descriptor,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
#else
    // NT relative names do not interpret "." like a Win32 path. Reopen the
    // exact held object to get an independent directory enumeration cursor.
    HANDLE handle=ReopenWindowsDirectoryExact(RootHandle(*root),FILE_GENERIC_READ);
    if(handle==INVALID_HANDLE_VALUE){std::fprintf(stderr,"retained root reopen failed (Windows %lu)\n",GetLastError());return -1;}
    WindowsIdentity original{},reopened{};
    if(!GetWindowsIdentity(RootHandle(*root),&original)||!GetWindowsIdentity(handle,&reopened)||!SameIdentity(original,reopened)) {
      std::fprintf(stderr,"retained root reopen identity verification failed (Windows %lu)\n",GetLastError());CloseHandle(handle);SetLastError(ERROR_ACCESS_DENIED);return -1;
    }
    int fd=RuntimeOpenDescriptor(reinterpret_cast<intptr_t>(handle),_O_RDONLY|_O_BINARY);if(fd<0)CloseHandle(handle);return fd;
#endif
  }
  std::vector<std::string> parts;
  if (!ParseRelativePath(relative, &parts)) { errno = EINVAL; return -1; }
#ifndef _WIN32
  DescriptorSet parents; int parent = root->descriptor;
  for (size_t i = 0; i + 1 < parts.size(); ++i) {
    int fd = openat(parent, parts[i].c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    parents.values.push_back(fd); parent = fd;
  }
  return openat(parent, parts.back().c_str(), flags | O_NOFOLLOW | O_CLOEXEC, mode);
#else
  WindowsHandleSet parents; HANDLE parent = RootHandle(*root);
  for (size_t i = 0; i < parts.size(); ++i) {
    bool last = i + 1 == parts.size();
    HANDLE handle = INVALID_HANDLE_VALUE;
    ACCESS_MASK access = last ? FILE_READ_ATTRIBUTES | SYNCHRONIZE : FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if (last) {
      if ((flags & 3) != _O_WRONLY) access |= FILE_READ_DATA;
      if ((flags & 3) != _O_RDONLY && !(flags & _O_APPEND)) access |= FILE_WRITE_DATA;
      if (flags & _O_APPEND) access |= FILE_APPEND_DATA;
    }
    ULONG disposition = last && (flags & _O_CREAT) ? ((flags & _O_EXCL) ? kFileCreate : kFileOpenIf) : kFileOpen;
    NTSTATUS status = OpenWindowsRelative(parent, Wide(parts[i]), access, disposition,
        kFileSynchronousIoNonAlert | (last ? 0 : kFileDirectoryFile), &handle);
    if (!NtSuccess(status)) { SetLastError(NativeWindowsApi().status_to_dos(status)); return -1; }
    WindowsIdentity identity{};
    if (!GetWindowsIdentity(handle, &identity) || (identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        (!last && !(identity.attributes & FILE_ATTRIBUTE_DIRECTORY))) { CloseHandle(handle); SetLastError(ERROR_ACCESS_DENIED); return -1; }
    if (last) {
      int fd = RuntimeOpenDescriptor(reinterpret_cast<intptr_t>(handle), flags & (_O_RDONLY | _O_RDWR | _O_WRONLY | _O_APPEND) | _O_BINARY);
      if (fd < 0) CloseHandle(handle);
      else if ((flags & _O_TRUNC) && RuntimeResizeDescriptor(fd, 0) != 0) { RuntimeCloseDescriptor(fd); return -1; }
      return fd;
    }
    parents.values.push_back(handle); parent = handle;
  }
  SetLastError(ERROR_INVALID_PARAMETER); return -1;
#endif
}
std::pair<std::shared_ptr<PortableRoot>, std::string> RequiredStorage(const std::string& name) {
  bool matched = false; std::string relative;
  auto root = StorageRoot(name, &relative, &matched);
  if (!matched || !root) { errno = EBADF; throw std::runtime_error("closed storage root"); }
  return {root, relative};
}
std::pair<int,std::string> StorageParent(const std::shared_ptr<PortableRoot>& root, const std::string& name) {
  std::vector<std::string> parts;
  if (!ParseRelativePath(name, &parts)) { errno = EINVAL; return {-1,""}; }
  const size_t split = name.find_last_of("/\\");
#ifdef _WIN32
  // Namespace mutation at the retained root needs the original granted add
  // rights. A new read-only root open makes Windows reopen it for write and
  // lose the mutation rights. Parent handles are not enumerators.
  if(split==std::string::npos) return {DuplicateRootDescriptor(root->descriptor),parts.back()};
#endif
  int fd = StorageOpen(root, split == std::string::npos ? "" : name.substr(0,split),
#ifndef _WIN32
      O_RDONLY | O_DIRECTORY,
#else
      _O_RDONLY,
#endif
      0);
  return {fd,parts.back()};
}
int CloseNativeDescriptor(int fd) {
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
#ifdef _WIN32
  int result=RuntimeCloseDescriptor(fd);
#else
  int result=close(fd);
#endif
  if(result==0)storage_files.erase(fd);
  return result;
}
#ifdef _WIN32
BOOL CloseNativeHandle(HANDLE handle) {
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  BOOL result=CloseHandle(handle);if(result)storage_handles.erase(handle);return result;
}
#endif
int PortableOpenRoot(const std::string& path, bool* matched) {
  std::string relative; auto root = StorageRoot(path, &relative, matched);
  if (!*matched) return -1;
  int fd=StorageOpen(root, relative,
#ifndef _WIN32
      O_RDONLY | O_DIRECTORY,
#else
      _O_RDONLY,
#endif
      0);
  if(fd>=0){std::lock_guard<std::recursive_mutex> lock(storage_mutex);storage_files[fd]={root,relative};}
  return fd;
}
#ifdef _WIN32
HANDLE PortableOpenWindowsRoot(const std::string& path, bool* matched) {
  int fd = PortableOpenRoot(path, matched);
  if (!*matched || fd < 0) return INVALID_HANDLE_VALUE;
  HANDLE result = INVALID_HANDLE_VALUE;
  DuplicateHandle(GetCurrentProcess(), reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd)),
      GetCurrentProcess(), &result, 0, FALSE, DUPLICATE_SAME_ACCESS);
  if(result!=INVALID_HANDLE_VALUE){std::lock_guard<std::recursive_mutex> lock(storage_mutex);storage_handles[result]=storage_files.at(fd).root;}
  CloseNativeDescriptor(fd); return result;
}
#endif
void FinalizePortableOwner(napi_env,void* data,void*) {
  delete static_cast<PortableOwner*>(data);
}
PortableOwner* PortableValue(napi_env env,napi_value value) {
  void* pointer = nullptr;
  if (napi_get_value_external(env,value,&pointer)!=napi_ok || !pointer ||
      !static_cast<PortableOwner*>(pointer)->root) { Throw(env,"portable directory authority is closed"); return nullptr; }
  return static_cast<PortableOwner*>(pointer);
}
napi_value PublishPortable(napi_env env, std::shared_ptr<PortableRoot> root) {
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  // Expired names still fail closed through their reserved namespaces. Do not
  // retain a tombstone for every periodic launcher read pin indefinitely.
  for(auto entry=storage_roots.begin();entry!=storage_roots.end();) {
    if(entry->second.expired())entry=storage_roots.erase(entry);else ++entry;
  }
  for(auto entry=storage_sql_roots.begin();entry!=storage_sql_roots.end();) {
    if(entry->second.expired())entry=storage_sql_roots.erase(entry);else ++entry;
  }
  storage_roots[StorageName(root->path)] = root;
  const std::string name=StorageName(root->path);root->sqlPrefix="ponderosa-db-"+name.substr(name.find_last_of('/')+1)+"~";
  storage_sql_roots[root->sqlPrefix]=root;
  auto* owner = new PortableOwner{root}; napi_value result;
  if (napi_create_external(env,owner,FinalizePortableOwner,nullptr,&result)!=napi_ok) { delete owner; Throw(env,"cannot issue portable root"); return nullptr; }
  return result;
}
napi_value AcquirePortableDirectory(napi_env env,napi_callback_info info) {
  size_t argc=3; napi_value args[3]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string name,key; if (argc<2 || !ReadUtf8(env,args[0],&name) || !ReadUtf8(env,args[1],&key)) { Throw(env,"invalid portable root"); return nullptr; }
  auto root=std::make_shared<PortableRoot>(); root->path=key;
  if(argc==3)napi_get_value_bool(env,args[2],&root->readOnly);
#ifndef _WIN32
  bool matched=false;std::string relative;auto parent=StorageRoot(name,&relative,&matched);
  root->descriptor=matched?StorageOpen(parent,relative,O_RDONLY|O_DIRECTORY,0):open(name.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (root->descriptor<0) { StorageError(env,"open root"); return nullptr; }
  if (!root->readOnly && flock(root->descriptor,LOCK_EX|LOCK_NB)!=0) { ThrowCode(env,"DATA_DIRECTORY_OWNED","data directory is already owned by another Ponderosa process"); return nullptr; }
#else
  // NtCreateFile requires explicit SYNCHRONIZE for synchronous handles; use
  // the mapped read rights rather than leaving a GENERIC_READ bit unmapped.
  const ACCESS_MASK access=FILE_GENERIC_READ|
      (root->readOnly?0:FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY);
  const DWORD share=root->readOnly?FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE:FILE_SHARE_READ|FILE_SHARE_WRITE;
  bool matched=false;std::string relative;auto parent=StorageRoot(name,&relative,&matched);
  HANDLE handle=INVALID_HANDLE_VALUE;
  if(matched && parent) {
    auto at=StorageParent(parent,relative);
    if(at.first>=0) {
      std::wstring leaf=Wide(at.second);UNICODE_STRING unicode{};unicode.Buffer=const_cast<WCHAR*>(leaf.data());unicode.Length=static_cast<USHORT>(leaf.size()*sizeof(WCHAR));unicode.MaximumLength=unicode.Length;
      OBJECT_ATTRIBUTES attributes{};InitializeObjectAttributes(&attributes,&unicode,OBJ_CASE_INSENSITIVE,reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(at.first)),nullptr);
      IO_STATUS_BLOCK ios{};NTSTATUS status=NativeWindowsApi().create_file(&handle,access,&attributes,&ios,nullptr,FILE_ATTRIBUTE_NORMAL,share,kFileOpen,kFileDirectoryFile|kFileOpenReparsePoint|kFileSynchronousIoNonAlert,nullptr,0);RuntimeCloseDescriptor(at.first);
      if(!NtSuccess(status)){SetLastError(NativeWindowsApi().status_to_dos(status));handle=INVALID_HANDLE_VALUE;}
    }
  } else if(!matched) handle=CreateFileW(Wide(name).c_str(),access,share,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  WindowsIdentity identity{};
  if (handle==INVALID_HANDLE_VALUE) { StorageError(env,"acquire data directory ownership"); return nullptr; }
  if (!GetWindowsIdentity(handle,&identity) || !(identity.attributes&FILE_ATTRIBUTE_DIRECTORY) || (identity.attributes&FILE_ATTRIBUTE_REPARSE_POINT)) { CloseHandle(handle); Throw(env,"unsafe portable root"); return nullptr; }
  if(!root->readOnly) {
    SetLastError(ERROR_SUCCESS);
    root->lease=CreateEventW(nullptr,TRUE,FALSE,WindowsDirectoryLeaseName(identity).c_str());
    const DWORD error=GetLastError();
    if(root->lease==nullptr || error==ERROR_ALREADY_EXISTS) {
      if(root->lease)CloseHandle(root->lease);root->lease=INVALID_HANDLE_VALUE;CloseHandle(handle);
      ThrowCode(env,"DATA_DIRECTORY_OWNED","data directory is already owned by another Ponderosa process");return nullptr;
    }
  }
  root->descriptor=RuntimeOpenDescriptor(reinterpret_cast<intptr_t>(handle),_O_RDONLY|_O_BINARY);
  if (root->descriptor<0) { CloseHandle(handle); Throw(env,"cannot retain directory handle"); return nullptr; }
#endif
  return PublishPortable(env,root);
}
napi_value AdoptPortableDirectory(napi_env env,napi_callback_info info) {
  size_t argc=3; napi_value args[3]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string name; int32_t fd=-1;
  if ((argc!=2 && argc!=3) || !ReadUtf8(env,args[0],&name) || napi_get_value_int32(env,args[1],&fd)!=napi_ok || fd<4) { Throw(env,"invalid directory inheritance"); return nullptr; }
#ifndef _WIN32
  struct stat stat{}; if (fstat(fd,&stat)!=0 || !S_ISDIR(stat.st_mode)) { Throw(env,"inherited descriptor is not a directory"); return nullptr; }
  const int independent=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (independent<0) { StorageError(env,"inspect inherited lease"); return nullptr; }
  const int acquired=flock(independent,LOCK_EX|LOCK_NB); const int error=errno; close(independent);
  if (acquired==0 || (error!=EWOULDBLOCK && error!=EAGAIN) || flock(fd,LOCK_EX|LOCK_NB)!=0) { Throw(env,"inherited directory lacks a continuous exclusive lease"); return nullptr; }
#else
  WindowsIdentity identity{};
  HANDLE received=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd));
  if (!GetWindowsIdentity(received,&identity) || !(identity.attributes&FILE_ATTRIBUTE_DIRECTORY) || (identity.attributes&FILE_ATTRIBUTE_REPARSE_POINT)) { Throw(env,"inherited handle is not an admitted directory"); return nullptr; }
  using QueryObject=NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PULONG);
  struct ObjectBasic {ULONG attributes;ACCESS_MASK granted;ULONG handles;ULONG pointers;ULONG reserved[10];};
  auto query=reinterpret_cast<QueryObject>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryObject"));ObjectBasic basic{};
  if(!query || !NtSuccess(query(received,0,&basic,sizeof(basic),nullptr)) ||
      (basic.granted&(FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY))!=(FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY)) {Throw(env,"inherited directory lacks writable lease rights");return nullptr;}
  HANDLE lease=argc==3?AdoptWindowsDirectoryLease(env,args[2],identity):INVALID_HANDLE_VALUE;
  if(lease==INVALID_HANDLE_VALUE){Throw(env,"inherited directory lacks its exact parent-held kernel lease");return nullptr;}
#endif
  auto root=std::make_shared<PortableRoot>(); root->path=name; root->exported=true;
#ifdef _WIN32
  root->lease=lease;
#endif
  root->descriptor=DuplicateRootDescriptor(fd);
  if (root->descriptor<0) { StorageError(env,"adopt directory"); return nullptr; }
#ifdef _WIN32
  RuntimeCloseDescriptor(fd);
#else
  close(fd);
#endif
  return PublishPortable(env,root);
}
napi_value ExportPortableDirectory(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto* owner=PortableValue(env,args[0]); if(!owner)return nullptr;
  owner->root->exported=true; napi_value result; napi_create_int32(env,owner->root->descriptor,&result); return result;
}
napi_value PortableDirectoryPath(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto* owner=PortableValue(env,args[0]); if(!owner)return nullptr;
  napi_value result; napi_create_string_utf8(env,owner->root->path.c_str(),NAPI_AUTO_LENGTH,&result); return result;
}
napi_value PortableDirectoryLeaseTransfer(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto* owner=PortableValue(env,args[0]);if(!owner)return nullptr;
#ifdef _WIN32
  if(owner->root->lease==INVALID_HANDLE_VALUE){Throw(env,"read references cannot export a directory lease");return nullptr;}
  napi_value result,pid,handle;napi_create_object(env,&result);napi_create_uint32(env,GetCurrentProcessId(),&pid);
  const std::string encoded=std::to_string(reinterpret_cast<uintptr_t>(owner->root->lease));napi_create_string_utf8(env,encoded.c_str(),NAPI_AUTO_LENGTH,&handle);
  napi_set_named_property(env,result,"sourcePid",pid);napi_set_named_property(env,result,"handle",handle);return result;
#else
  return Null(env);
#endif
}
napi_value ReleasePortableDirectory(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto* owner=PortableValue(env,args[0]); if(!owner)return nullptr;
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  storage_roots[StorageName(owner->root->path)].reset(); storage_sql_roots[owner->root->sqlPrefix].reset(); owner->root.reset();
  return Boolean(env,true);
}
napi_value StoragePathRegistered(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string name; if(!ReadUtf8(env,args[0],&name))return Boolean(env,false);
  bool matched=false; std::string relative; StorageRoot(name,&relative,&matched); return Boolean(env,matched);
}
napi_value CloseStorageFile(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value args[1]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr); int32_t fd=-1;
  napi_get_value_int32(env,args[0],&fd); std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  auto entry=storage_files.find(fd); if(entry==storage_files.end())return Boolean(env,false);
#ifdef _WIN32
  int result=RuntimeCloseDescriptor(fd);
#else
  int result=close(fd);
#endif
  if(result!=0) {StorageError(env,"close file");return nullptr;}
  storage_files.erase(entry);return Boolean(env,true);
}
napi_value SyncStorageFile(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);int32_t fd=-1;napi_get_value_int32(env,args[0],&fd);
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);auto found=storage_files.find(fd);if(found==storage_files.end())return Boolean(env,false);
#ifdef _WIN32
  using Flush=NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PIO_STATUS_BLOCK);auto flush=reinterpret_cast<Flush>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtFlushBuffersFileEx"));
  HANDLE handle=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd));WindowsIdentity identity{};
  if(!GetWindowsIdentity(handle,&identity)||!flush){Throw(env,"native flush is unavailable");return nullptr;}
  int directory_fd=-1;
  if(identity.attributes&FILE_ATTRIBUTE_DIRECTORY) {
    if(found->second.relative.empty())handle=RootHandle(*found->second.root);
    else {
      directory_fd=StorageOpen(found->second.root,found->second.relative,_O_RDWR,0);
      WindowsIdentity current{};
      if(directory_fd<0 || !GetWindowsIdentity(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(directory_fd)),&current) ||
          current.volume!=identity.volume || std::memcmp(current.file_id.Identifier,identity.file_id.Identifier,sizeof(identity.file_id.Identifier))!=0) {
        if(directory_fd>=0)RuntimeCloseDescriptor(directory_fd);Throw(env,"directory identity changed before flush");return nullptr;
      }
      handle=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(directory_fd));
    }
  }
  IO_STATUS_BLOCK ios{};NTSTATUS status=flush(handle,0,nullptr,0,&ios);if(directory_fd>=0)RuntimeCloseDescriptor(directory_fd);if(!NtSuccess(status)){SetLastError(NativeWindowsApi().status_to_dos(status));StorageError(env,"durable flush");return nullptr;}
#else
  if(fsync(fd)!=0){StorageError(env,"durable flush");return nullptr;}
#endif
  return Boolean(env,true);
}
napi_value StorageOperation(napi_env env,napi_callback_info info) {
  size_t argc=5; napi_value args[5]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string op,name,second; int32_t flags=0,mode=0600;
  if(argc<2 || !ReadUtf8(env,args[0],&op) || !ReadUtf8(env,args[1],&name)){Throw(env,"invalid storage operation");return nullptr;}
  if(argc>2)ReadUtf8(env,args[2],&second);if(argc>3)napi_get_value_int32(env,args[3],&flags);if(argc>4)napi_get_value_int32(env,args[4],&mode);
  try {
    auto held=RequiredStorage(name);auto root=held.first;std::string relative=held.second;
    if(op=="sqlite-name") {
      std::vector<std::string> parts;if(!ParseRelativePath(relative,&parts)){errno=EINVAL;StorageError(env,"SQLite name");return nullptr;}
      std::string out=root->sqlPrefix;const char* hex="0123456789abcdef";
      for(unsigned char c:relative){out+=hex[c>>4];out+=hex[c&15];}
      napi_value value;napi_create_string_utf8(env,out.c_str(),NAPI_AUTO_LENGTH,&value);return value;
    }
#ifndef _WIN32
    if(op=="stat" || op=="lstat") {
      struct stat metadata{}; int result;
      if(relative.empty()) result=fstat(root->descriptor,&metadata);
      else {
        auto parent=StorageParent(root,relative);
        if(parent.first<0){StorageError(env,"inspect retained file parent");return nullptr;}
        result=fstatat(parent.first,parent.second.c_str(),&metadata,AT_SYMLINK_NOFOLLOW);
        int error=errno;close(parent.first);errno=error;
      }
      if(result<0){StorageError(env,"inspect retained file");return nullptr;}
      if(op=="stat" && S_ISLNK(metadata.st_mode)){errno=ELOOP;StorageError(env,"follow retained link");return nullptr;}
      // Opening and closing a database inode just to stat it releases that
      // process's POSIX SQLite locks. Metadata must use the held parent instead.
      napi_value out;napi_create_object(env,&out);
      auto integer=[&](const char* key,int64_t value){napi_value field;napi_create_bigint_int64(env,value,&field);napi_set_named_property(env,out,key,field);};
      integer("dev",metadata.st_dev);integer("ino",metadata.st_ino);integer("mode",metadata.st_mode);
      integer("nlink",metadata.st_nlink);integer("uid",metadata.st_uid);integer("gid",metadata.st_gid);
      integer("rdev",metadata.st_rdev);integer("size",metadata.st_size);integer("blksize",metadata.st_blksize);integer("blocks",metadata.st_blocks);
#ifdef __APPLE__
      integer("atimeNs",int64_t(metadata.st_atimespec.tv_sec)*1000000000+metadata.st_atimespec.tv_nsec);
      integer("mtimeNs",int64_t(metadata.st_mtimespec.tv_sec)*1000000000+metadata.st_mtimespec.tv_nsec);
      integer("ctimeNs",int64_t(metadata.st_ctimespec.tv_sec)*1000000000+metadata.st_ctimespec.tv_nsec);
      integer("birthtimeNs",int64_t(metadata.st_birthtimespec.tv_sec)*1000000000+metadata.st_birthtimespec.tv_nsec);
#else
      integer("atimeNs",int64_t(metadata.st_atim.tv_sec)*1000000000+metadata.st_atim.tv_nsec);
      integer("mtimeNs",int64_t(metadata.st_mtim.tv_sec)*1000000000+metadata.st_mtim.tv_nsec);
      integer("ctimeNs",int64_t(metadata.st_ctim.tv_sec)*1000000000+metadata.st_ctim.tv_nsec);
      integer("birthtimeNs",0);
#endif
      return out;
    }
#endif
    if(op=="realpath") {
      int fd=StorageOpen(root,relative,
#ifndef _WIN32
        O_RDONLY,
#else
        _O_RDONLY,
#endif
        0);
      if(fd<0){StorageError(env,"resolve held path");return nullptr;}
      std::string name;
#ifdef __APPLE__
      char value[PATH_MAX];if(fcntl(fd,F_GETPATH,value)==0)name=value;close(fd);
#elif defined(_WIN32)
      std::vector<WCHAR> value(32768);DWORD count=GetFinalPathNameByHandleW(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd)),value.data(),static_cast<DWORD>(value.size()),FILE_NAME_NORMALIZED);if(count>0&&count<value.size())name=Utf8(value.data(),count);RuntimeCloseDescriptor(fd);
#else
      close(fd);
#endif
      #ifdef _WIN32
      // Return the same DOS/UNC spelling Node realpath uses for external tools.
      if(name.rfind("\\\\?\\UNC\\",0)==0)name="\\\\"+name.substr(8);
      else if(name.rfind("\\\\?\\",0)==0 && name.size()>6 && name[5]==':')name=name.substr(4);
#endif
      if(name.empty()){StorageError(env,"resolve held path");return nullptr;}napi_value result;napi_create_string_utf8(env,name.c_str(),NAPI_AUTO_LENGTH,&result);return result;
    }
    if(op=="open") {
      int fd=StorageOpen(root,relative,flags,mode);if(fd<0){StorageError(env,"open file");return nullptr;}
      std::lock_guard<std::recursive_mutex> lock(storage_mutex);storage_files[fd]={root,relative};
      napi_value result;napi_create_int32(env,fd,&result);return result;
    }
    if(op=="list") {
      int fd=StorageOpen(root,relative,
#ifndef _WIN32
        O_RDONLY|O_DIRECTORY,
#else
        _O_RDONLY,
#endif
        0);
      if(fd<0){StorageError(env,"enumerate directory");return nullptr;}
      napi_value result;napi_create_array(env,&result);uint32_t index=0;
#ifndef _WIN32
      DIR* directory=fdopendir(fd);if(!directory){close(fd);StorageError(env,"enumerate directory");return nullptr;}
      while(dirent* entry=readdir(directory)) {
        if(std::strcmp(entry->d_name,".")==0||std::strcmp(entry->d_name,"..")==0)continue;
        struct stat metadata{};if(fstatat(fd,entry->d_name,&metadata,AT_SYMLINK_NOFOLLOW)!=0){closedir(directory);StorageError(env,"inspect directory entry");return nullptr;}
        napi_value item,text,kind;napi_create_object(env,&item);napi_create_string_utf8(env,entry->d_name,NAPI_AUTO_LENGTH,&text);
        napi_create_string_utf8(env,S_ISDIR(metadata.st_mode)?"directory":S_ISREG(metadata.st_mode)?"file":S_ISLNK(metadata.st_mode)?"symlink":"other",NAPI_AUTO_LENGTH,&kind);
        napi_set_named_property(env,item,"name",text);napi_set_named_property(env,item,"kind",kind);napi_set_element(env,result,index++,item);
      }closedir(directory);
#else
      HANDLE handle=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd));BYTE buffer[32768];IO_STATUS_BLOCK ios{};BOOLEAN restart=TRUE;
      while(true){NTSTATUS status=NativeWindowsApi().query_directory(handle,nullptr,nullptr,nullptr,&ios,buffer,sizeof(buffer),static_cast<FILE_INFORMATION_CLASS>(37),FALSE,nullptr,restart);restart=FALSE;
        if(status==kStatusNoMoreFiles||status==kStatusNoSuchFile)break;if(!NtSuccess(status)){RuntimeCloseDescriptor(fd);Throw(env,"directory enumeration failed");return nullptr;}
        auto* entry=reinterpret_cast<FileIdBothDirectoryEntry*>(buffer);
        while(true){std::wstring wide(entry->FileName,entry->FileNameLength/sizeof(WCHAR));std::string leaf=Utf8(wide.data(),wide.size());
          if(leaf!="."&&leaf!=".."){napi_value item,text,kind;napi_create_object(env,&item);napi_create_string_utf8(env,leaf.c_str(),NAPI_AUTO_LENGTH,&text);napi_create_string_utf8(env,(entry->FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)?"symlink":(entry->FileAttributes&FILE_ATTRIBUTE_DIRECTORY)?"directory":"file",NAPI_AUTO_LENGTH,&kind);napi_set_named_property(env,item,"name",text);napi_set_named_property(env,item,"kind",kind);napi_set_element(env,result,index++,item);}
          if(!entry->NextEntryOffset)break;entry=reinterpret_cast<FileIdBothDirectoryEntry*>(reinterpret_cast<BYTE*>(entry)+entry->NextEntryOffset);
        }
      }RuntimeCloseDescriptor(fd);
#endif
      return result;
    }
    if(root->readOnly && op!="readlink") { errno=EACCES;StorageError(env,"read-only storage mutation");return nullptr; }
    if(op=="mkdir") {
      std::vector<std::string> parts;if(!ParseRelativePath(relative,&parts,true)){errno=EINVAL;StorageError(env,"create directory");return nullptr;}
      if(!flags && parts.empty()){ThrowCode(env,"EEXIST","retained storage directory already exists");return nullptr;}
      std::string current;
      for(size_t i=0;i<parts.size();++i){
        if(!current.empty())current+="/";current+=parts[i];
        // Non-recursive mkdir must open existing parents and create only the leaf.
        if(!flags && i+1<parts.size())continue;
        auto parent=StorageParent(root,current);if(parent.first<0){StorageError(env,"create directory parent");return nullptr;}
#ifndef _WIN32
        int result=mkdirat(parent.first,parent.second.c_str(),mode);int error=errno;close(parent.first);
        if(result!=0 && !(error==EEXIST && (flags || i+1<parts.size()))){errno=error;StorageError(env,"create directory");return nullptr;}
#else
        HANDLE handle=INVALID_HANDLE_VALUE;NTSTATUS result=OpenWindowsRelative(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(parent.first)),Wide(parent.second),FILE_LIST_DIRECTORY|FILE_TRAVERSE|FILE_READ_ATTRIBUTES|SYNCHRONIZE,flags?kFileOpenIf:kFileCreate,kFileDirectoryFile|kFileSynchronousIoNonAlert,&handle);RuntimeCloseDescriptor(parent.first);if(!NtSuccess(result)){SetLastError(NativeWindowsApi().status_to_dos(result));StorageError(env,"create directory");return nullptr;}CloseHandle(handle);
#endif
        int check=StorageOpen(root,current,
#ifndef _WIN32
            O_RDONLY|O_DIRECTORY,
#else
            _O_RDONLY,
#endif
            0);if(check<0){StorageError(env,"verify directory");return nullptr;}
#ifndef _WIN32
        close(check);
#else
        RuntimeCloseDescriptor(check);
#endif
      }return Boolean(env,true);
    }
    auto parent=StorageParent(root,relative);if(parent.first<0){StorageError(env,"open operation parent");return nullptr;}
#ifndef _WIN32
    int result=-1;
    if(op=="unlink"||op=="rmdir")result=unlinkat(parent.first,parent.second.c_str(),op=="rmdir"?AT_REMOVEDIR:0);
    else if(op=="readlink") {char buffer[4096];ssize_t size=readlinkat(parent.first,parent.second.c_str(),buffer,sizeof(buffer));int error=errno;close(parent.first);if(size<0){errno=error;StorageError(env,"read link");return nullptr;}napi_value value;napi_create_string_utf8(env,buffer,size,&value);return value;}
    else if(op=="rename"||op=="link") {
      auto destination=RequiredStorage(second);auto target=StorageParent(destination.first,destination.second);
      if(target.first>=0){result=op=="rename"?renameat(parent.first,parent.second.c_str(),target.first,target.second.c_str()):linkat(parent.first,parent.second.c_str(),target.first,target.second.c_str(),0);close(target.first);}
    }
    int error=errno;close(parent.first);if(result<0){errno=error;StorageError(env,"mutate retained file");return nullptr;}
#else
    HANDLE handle=INVALID_HANDLE_VALUE;NTSTATUS status=OpenWindowsRelative(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(parent.first)),Wide(parent.second),DELETE|FILE_READ_ATTRIBUTES|SYNCHRONIZE,kFileOpen,kFileSynchronousIoNonAlert,&handle);RuntimeCloseDescriptor(parent.first);
    if(!NtSuccess(status)){SetLastError(NativeWindowsApi().status_to_dos(status));StorageError(env,("open retained file for "+op).c_str());return nullptr;}
    BOOL success=FALSE;
    if(op=="unlink"||op=="rmdir"){FILE_DISPOSITION_INFO disposition{TRUE};success=SetFileInformationByHandle(handle,FileDispositionInfo,&disposition,sizeof(disposition));}
    else if(op=="rename"||op=="link"){
      auto destination=RequiredStorage(second);auto target=StorageParent(destination.first,destination.second);
      if(target.first>=0){std::wstring leaf=Wide(target.second);
        if(op=="rename") {
          // Native FileRenameInformation resolves the leaf against this held
          // directory; the Win32 wrapper rejects the relative-root request.
          std::vector<BYTE> buffer(sizeof(FILE_RENAME_INFO)+leaf.size()*sizeof(WCHAR));auto* rename=reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());rename->ReplaceIfExists=TRUE;rename->RootDirectory=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(target.first));rename->FileNameLength=static_cast<DWORD>(leaf.size()*sizeof(WCHAR));std::memcpy(rename->FileName,leaf.data(),rename->FileNameLength);IO_STATUS_BLOCK ios{};NTSTATUS result=NativeWindowsApi().set_information(handle,&ios,rename,static_cast<ULONG>(buffer.size()),static_cast<FILE_INFORMATION_CLASS>(10));success=NtSuccess(result);if(!success)SetLastError(NativeWindowsApi().status_to_dos(result));
        } else {
          struct LinkInfo {BOOLEAN replace;HANDLE root;ULONG length;WCHAR name[1];};std::vector<BYTE> buffer(sizeof(LinkInfo)+leaf.size()*sizeof(WCHAR));auto* link=reinterpret_cast<LinkInfo*>(buffer.data());link->replace=FALSE;link->root=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(target.first));link->length=static_cast<ULONG>(leaf.size()*sizeof(WCHAR));std::memcpy(link->name,leaf.data(),link->length);IO_STATUS_BLOCK ios{};NTSTATUS status=NativeWindowsApi().set_information(handle,&ios,link,static_cast<ULONG>(buffer.size()),static_cast<FILE_INFORMATION_CLASS>(11));success=NtSuccess(status);if(!success)SetLastError(NativeWindowsApi().status_to_dos(status));
        }
        RuntimeCloseDescriptor(target.first);
      }
    }
    CloseHandle(handle);if(!success){StorageError(env,("commit retained "+op).c_str());return nullptr;}
#endif
    return Boolean(env,true);
  }catch(const std::exception&){StorageError(env,"storage operation");return nullptr;}
}

struct StorageDirectory {
  std::shared_ptr<PortableRoot> root;
  int fd=-1;
#ifndef _WIN32
  DIR* directory=nullptr;
#else
  bool restarted=false;
#endif
  ~StorageDirectory(){ close(); }
  void close(){
#ifndef _WIN32
    if(directory){closedir(directory);directory=nullptr;fd=-1;}
    else if(fd>=0){::close(fd);fd=-1;}
#else
    if(fd>=0){RuntimeCloseDescriptor(fd);fd=-1;}
#endif
    root.reset();
  }
};
void FinalizeStorageDirectory(napi_env,void* data,void*){delete static_cast<StorageDirectory*>(data);}
napi_value OpenStorageDirectory(napi_env env,napi_callback_info info){
  size_t argc=1;napi_value args[1];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);std::string name;
  if(!ReadUtf8(env,args[0],&name)){Throw(env,"invalid directory path");return nullptr;}
  try{auto held=RequiredStorage(name);auto directory=std::make_unique<StorageDirectory>();directory->root=held.first;
    directory->fd=StorageOpen(held.first,held.second,
#ifndef _WIN32
      O_RDONLY|O_DIRECTORY,
#else
      _O_RDONLY,
#endif
      0);
    if(directory->fd<0){StorageError(env,"open directory iterator");return nullptr;}
#ifndef _WIN32
    directory->directory=fdopendir(directory->fd);if(!directory->directory){StorageError(env,"open directory iterator");return nullptr;}
#endif
    napi_value result;napi_create_external(env,directory.release(),FinalizeStorageDirectory,nullptr,&result);return result;
  }catch(const std::exception&){StorageError(env,"open directory iterator");return nullptr;}
}
napi_value ReadStorageDirectory(napi_env env,napi_callback_info info){
  size_t argc=2;napi_value args[2];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);void* value=nullptr;
  if(napi_get_value_external(env,args[0],&value)!=napi_ok||!value){Throw(env,"invalid directory iterator");return nullptr;}
  auto* directory=static_cast<StorageDirectory*>(value);bool closing=false;if(argc>1)napi_get_value_bool(env,args[1],&closing);
  if(closing){directory->close();return Boolean(env,true);}if(directory->fd<0){Throw(env,"directory iterator is closed");return nullptr;}
  while(true){std::string name,kind;
#ifndef _WIN32
    errno=0;dirent* entry=readdir(directory->directory);if(!entry){if(errno){StorageError(env,"read directory iterator");return nullptr;}return Null(env);}
    name=entry->d_name;if(name=="."||name=="..")continue;
    struct stat metadata{};if(fstatat(directory->fd,name.c_str(),&metadata,AT_SYMLINK_NOFOLLOW)!=0){StorageError(env,"read directory metadata");return nullptr;}
    kind=S_ISDIR(metadata.st_mode)?"directory":S_ISREG(metadata.st_mode)?"file":S_ISLNK(metadata.st_mode)?"symlink":"other";
#else
    BYTE buffer[32768];IO_STATUS_BLOCK ios{};NTSTATUS status=NativeWindowsApi().query_directory(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(directory->fd)),nullptr,nullptr,nullptr,&ios,buffer,sizeof(buffer),static_cast<FILE_INFORMATION_CLASS>(37),TRUE,nullptr,directory->restarted?FALSE:TRUE);directory->restarted=true;
    if(status==kStatusNoMoreFiles||status==kStatusNoSuchFile)return Null(env);if(!NtSuccess(status)){Throw(env,"directory iterator failed");return nullptr;}
    auto* entry=reinterpret_cast<FileIdBothDirectoryEntry*>(buffer);name=Utf8(entry->FileName,entry->FileNameLength/sizeof(WCHAR));if(name=="."||name=="..")continue;
    kind=(entry->FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)?"symlink":(entry->FileAttributes&FILE_ATTRIBUTE_DIRECTORY)?"directory":"file";
#endif
    napi_value result,text,type;napi_create_object(env,&result);napi_create_string_utf8(env,name.c_str(),NAPI_AUTO_LENGTH,&text);napi_create_string_utf8(env,kind.c_str(),NAPI_AUTO_LENGTH,&type);napi_set_named_property(env,result,"name",text);napi_set_named_property(env,result,"kind",type);return result;
  }
}

// Use the exact SQLite library's mature platform VFS. Only its pathname syscalls
// are redirected through retained roots; fd locking, WAL mapping and durability
// stay in SQLite's standard backend. Hook registration precedes disk admission.
#ifndef _WIN32
int (*sqlite_open)(const char*,int,int)=nullptr;
int (*sqlite_stat)(const char*,struct stat*)=nullptr;
int (*sqlite_lstat)(const char*,struct stat*)=nullptr;
int (*sqlite_access)(const char*,int)=nullptr;
int (*sqlite_unlink)(const char*)=nullptr;
ssize_t (*sqlite_readlink)(const char*,char*,size_t)=nullptr;
int (*sqlite_opendir)(const char*,int*)=nullptr;
int SqliteOpen(const char* path,int flags,int mode){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);return matched?StorageOpen(root,relative,flags,mode):sqlite_open(path,flags,mode);}
int SqliteStat(const char* path,struct stat* out){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);if(!matched)return sqlite_stat(path,out);if(!root){errno=EBADF;return -1;}if(relative.empty())return fstat(root->descriptor,out);auto parent=StorageParent(root,relative);if(parent.first<0)return -1;int result=fstatat(parent.first,parent.second.c_str(),out,AT_SYMLINK_NOFOLLOW);int error=errno;close(parent.first);if(result==0 && S_ISLNK(out->st_mode)){errno=ELOOP;return -1;}errno=error;return result;}
int SqliteLstat(const char* path,struct stat* out){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);if(!matched)return sqlite_lstat(path,out);if(!root){errno=EBADF;return -1;}if(relative.empty())return fstat(root->descriptor,out);auto parent=StorageParent(root,relative);if(parent.first<0)return -1;int result=fstatat(parent.first,parent.second.c_str(),out,AT_SYMLINK_NOFOLLOW);close(parent.first);return result;}
int SqliteAccess(const char* path,int flags){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);if(!matched)return sqlite_access(path,flags);if(!root){errno=EBADF;return -1;}auto parent=StorageParent(root,relative);if(parent.first<0)return -1;struct stat metadata{};int result=fstatat(parent.first,parent.second.c_str(),&metadata,AT_SYMLINK_NOFOLLOW);if(result==0 && !S_ISLNK(metadata.st_mode))result=faccessat(parent.first,parent.second.c_str(),flags,0);else if(result==0){errno=ELOOP;result=-1;}int error=errno;close(parent.first);errno=error;return result;}
int SqliteUnlink(const char* path){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);if(!matched)return sqlite_unlink(path);if(!root){errno=EBADF;return -1;}auto parent=StorageParent(root,relative);if(parent.first<0)return -1;int result=unlinkat(parent.first,parent.second.c_str(),0);close(parent.first);return result;}
ssize_t SqliteReadlink(const char* path,char* body,size_t size){bool matched=false;std::string relative;auto root=StorageRoot(path,&relative,&matched);if(!matched)return sqlite_readlink(path,body,size);if(!root){errno=EBADF;return -1;}auto parent=StorageParent(root,relative);if(parent.first<0)return -1;ssize_t result=readlinkat(parent.first,parent.second.c_str(),body,size);close(parent.first);return result;}
int SqliteOpenDirectory(const char* name,int* fd){bool matched=false;std::string relative;auto root=StorageRoot(name,&relative,&matched);if(!matched)return sqlite_opendir(name,fd);if(!root)return SQLITE_CANTOPEN;auto parent=StorageParent(root,relative);*fd=parent.first;return *fd<0?SQLITE_CANTOPEN:SQLITE_OK;}
#endif
#ifdef _WIN32
HANDLE(WINAPI* sqlite_create_w)(LPCWSTR,DWORD,DWORD,LPSECURITY_ATTRIBUTES,DWORD,DWORD,HANDLE)=nullptr;
HANDLE(WINAPI* sqlite_create_a)(LPCSTR,DWORD,DWORD,LPSECURITY_ATTRIBUTES,DWORD,DWORD,HANDLE)=nullptr;
BOOL(WINAPI* sqlite_delete_w)(LPCWSTR)=nullptr;
BOOL(WINAPI* sqlite_delete_a)(LPCSTR)=nullptr;
DWORD(WINAPI* sqlite_attributes_w)(LPCWSTR)=nullptr;
DWORD(WINAPI* sqlite_attributes_a)(LPCSTR)=nullptr;
BOOL(WINAPI* sqlite_attributes_ex)(LPCWSTR,GET_FILEEX_INFO_LEVELS,LPVOID)=nullptr;
HANDLE WINAPI SqliteCreateW(LPCWSTR input,DWORD access,DWORD share,LPSECURITY_ATTRIBUTES security,DWORD creation,DWORD flags,HANDLE templ){
  const std::string name=Utf8(input,wcslen(input));bool matched=false;std::string relative;auto root=StorageRoot(name,&relative,&matched);
  if(!matched)return sqlite_create_w(input,access,share,security,creation,flags,templ);
  if(!root || root->readOnly && (access&(GENERIC_WRITE|FILE_WRITE_DATA|FILE_APPEND_DATA|DELETE))){SetLastError(ERROR_ACCESS_DENIED);return INVALID_HANDLE_VALUE;}
  auto parent=StorageParent(root,relative);if(parent.first<0)return INVALID_HANDLE_VALUE;
  std::wstring leaf=Wide(parent.second);UNICODE_STRING unicode{};unicode.Buffer=const_cast<WCHAR*>(leaf.data());unicode.Length=static_cast<USHORT>(leaf.size()*sizeof(WCHAR));unicode.MaximumLength=unicode.Length;
  OBJECT_ATTRIBUTES attributes{};InitializeObjectAttributes(&attributes,&unicode,OBJ_CASE_INSENSITIVE,reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(parent.first)),nullptr);IO_STATUS_BLOCK ios{};
  ULONG disposition=creation==CREATE_NEW?kFileCreate:creation==OPEN_ALWAYS?kFileOpenIf:creation==CREATE_ALWAYS?5:creation==TRUNCATE_EXISTING?4:kFileOpen;
  HANDLE result=INVALID_HANDLE_VALUE;NTSTATUS status=NativeWindowsApi().create_file(&result,access|SYNCHRONIZE,&attributes,&ios,nullptr,flags&0xffff,share,disposition,kFileNonDirectoryFile|kFileOpenReparsePoint|kFileSynchronousIoNonAlert|((flags&FILE_FLAG_DELETE_ON_CLOSE)?0x1000:0),nullptr,0);
  RuntimeCloseDescriptor(parent.first);
  if(!NtSuccess(status)){SetLastError(NativeWindowsApi().status_to_dos(status));return INVALID_HANDLE_VALUE;}
  WindowsIdentity identity{};
  if(!GetWindowsIdentity(result,&identity)||(identity.attributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))){CloseHandle(result);SetLastError(ERROR_ACCESS_DENIED);return INVALID_HANDLE_VALUE;}
  return result;
}
HANDLE WINAPI SqliteCreateA(LPCSTR input,DWORD access,DWORD share,LPSECURITY_ATTRIBUTES security,DWORD creation,DWORD flags,HANDLE templ){bool matched=false;std::string relative;StorageRoot(input,&relative,&matched);return matched?SqliteCreateW(Wide(input).c_str(),access,share,security,creation,flags,templ):sqlite_create_a(input,access,share,security,creation,flags,templ);}
BOOL WINAPI SqliteDeleteW(LPCWSTR input){std::string name=Utf8(input,wcslen(input));bool matched=false;std::string relative;auto root=StorageRoot(name,&relative,&matched);if(!matched)return sqlite_delete_w(input);if(!root||root->readOnly){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}auto parent=StorageParent(root,relative);if(parent.first<0)return FALSE;
  HANDLE file=INVALID_HANDLE_VALUE;NTSTATUS status=OpenWindowsRelative(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(parent.first)),Wide(parent.second),DELETE|FILE_READ_ATTRIBUTES|SYNCHRONIZE,kFileOpen,kFileNonDirectoryFile|kFileSynchronousIoNonAlert,&file);RuntimeCloseDescriptor(parent.first);
  if(!NtSuccess(status)){SetLastError(NativeWindowsApi().status_to_dos(status));return FALSE;}FILE_DISPOSITION_INFO disposition{TRUE};BOOL result=SetFileInformationByHandle(file,FileDispositionInfo,&disposition,sizeof(disposition));CloseHandle(file);return result;
}
BOOL WINAPI SqliteDeleteA(LPCSTR input){bool matched=false;std::string relative;StorageRoot(input,&relative,&matched);return matched?SqliteDeleteW(Wide(input).c_str()):sqlite_delete_a(input);}
BOOL WINAPI SqliteAttributesEx(LPCWSTR input,GET_FILEEX_INFO_LEVELS level,LPVOID out){std::string name=Utf8(input,wcslen(input));bool matched=false;std::string relative;auto root=StorageRoot(name,&relative,&matched);if(!matched)return sqlite_attributes_ex(input,level,out);if(!root||level!=GetFileExInfoStandard){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}
  int fd=StorageOpen(root,relative,_O_RDONLY,0);if(fd<0)return FALSE;BY_HANDLE_FILE_INFORMATION info{};BOOL ok=GetFileInformationByHandle(reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd)),&info);RuntimeCloseDescriptor(fd);if(!ok)return FALSE;
  auto* result=static_cast<WIN32_FILE_ATTRIBUTE_DATA*>(out);result->dwFileAttributes=info.dwFileAttributes;result->ftCreationTime=info.ftCreationTime;result->ftLastAccessTime=info.ftLastAccessTime;result->ftLastWriteTime=info.ftLastWriteTime;result->nFileSizeHigh=info.nFileSizeHigh;result->nFileSizeLow=info.nFileSizeLow;return TRUE;
}
DWORD WINAPI SqliteAttributesW(LPCWSTR input){bool matched=false;std::string relative;StorageRoot(Utf8(input,wcslen(input)),&relative,&matched);if(!matched)return sqlite_attributes_w(input);WIN32_FILE_ATTRIBUTE_DATA out{};return SqliteAttributesEx(input,GetFileExInfoStandard,&out)?out.dwFileAttributes:INVALID_FILE_ATTRIBUTES;}
DWORD WINAPI SqliteAttributesA(LPCSTR input){bool matched=false;std::string relative;StorageRoot(input,&relative,&matched);return matched?SqliteAttributesW(Wide(input).c_str()):sqlite_attributes_a(input);}
#endif

sqlite3_vfs* original_sqlite_vfs=nullptr;
sqlite3_vfs portable_sqlite_vfs{};
int PortableSqliteFullPath(sqlite3_vfs*,const char* path,int length,char* out){bool matched=false;std::string relative;StorageRoot(path,&relative,&matched);if(!matched)return original_sqlite_vfs->xFullPathname(original_sqlite_vfs,path,length,out);if(static_cast<int>(std::strlen(path))>=length)return SQLITE_CANTOPEN;std::strcpy(out,path);return SQLITE_OK;}
int RegisterPortableSqlite(){
  std::lock_guard<std::recursive_mutex> lock(storage_mutex);
  if(original_sqlite_vfs)return SQLITE_OK_LOAD_PERMANENTLY;
  if(sqlite3_libversion_number()!=SQLITE_VERSION_NUMBER)return SQLITE_ERROR;
  auto* vfs=sqlite3_vfs_find(nullptr);if(!vfs||vfs->iVersion<3||!vfs->xSetSystemCall||!vfs->xGetSystemCall)return SQLITE_ERROR;
#ifndef _WIN32
#define STORAGE_SQLITE_HOOK(name,variable,hook) variable=reinterpret_cast<decltype(variable)>(vfs->xGetSystemCall(vfs,name));if(!variable||vfs->xSetSystemCall(vfs,name,reinterpret_cast<sqlite3_syscall_ptr>(hook))!=SQLITE_OK)return SQLITE_ERROR
  STORAGE_SQLITE_HOOK("open",sqlite_open,SqliteOpen);
  STORAGE_SQLITE_HOOK("stat",sqlite_stat,SqliteStat);
  STORAGE_SQLITE_HOOK("lstat",sqlite_lstat,SqliteLstat);
  STORAGE_SQLITE_HOOK("access",sqlite_access,SqliteAccess);
  STORAGE_SQLITE_HOOK("unlink",sqlite_unlink,SqliteUnlink);
  STORAGE_SQLITE_HOOK("readlink",sqlite_readlink,SqliteReadlink);
  STORAGE_SQLITE_HOOK("openDirectory",sqlite_opendir,SqliteOpenDirectory);
#undef STORAGE_SQLITE_HOOK
#else
#define WINDOWS_SQLITE_HOOK(name,variable,hook,required) variable=reinterpret_cast<decltype(variable)>(vfs->xGetSystemCall(vfs,name));if(variable){if(vfs->xSetSystemCall(vfs,name,reinterpret_cast<sqlite3_syscall_ptr>(hook))!=SQLITE_OK)return SQLITE_ERROR;}else if(required)return SQLITE_ERROR
  WINDOWS_SQLITE_HOOK("CreateFileW",sqlite_create_w,SqliteCreateW,true);
  WINDOWS_SQLITE_HOOK("CreateFileA",sqlite_create_a,SqliteCreateA,false);
  WINDOWS_SQLITE_HOOK("DeleteFileW",sqlite_delete_w,SqliteDeleteW,true);
  WINDOWS_SQLITE_HOOK("DeleteFileA",sqlite_delete_a,SqliteDeleteA,false);
  WINDOWS_SQLITE_HOOK("GetFileAttributesW",sqlite_attributes_w,SqliteAttributesW,true);
  WINDOWS_SQLITE_HOOK("GetFileAttributesA",sqlite_attributes_a,SqliteAttributesA,false);
  WINDOWS_SQLITE_HOOK("GetFileAttributesExW",sqlite_attributes_ex,SqliteAttributesEx,true);
#undef WINDOWS_SQLITE_HOOK
#endif
  original_sqlite_vfs=vfs;portable_sqlite_vfs=*vfs;portable_sqlite_vfs.zName="ponderosa-retained-root";
  portable_sqlite_vfs.pNext=nullptr;portable_sqlite_vfs.xFullPathname=PortableSqliteFullPath;
  return sqlite3_vfs_register(&portable_sqlite_vfs,1)==SQLITE_OK?SQLITE_OK_LOAD_PERMANENTLY:SQLITE_ERROR;
}
