// Handle-bound usable space. Capacity is an observation, never a reservation.
napi_value SpaceResult(napi_env env, uint64_t units, uint64_t bytesPerUnit) {
  if (!bytesPerUnit || units > std::numeric_limits<uint64_t>::max() / bytesPerUnit) {
    ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Retained volume capacity is invalid or exceeds the supported exact range");return nullptr;
  }
  napi_value result;
  if(napi_create_bigint_uint64(env,units*bytesPerUnit,&result)!=napi_ok){Throw(env,"Cannot return exact retained volume capacity");return nullptr;}
  return result;
}

#ifndef _WIN32
napi_value PosixDirectoryCapacity(napi_env env,int fd,uint64_t expectedDevice,uint64_t expectedInode) {
  struct stat before{},after{};
  if(fstat(fd,&before)!=0 || !S_ISDIR(before.st_mode) ||
     uint64_t(before.st_dev)!=expectedDevice || uint64_t(before.st_ino)!=expectedInode) {
    ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held directory capacity identity differs");return nullptr;
  }
#if defined(__linux__)
  struct statvfs space{};
  if(fstatvfs(fd,&space)!=0 || !space.f_frsize) {
    ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Held directory volume capacity is unavailable");return nullptr;
  }
  const uint64_t units=uint64_t(space.f_bavail),size=uint64_t(space.f_frsize);
#elif defined(__APPLE__)
  struct statfs space{};
  if(fstatfs(fd,&space)!=0 || !space.f_bsize) {
    ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Held directory volume capacity is unavailable");return nullptr;
  }
  const uint64_t units=uint64_t(space.f_bavail),size=uint64_t(space.f_bsize);
#else
  ThrowCode(env,"ERR_STORAGE_CAPACITY_UNSUPPORTED","Held directory volume capacity is unsupported");return nullptr;
#endif
#if defined(__linux__) || defined(__APPLE__)
  if(fstat(fd,&after)!=0 || !S_ISDIR(after.st_mode) ||
     after.st_dev!=before.st_dev || after.st_ino!=before.st_ino) {
    ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held directory changed during capacity observation");return nullptr;
  }
  return SpaceResult(env,units,size);
#endif
}
#endif

