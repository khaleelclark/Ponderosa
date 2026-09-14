// Descriptor/handle-relative cleanup. Pathnames are never used for deletion.
// The complete absolute ancestor chain is opened without following links.
// ponytail: 128 root entries / 10,000 nodes / 32 levels per pass. Exceeding
// these ceilings fails closed; Repair retries the remaining bounded work.
bool SpeechOwnedLeaf(const std::string& name) {
  const bool version = name.size() == 44 && name.compare(0, 8, "version-") == 0;
  const bool pointer = name.size() == 49 && name.compare(0, 8, "current-") == 0 &&
      name.compare(44, 5, ".json") == 0;
  if (!version && !pointer) return false;
  for (size_t i = 0; i < 36; ++i) {
    const char c = name[8 + i];
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

#ifndef _WIN32
struct SpeechDirectory {
  DIR* value;
  explicit SpeechDirectory(int fd) : value(fdopendir(fd)) { if (!value) close(fd); }
  ~SpeechDirectory() { if (value) closedir(value); }
};

bool RemoveSpeechNode(int parent, const std::string& name, dev_t device,
    const std::string& protected_identity, size_t* nodes, size_t depth) {
  if (++*nodes > 10000 || depth > 32) return false;
  struct stat before{};
  if (fstatat(parent, name.c_str(), &before, AT_SYMLINK_NOFOLLOW) != 0) return false;
  if (before.st_dev != device || IdentityToken(before) == protected_identity) return false;
  if (!S_ISDIR(before.st_mode)) {
    // unlinkat does not follow a replacement symlink, including the final leaf.
    return unlinkat(parent, name.c_str(), 0) == 0;
  }
  const int fd = openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  SpeechDirectory directory(fd);
  struct stat retained{};
  if (!directory.value || fstat(fd, &retained) != 0 || !SameIdentity(before, retained)) return false;
  while (true) {
    errno = 0;
    dirent* entry = readdir(directory.value);
    if (!entry) { if (errno) return false; break; }
    const std::string child(entry->d_name);
    if (child == "." || child == "..") continue;
    if (!SafeLeaf(child) || !RemoveSpeechNode(fd, child, device, protected_identity, nodes, depth + 1)) return false;
  }
  struct stat current{};
  if (fstatat(parent, name.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameIdentity(retained, current)) return false;
  // AT_REMOVEDIR never follows a symlink and cannot remove a nonempty replacement.
  return unlinkat(parent, name.c_str(), AT_REMOVEDIR) == 0;
}

bool CleanupSpeech(const std::string& root, const std::string& protected_leaf,
    const std::string& protected_identity) {
  if (root.empty() || root[0] != '/') return false;
  std::vector<std::string> components;
  if (!ParseRelativePath(root.substr(1), &components)) return false;
  DescriptorSet ancestors;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  ancestors.values.push_back(fd);
  for (const auto& component : components) {
    fd = openat(fd, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    ancestors.values.push_back(fd);
  }
  struct stat root_identity{};
  if (fstat(fd, &root_identity) != 0) return false;
  SpeechDirectory directory(dup(fd));
  if (!directory.value) return false;
  size_t entries = 0, nodes = 0;
  while (true) {
    errno = 0;
    dirent* entry = readdir(directory.value);
    if (!entry) return errno == 0;
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    if (++entries > 128) return false;
    if (!SpeechOwnedLeaf(name) || name == protected_leaf) continue;
    if (!RemoveSpeechNode(fd, name, root_identity.st_dev, protected_identity, &nodes, 0)) return false;
  }
}
#else
bool SpeechWindowsNames(HANDLE directory, std::vector<std::string>* names, size_t limit) {
  NtApi& api = NativeWindowsApi();
  if (!api.query_directory) return false;
  std::vector<uint8_t> buffer(64 * 1024);
  BOOLEAN restart = TRUE;
  while (true) {
    IO_STATUS_BLOCK block{};
    const NTSTATUS status = api.query_directory(directory, nullptr, nullptr, nullptr,
        &block, buffer.data(), static_cast<ULONG>(buffer.size()),
        static_cast<FILE_INFORMATION_CLASS>(37), FALSE, nullptr, restart);
    restart = FALSE;
    if (status == kStatusNoMoreFiles) return true;
    if (!NtSuccess(status)) return false;
    size_t offset = 0;
    while (offset < block.Information) {
      const auto* entry = reinterpret_cast<const FileIdBothDirectoryEntry*>(buffer.data() + offset);
      const std::string name = Utf8(entry->FileName, entry->FileNameLength / sizeof(WCHAR));
      if (name != "." && name != "..") {
        if (!SafeLeaf(name) || names->size() >= limit) return false;
        names->push_back(name);
      }
      if (!entry->NextEntryOffset) break;
      offset += entry->NextEntryOffset;
    }
  }
}

bool RemoveSpeechNode(HANDLE parent, const std::string& name, uint64_t volume,
    const std::string& protected_identity, size_t* nodes, size_t depth) {
  if (++*nodes > 10000 || depth > 32) return false;
  WindowsHandleSet retained;
  HANDLE target = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenWindowsRelative(parent, Wide(name),
      DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen, kFileSynchronousIoNonAlert, &target);
  if (!NtSuccess(status)) return false;
  retained.values.push_back(target);
  WindowsIdentity identity{};
  if (!GetWindowsIdentity(target, &identity) || identity.volume != volume ||
      IdentityToken(identity) == protected_identity) return false;
  if ((identity.attributes & FILE_ATTRIBUTE_DIRECTORY) &&
      !(identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    std::vector<std::string> names;
    if (!SpeechWindowsNames(target, &names, 10000 - *nodes)) return false;
    for (const auto& child : names)
      if (!RemoveSpeechNode(target, child, volume, protected_identity, nodes, depth + 1)) return false;
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  return SetFileInformationByHandle(target, FileDispositionInfo, &disposition, sizeof(disposition)) != 0;
}

bool CleanupSpeech(const std::string& root, const std::string& protected_leaf,
    const std::string& protected_identity) {
  // Walk from the drive root, not a pathname that can resolve ancestor junctions.
  if (root.size() < 4 || root[1] != ':' || (root[2] != '/' && root[2] != '\\')) return false;
  std::vector<std::string> components;
  if (!ParseRelativePath(root.substr(3), &components)) return false;
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
  if (!OpenSecureDirectoryComponents(root.substr(0, 3), components, false, &handles, &identities)) return false;
  std::vector<std::string> names;
  const bool complete = SpeechWindowsNames(handles.values.back(), &names, 128);
  if (!complete && names.size() != 128) return false;
  size_t nodes = 0;
  for (const auto& name : names) {
    if (!SpeechOwnedLeaf(name) || name == protected_leaf) continue;
    if (!RemoveSpeechNode(handles.values.back(), name, identities.back().volume,
        protected_identity, &nodes, 0)) return false;
  }
  return complete;
}
#endif

napi_value CleanupSpeechStorage(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root, protected_leaf, protected_identity;
  if (argc != 3 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &protected_leaf) || !ReadUtf8(env, args[2], &protected_identity) ||
      root.find('\0') != std::string::npos ||
      (!protected_leaf.empty() && !SafeLeaf(protected_leaf))) return Boolean(env, false);
  return Boolean(env, CleanupSpeech(root, protected_leaf, protected_identity));
}