napi_value AvailableHeldDirectoryBytes(napi_env env,napi_callback_info info) {
#ifdef _WIN32
  ThrowCode(env,"ERR_STORAGE_CAPACITY_UNSUPPORTED","Use the registered portable directory authority on Windows");return nullptr;
#else
  try {
    size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
    if(argc!=1)throw std::runtime_error("Invalid held directory capacity identity");
    const int fd=int(portable_metadata::Integer(env,portable_metadata::Property(env,arg,"fd"),INT_MAX));
    const uint64_t dev=portable_metadata::Identity(env,portable_metadata::Property(env,arg,"expectedDevice"));
    const uint64_t ino=portable_metadata::Identity(env,portable_metadata::Property(env,arg,"expectedInode"));
    return PosixDirectoryCapacity(env,fd,dev,ino);
  }catch(const std::exception& e){ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY",e.what());return nullptr;}
#endif
}

napi_value AvailablePortableStorageBytes(napi_env env,napi_callback_info info) {
  try {
    size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
    std::string path,relative;bool matched=false;
    if(argc!=1 || !ReadUtf8(env,arg,&path) || path.empty() || path.size()>4096)throw std::runtime_error("Invalid retained data-root capacity authority");
    auto root=StorageRoot(path,&relative,&matched);
    if(!matched || !root || !relative.empty() || StorageName(path)!=StorageName(root->path) || root->descriptor<0)throw std::runtime_error("Retained data-root capacity authority is closed or not exact");
#ifdef _WIN32
    const HANDLE handle=RootHandle(*root);WindowsIdentity before{},after{};
    if(handle==INVALID_HANDLE_VALUE || !GetWindowsIdentity(handle,&before) ||
       !(before.attributes&FILE_ATTRIBUTE_DIRECTORY) || (before.attributes&FILE_ATTRIBUTE_REPARSE_POINT)) {
      ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held portable root identity is unavailable");return nullptr;
    }
    using Query=NTSTATUS(NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,ULONG);
    HMODULE library=GetModuleHandleW(L"ntdll.dll");
    auto query=library?reinterpret_cast<Query>(GetProcAddress(library,"NtQueryVolumeInformationFile")):nullptr;
    if(!query){ThrowCode(env,"ERR_STORAGE_CAPACITY_UNSUPPORTED","Handle-based volume capacity is unsupported");return nullptr;}
    struct FullSize { LARGE_INTEGER total,caller,actual; ULONG sectors,bytes; };
    struct PendingVolumeQuery { IO_STATUS_BLOCK io{}; FullSize volume{}; };
    // Synchronous retained roots normally complete inline. If an unusual
    // filesystem returns STATUS_PENDING, preserve the kernel output buffer and
    // root until completion is known; a timeout holds one bounded observation
    // and refuses later queries rather than freeing memory still owned by I/O.
    static std::mutex queryMutex;
    static bool uncertain=false;
    static std::shared_ptr<PortableRoot> retainedRoot;
    std::lock_guard<std::mutex> lock(queryMutex);
    if(uncertain){ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","A prior volume observation remains unconfirmed");return nullptr;}
    auto pending=std::make_unique<PendingVolumeQuery>();
    pending->io.Status=NTSTATUS(0x103);
    NTSTATUS status=query(handle,&pending->io,&pending->volume,sizeof(pending->volume),7);
    if(status==NTSTATUS(0x103)){
      const DWORD wait=WaitForSingleObject(handle,5000);
      if(wait!=WAIT_OBJECT_0 || *reinterpret_cast<volatile NTSTATUS*>(&pending->io.Status)==NTSTATUS(0x103)){
        uncertain=true;retainedRoot=root;(void)pending.release();
        ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Held volume capacity observation remains unconfirmed");return nullptr;
      }
      status=*reinterpret_cast<volatile NTSTATUS*>(&pending->io.Status);
    }
    const auto& volume=pending->volume;
    if(!NtSuccess(status) || pending->io.Information<sizeof(volume) ||
       volume.caller.QuadPart<0 || !volume.sectors || !volume.bytes) {
      ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Held volume capacity is unavailable");return nullptr;
    }
    if(!GetWindowsIdentity(handle,&after) || !SameIdentity(before,after) ||
       !(after.attributes&FILE_ATTRIBUTE_DIRECTORY) || (after.attributes&FILE_ATTRIBUTE_REPARSE_POINT)){
      ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held portable root changed during capacity observation");return nullptr;
    }
    const uint64_t sectors=volume.sectors,bytes=volume.bytes;
    if(sectors>std::numeric_limits<uint64_t>::max()/bytes){
      ThrowCode(env,"ERR_STORAGE_CAPACITY_UNAVAILABLE","Retained volume allocation unit is too large");return nullptr;
    }
    return SpaceResult(env,uint64_t(volume.caller.QuadPart),sectors*bytes);
#else
    struct stat held{};
    if(fstat(root->descriptor,&held)!=0 || !S_ISDIR(held.st_mode)){
      ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held portable root identity is unavailable");return nullptr;
    }
    return PosixDirectoryCapacity(env,root->descriptor,uint64_t(held.st_dev),uint64_t(held.st_ino));
#endif
  }catch(const std::exception& e){ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY",e.what());return nullptr;}
}

// Observe the allocation of an already retained regular file. The caller owns
// root membership and serialization; this does not reserve or freeze space.
napi_value AllocatedHeldFileBytes(napi_env env,napi_callback_info info) {
  try {
    size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
    if(argc!=1)throw std::runtime_error("Invalid retained file descriptor");
    const int fd=int(portable_metadata::Integer(env,arg,INT_MAX));
#ifdef _WIN32
    HANDLE handle=reinterpret_cast<HANDLE>(RuntimeDescriptorHandle(fd));
    WindowsIdentity before{},after{};FILE_STANDARD_INFO allocation{};
    if(handle==INVALID_HANDLE_VALUE || !GetWindowsIdentity(handle,&before) ||
       (before.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) || !before.links ||
       !GetFileInformationByHandleEx(handle,FileStandardInfo,&allocation,sizeof(allocation)) ||
       allocation.Directory || allocation.DeletePending || allocation.AllocationSize.QuadPart<0 ||
       !GetWindowsIdentity(handle,&after) || !SameIdentity(before,after) ||
       (after.attributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)) || !after.links) {
      ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held file allocation is unavailable or identity changed");return nullptr;
    }
    return SpaceResult(env,uint64_t(allocation.AllocationSize.QuadPart),1);
#elif defined(__linux__) || defined(__APPLE__)
    struct stat before{},after{};
    if(fstat(fd,&before)!=0 || !S_ISREG(before.st_mode) || !before.st_nlink ||
       before.st_blocks<0 || fstat(fd,&after)!=0 || !S_ISREG(after.st_mode) ||
       !after.st_nlink || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino) {
      ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY","Held file allocation is unavailable or identity changed");return nullptr;
    }
    // Linux and Darwin document st_blocks in 512-byte units.
    return SpaceResult(env,uint64_t(before.st_blocks),512);
#else
    ThrowCode(env,"ERR_STORAGE_CAPACITY_UNSUPPORTED","Held file allocation is unsupported");return nullptr;
#endif
  }catch(const std::exception& e){ThrowCode(env,"ERR_STORAGE_CAPACITY_IDENTITY",e.what());return nullptr;}
}
