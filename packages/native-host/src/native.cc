#include <node_api.h>
#include <fstream>
#include <sstream>
#include <cstdio>
#ifdef __linux__
#include <sys/sysmacros.h>
#endif

#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <map>
#include <stdexcept>
#include <sqlite3ext.h>
#if defined(SQLITE_CORE) || defined(SQLITE_OMIT_LOAD_EXTENSION)
#error Native storage must compile against better-sqlite3 extension headers, never system SQLite
#endif
SQLITE_EXTENSION_INIT1

#ifdef _WIN32
#include <uv.h>
#include <windows.h>
#include <winternl.h>
#include <io.h>
#include <fcntl.h>
#else
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#endif
#ifdef __linux__
#include <sys/syscall.h>
#include <sys/statvfs.h>
#include <sys/xattr.h>
#include <sys/ioctl.h>
#include <linux/fs.h>
#include <linux/stat.h>
#endif
#endif

namespace {
int PortableOpenRoot(const std::string&, bool*);
int CloseNativeDescriptor(int);
#ifdef _WIN32
HANDLE PortableOpenWindowsRoot(const std::string&, bool*);
BOOL CloseNativeHandle(HANDLE);
bool NtSuccess(NTSTATUS);
// Descriptors cross into Node fs and child stdio. Use Node's own runtime table,
// not the separately linked addon CRT's descriptor table.
int RuntimeOpenDescriptor(intptr_t handle, int) {
  return uv_open_osfhandle(reinterpret_cast<HANDLE>(handle));
}
intptr_t RuntimeDescriptorHandle(int descriptor) {
  return reinterpret_cast<intptr_t>(uv_get_osfhandle(descriptor));
}
int RuntimeCloseDescriptor(int descriptor) {
  uv_fs_t request{};
  const int result=uv_fs_close(nullptr,&request,descriptor,nullptr);
  uv_fs_req_cleanup(&request);return result;
}
int RuntimeResizeDescriptor(int descriptor, int64_t length) {
  uv_fs_t request{};
  const int result=uv_fs_ftruncate(nullptr,&request,descriptor,length,nullptr);
  uv_fs_req_cleanup(&request);return result;
}
#endif

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

void ThrowCode(
    napi_env env, const std::string& code, const std::string& message) {
  napi_value text;
  napi_create_string_utf8(env, message.c_str(), message.size(), &text);
  napi_value error;
  napi_create_error(env, nullptr, text, &error);
  napi_value code_value;
  napi_create_string_utf8(env, code.c_str(), code.size(), &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
}

bool ReadUtf8(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.data(), length);
  // Every caller supplies an OS path or filesystem identity. Do not let a
  // length-aware JavaScript string differ from the NUL-terminated OS input.
  return output->find('\0') == std::string::npos;
}

bool ParseRelativePath(
    const std::string& input, std::vector<std::string>* components,
    bool allow_empty = false) {
  if ((input.empty() && !allow_empty) || input.size() > 4096 ||
      input.find('\0') != std::string::npos ||
      (!input.empty() && (input[0] == '/' || input[0] == '\\'))) {
    return false;
  }
  if (input.empty()) return true;
  std::string current;
  for (const char value : input) {
#ifdef _WIN32
    if (value == ':') return false;
#endif
    if (value == '/' || value == '\\') {
      if (current.empty() || current == "." || current == "..") return false;
      components->push_back(current);
      current.clear();
    } else {
      current.push_back(value);
    }
  }
  if (current.empty() || current == "." || current == "..") return false;
  components->push_back(current);
  return true;
}

napi_value Null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
}

napi_value Boolean(napi_env env, bool input) {
  napi_value value;
  napi_get_boolean(env, input, &value);
  return value;
}

bool SafeLeaf(const std::string& input) {
  if (input.empty() || input.size() > 255 || input == "." || input == "..") return false;
  for (const unsigned char value : input) {
    if (value == '/' || value == '\\' || value == '\0') return false;
#ifdef _WIN32
    if (value == ':') return false;
#endif
  }
  return true;
}

#ifndef _WIN32

struct DescriptorSet {
  std::vector<int> values;
  ~DescriptorSet() {
    for (auto iterator = values.rbegin(); iterator != values.rend(); ++iterator) {
      CloseNativeDescriptor(*iterator);
    }
  }
};

bool SameIdentity(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
      (left.st_mode & S_IFMT) == (right.st_mode & S_IFMT);
}

bool IsDescriptorRootPath(const std::string& root) {
#ifdef __linux__
  const std::string prefix = "/proc/self/fd/";
#else
  const std::string prefix = "/dev/fd/";
#endif
  if (root.rfind(prefix, 0) != 0 || root.size() == prefix.size()) return false;
  return std::all_of(
      root.begin() + static_cast<std::ptrdiff_t>(prefix.size()), root.end(),
      [](unsigned char value) { return value >= '0' && value <= '9'; });
}

int OpenRootDirectory(const std::string& root) {
  bool matched = false; const int portable = PortableOpenRoot(root, &matched);
  if (matched) return portable;
  const int no_follow = IsDescriptorRootPath(root) ? 0 : O_NOFOLLOW;
  return open(root.c_str(), O_RDONLY | O_DIRECTORY | no_follow | O_CLOEXEC);
}

bool SameContentState(const struct stat& left, const struct stat& right) {
#ifdef __APPLE__
  return left.st_size == right.st_size &&
      left.st_mtimespec.tv_sec == right.st_mtimespec.tv_sec &&
      left.st_mtimespec.tv_nsec == right.st_mtimespec.tv_nsec &&
      left.st_ctimespec.tv_sec == right.st_ctimespec.tv_sec &&
      left.st_ctimespec.tv_nsec == right.st_ctimespec.tv_nsec;
#else
  return left.st_size == right.st_size &&
      left.st_mtim.tv_sec == right.st_mtim.tv_sec &&
      left.st_mtim.tv_nsec == right.st_mtim.tv_nsec &&
      left.st_ctim.tv_sec == right.st_ctim.tv_sec &&
      left.st_ctim.tv_nsec == right.st_ctim.tv_nsec;
#endif
}

std::string IdentityToken(const struct stat& identity) {
  return std::to_string(static_cast<unsigned long long>(identity.st_dev)) +
      ":" +
      std::to_string(static_cast<unsigned long long>(identity.st_ino));
}

napi_value ReadSecureFile(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 4) return Null(env);
  std::string root;
  std::string relative;
  uint32_t max_bytes = 0;
  bool require_non_empty = false;
  if (!ReadUtf8(env, args[0], &root) || !ReadUtf8(env, args[1], &relative) ||
      napi_get_value_uint32(env, args[2], &max_bytes) != napi_ok ||
      napi_get_value_bool(env, args[3], &require_non_empty) != napi_ok) {
    return Null(env);
  }
  std::vector<std::string> components;
  if (!ParseRelativePath(relative, &components)) return Null(env);

  DescriptorSet descriptors;
  std::vector<struct stat> identities;
  const int root_fd = OpenRootDirectory(root);
  if (root_fd < 0) return Null(env);
  descriptors.values.push_back(root_fd);
  struct stat root_identity{};
  if (fstat(root_fd, &root_identity) != 0 || !S_ISDIR(root_identity.st_mode)) return Null(env);
  identities.push_back(root_identity);

  int parent = root_fd;
  for (size_t index = 0; index < components.size(); ++index) {
    const bool final = index + 1 == components.size();
    const int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (final ? 0 : O_DIRECTORY);
    const int descriptor = openat(parent, components[index].c_str(), flags);
    if (descriptor < 0) return Null(env);
    descriptors.values.push_back(descriptor);
    struct stat identity{};
    if (fstat(descriptor, &identity) != 0 ||
        identity.st_dev != root_identity.st_dev ||
        (final ? !S_ISREG(identity.st_mode) : !S_ISDIR(identity.st_mode))) {
      return Null(env);
    }
    identities.push_back(identity);
    parent = descriptor;
  }

  const struct stat before = identities.back();
  if (before.st_nlink != 1 || before.st_size < 0 ||
      static_cast<uint64_t>(before.st_size) > max_bytes ||
      (require_non_empty && before.st_size == 0)) {
    return Null(env);
  }
  std::vector<uint8_t> body(static_cast<size_t>(before.st_size));
  size_t offset = 0;
  while (offset < body.size()) {
    const ssize_t count = pread(
        descriptors.values.back(), body.data() + offset, body.size() - offset,
        static_cast<off_t>(offset));
    if (count <= 0) return Null(env);
    offset += static_cast<size_t>(count);
  }

  struct stat after{};
  if (fstat(descriptors.values.back(), &after) != 0 ||
      !SameIdentity(before, after) || !SameContentState(before, after) ||
      after.st_nlink != 1) {
    return Null(env);
  }

  const int current_root = OpenRootDirectory(root);
  if (current_root < 0) return Null(env);
  struct stat current_root_identity{};
  const bool root_stable =
      fstat(current_root, &current_root_identity) == 0 &&
      SameIdentity(root_identity, current_root_identity);
  CloseNativeDescriptor(current_root);
  if (!root_stable) return Null(env);

  for (size_t index = 0; index < components.size(); ++index) {
    struct stat current{};
    if (fstatat(
            descriptors.values[index], components[index].c_str(), &current,
            AT_SYMLINK_NOFOLLOW) != 0 ||
        !SameIdentity(identities[index + 1], current) ||
        (index + 1 == components.size() &&
         !SameContentState(before, current))) {
      return Null(env);
    }
  }

  napi_value result;
  if (napi_create_buffer_copy(
          env, body.size(), body.empty() ? nullptr : body.data(),
          nullptr, &result) != napi_ok) {
    return Null(env);
  }
  return result;
}

std::string PosixError(const char* operation) {
  return std::string(operation) + " failed (" + std::to_string(errno) + "): " +
      std::strerror(errno);
}

struct DataDirectoryAuthority {
  int descriptor = -1;
  std::string rooted_path;
  bool close_only = false;
};

void CloseDataDirectoryAuthority(DataDirectoryAuthority* authority) {
  if (!authority || authority->descriptor < 0) return;
  if (!authority->close_only) flock(authority->descriptor, LOCK_UN);
  CloseNativeDescriptor(authority->descriptor);
  authority->descriptor = -1;
}

void FinalizeDataDirectoryAuthority(napi_env, void* data, void*) {
  auto* authority = static_cast<DataDirectoryAuthority*>(data);
  CloseDataDirectoryAuthority(authority);
  delete authority;
}

DataDirectoryAuthority* ReadDataDirectoryAuthority(
    napi_env env, napi_value value) {
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) {
    Throw(env, "invalid data-directory authority");
    return nullptr;
  }
  auto* authority = static_cast<DataDirectoryAuthority*>(data);
  if (authority->descriptor < 0) {
    Throw(env, "data-directory authority is closed");
    return nullptr;
  }
  return authority;
}

napi_value AcquireDataDirectoryAuthority(
    napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  if (argc != 1 || !ReadUtf8(env, args[0], &root)) {
    Throw(env, "data-directory authority requires one path");
    return nullptr;
  }
  const int descriptor = open(
      root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) {
    Throw(env, PosixError("open data directory"));
    return nullptr;
  }
  struct stat identity{};
  if (fstat(descriptor, &identity) != 0 || !S_ISDIR(identity.st_mode)) {
    const std::string detail = PosixError("inspect data directory");
    CloseNativeDescriptor(descriptor);
    Throw(env, detail);
    return nullptr;
  }
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    const int lock_error = errno;
    CloseNativeDescriptor(descriptor);
    if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
      ThrowCode(
          env, "DATA_DIRECTORY_OWNED",
          "data directory is already owned by another Ponderosa process");
    } else {
      errno = lock_error;
      Throw(env, PosixError("lock data directory"));
    }
    return nullptr;
  }

#ifdef __linux__
  const std::string rooted_path = "/proc/self/fd/" + std::to_string(descriptor);
#else
  const std::string rooted_path = "/dev/fd/" + std::to_string(descriptor);
#endif
  const int verification = OpenRootDirectory(rooted_path);
  struct stat verified{};
  const bool stable = verification >= 0 &&
      fstat(verification, &verified) == 0 && SameIdentity(identity, verified);
  if (verification >= 0) CloseNativeDescriptor(verification);
  if (!stable) {
    flock(descriptor, LOCK_UN);
    CloseNativeDescriptor(descriptor);
    Throw(env, "could not establish descriptor-rooted data-directory authority");
    return nullptr;
  }

  auto* authority = new DataDirectoryAuthority{descriptor, rooted_path};
  napi_value result;
  if (napi_create_external(
          env, authority, FinalizeDataDirectoryAuthority, nullptr, &result) != napi_ok) {
    CloseDataDirectoryAuthority(authority);
    delete authority;
    Throw(env, "could not publish data-directory authority");
    return nullptr;
  }
  return result;
}


#ifdef __linux__
// An inherited descriptor is accepted only while the kernel records the parent
// as the original exclusive flock owner. A pathname/fd/JSON assertion is not a
// lease, and acquisition on a different open description must fail.
bool ParentHoldsDirectoryLease(const struct stat& identity) {
  std::ifstream locks("/proc/locks");
  std::string line;
  while (std::getline(locks, line)) {
    std::istringstream fields(line);
    std::string id, type, advisory, mode, device;
    long owner = -1;
    if (!(fields >> id >> type >> advisory >> mode >> owner >> device) ||
        type != "FLOCK" || mode != "WRITE" || owner != getppid()) continue;
    unsigned int major_id, minor_id;
    unsigned long long inode;
    if (std::sscanf(device.c_str(), "%x:%x:%llu", &major_id, &minor_id, &inode) == 3 &&
        major_id == major(identity.st_dev) && minor_id == minor(identity.st_dev) &&
        inode == static_cast<unsigned long long>(identity.st_ino)) return true;
  }
  return false;
}

napi_value ExportDataDirectoryDescriptor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto* authority = argc == 1 ? ReadDataDirectoryAuthority(env, args[0]) : nullptr;
  if (!authority) return nullptr;
  // Once exported, no parent disposal/finalizer may LOCK_UN the shared open
  // description. Last descriptor closure still releases the kernel lease.
  authority->close_only = true;
  napi_value result;
  napi_create_int32(env, authority->descriptor, &result);
  return result;
}

napi_value AdoptDataDirectoryDescriptor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t inherited = -1;
  std::string root;
  if (argc != 2 || napi_get_value_int32(env, args[0], &inherited) != napi_ok ||
      inherited < 3 || !ReadUtf8(env, args[1], &root)) {
    Throw(env, "directory transfer requires an inherited descriptor and root");
    return nullptr;
  }
  struct stat identity{}, named{};
  const int verification = OpenRootDirectory(root);
  const bool bound = verification >= 0 && fstat(inherited, &identity) == 0 &&
      S_ISDIR(identity.st_mode) && fstat(verification, &named) == 0 &&
      SameIdentity(identity, named) && ParentHoldsDirectoryLease(identity);
  if (!bound) {
    if (verification >= 0) CloseNativeDescriptor(verification);
    Throw(env, "directory transfer lacks exact parent-held physical ownership");
    return nullptr;
  }
  // A separate description must conflict, while the inherited description
  // must already share the parent's flock. Do not unlock either description.
  const int independent = flock(verification, LOCK_EX | LOCK_NB);
  const int independent_error = errno;
  if (independent == 0) { CloseNativeDescriptor(verification); Throw(env, "parent lease disappeared"); return nullptr; }
  CloseNativeDescriptor(verification);
  if ((independent_error != EWOULDBLOCK && independent_error != EAGAIN) ||
      flock(inherited, LOCK_EX | LOCK_NB) != 0 || !ParentHoldsDirectoryLease(identity)) {
    Throw(env, "inherited descriptor does not share the exact parent lease");
    return nullptr;
  }
  const int owned = fcntl(inherited, F_DUPFD_CLOEXEC, 3);
  if (owned < 0) { Throw(env, PosixError("adopt directory descriptor")); return nullptr; }
  CloseNativeDescriptor(inherited);
  const std::string rooted = "/proc/self/fd/" + std::to_string(owned);
  auto* authority = new DataDirectoryAuthority{owned, rooted, true};
  napi_value result;
  if (napi_create_external(env, authority, FinalizeDataDirectoryAuthority, nullptr, &result) != napi_ok) {
    // Parent may still be alive, so failure closes only this duplicate.
    authority->close_only = true;
    CloseDataDirectoryAuthority(authority); delete authority;
    Throw(env, "could not publish adopted directory lease"); return nullptr;
  }
  return result;
}
#endif

napi_value DataDirectoryAuthorityPath(
    napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  DataDirectoryAuthority* authority =
      argc == 1 ? ReadDataDirectoryAuthority(env, args[0]) : nullptr;
  if (!authority) return nullptr;
  napi_value result;
  napi_create_string_utf8(
      env, authority->rooted_path.c_str(), authority->rooted_path.size(), &result);
  return result;
}

napi_value ReleaseDataDirectoryAuthority(
    napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void* data = nullptr;
  if (argc == 1 && napi_get_value_external(env, args[0], &data) == napi_ok && data) {
    CloseDataDirectoryAuthority(static_cast<DataDirectoryAuthority*>(data));
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

bool OpenSecureDirectory(
    const std::string& root, const std::string& relative, bool create,
    DescriptorSet* descriptors, std::vector<struct stat>* identities,
    std::vector<std::string>* components) {
  if (!ParseRelativePath(relative, components, true)) return false;
  const int root_fd = OpenRootDirectory(root);
  if (root_fd < 0) return false;
  descriptors->values.push_back(root_fd);
  struct stat root_identity{};
  if (fstat(root_fd, &root_identity) != 0 ||
      !S_ISDIR(root_identity.st_mode)) {
    return false;
  }
  identities->push_back(root_identity);
  int parent = root_fd;
  for (const std::string& component : *components) {
    if (create) {
      if (mkdirat(parent, component.c_str(), 0700) == 0) {
        if (fsync(parent) != 0) return false;
      } else if (errno != EEXIST) {
        return false;
      }
    }
    const int child = openat(
        parent, component.c_str(),
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0) return false;
    descriptors->values.push_back(child);
    struct stat identity{};
    if (fstat(child, &identity) != 0 || !S_ISDIR(identity.st_mode) ||
        identity.st_dev != root_identity.st_dev) {
      return false;
    }
    identities->push_back(identity);
    parent = child;
  }
  return true;
}

bool SecureDirectoryStillCurrent(
    const std::string& root, const std::vector<std::string>& components,
    const DescriptorSet& descriptors,
    const std::vector<struct stat>& identities) {
  const int current_root = OpenRootDirectory(root);
  if (current_root < 0) return false;
  struct stat root_identity{};
  const bool root_stable =
      fstat(current_root, &root_identity) == 0 &&
      SameIdentity(identities.front(), root_identity);
  CloseNativeDescriptor(current_root);
  if (!root_stable) return false;
  for (size_t index = 0; index < components.size(); ++index) {
    struct stat current{};
    if (fstatat(
            descriptors.values[index], components[index].c_str(), &current,
            AT_SYMLINK_NOFOLLOW) != 0 ||
        !SameIdentity(identities[index + 1], current)) {
      return false;
    }
  }
  return true;
}

napi_value ListSecureDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  if (argc != 2 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative)) {
    return Null(env);
  }
  DescriptorSet descriptors;
  std::vector<struct stat> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, false, &descriptors, &identities, &components)) {
    return Null(env);
  }
  const int duplicate = dup(descriptors.values.back());
  if (duplicate < 0) return Null(env);
  DIR* directory = fdopendir(duplicate);
  if (!directory) {
    CloseNativeDescriptor(duplicate);
    return Null(env);
  }
  napi_value result;
  napi_create_array(env, &result);
  uint32_t output_index = 0;
  errno = 0;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (!SafeLeaf(name)) continue;
    struct stat identity{};
    if (fstatat(
            descriptors.values.back(), name.c_str(), &identity,
            AT_SYMLINK_NOFOLLOW) != 0 ||
        identity.st_dev != identities.front().st_dev ||
        (!S_ISDIR(identity.st_mode) && !S_ISREG(identity.st_mode))) {
      continue;
    }
    napi_value item;
    napi_create_object(env, &item);
    napi_value name_value;
    napi_create_string_utf8(env, name.c_str(), name.size(), &name_value);
    napi_set_named_property(env, item, "name", name_value);
    napi_value kind_value;
    const char* kind = S_ISDIR(identity.st_mode) ? "directory" : "file";
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &kind_value);
    napi_set_named_property(env, item, "kind", kind_value);
    if (S_ISREG(identity.st_mode) && identity.st_size >= 0) {
      napi_value size_value;
      napi_create_int64(env, static_cast<int64_t>(identity.st_size), &size_value);
      napi_set_named_property(env, item, "size", size_value);
    }
    double modified_ms = 0;
#ifdef __APPLE__
    modified_ms = static_cast<double>(identity.st_mtimespec.tv_sec) * 1000.0 +
        static_cast<double>(identity.st_mtimespec.tv_nsec) / 1000000.0;
#else
    modified_ms = static_cast<double>(identity.st_mtim.tv_sec) * 1000.0 +
        static_cast<double>(identity.st_mtim.tv_nsec) / 1000000.0;
#endif
    napi_value modified_value;
    napi_create_double(env, modified_ms, &modified_value);
    napi_set_named_property(env, item, "modifiedMs", modified_value);
    const std::string identity_token = IdentityToken(identity);
    napi_value identity_value;
    napi_create_string_utf8(
        env, identity_token.c_str(), identity_token.size(), &identity_value);
    napi_set_named_property(env, item, "identity", identity_value);
    napi_set_element(env, result, output_index++, item);
  }
  const int iteration_error = errno;
  closedir(directory);
  if (iteration_error != 0 ||
      !SecureDirectoryStillCurrent(
          root, components, descriptors, identities)) {
    return Null(env);
  }
  return result;
}

napi_value WriteSecureFileAtomic(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  std::string leaf;
  std::string temporary;
  void* raw_body = nullptr;
  size_t body_size = 0;
  if (argc != 5 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative) ||
      !ReadUtf8(env, args[2], &leaf) ||
      !ReadUtf8(env, args[3], &temporary) ||
      !SafeLeaf(leaf) || !SafeLeaf(temporary) ||
      napi_get_buffer_info(env, args[4], &raw_body, &body_size) != napi_ok ||
      body_size == 0 || body_size > 80 * 1024 * 1024) {
    Throw(env, "invalid secure atomic file publication");
    return nullptr;
  }
  DescriptorSet descriptors;
  std::vector<struct stat> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, true, &descriptors, &identities, &components)) {
    Throw(env, "could not open secure publication directory");
    return nullptr;
  }
  const int directory = descriptors.values.back();
  const int output = openat(
      directory, temporary.c_str(),
      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (output < 0) {
    Throw(env, PosixError("openat temporary file"));
    return nullptr;
  }
  bool temporary_exists = true;
  const auto cleanup = [&]() {
    CloseNativeDescriptor(output);
    if (temporary_exists) {
      unlinkat(directory, temporary.c_str(), 0);
    }
  };
  const auto* body = static_cast<const uint8_t*>(raw_body);
  size_t offset = 0;
  while (offset < body_size) {
    const ssize_t written =
        write(output, body + offset, body_size - offset);
    if (written <= 0) {
      const std::string error = PosixError("write");
      cleanup();
      Throw(env, error);
      return nullptr;
    }
    offset += static_cast<size_t>(written);
  }
  struct stat identity{};
  if (fsync(output) != 0 || fstat(output, &identity) != 0 ||
      !S_ISREG(identity.st_mode) ||
      identity.st_dev != identities.front().st_dev ||
      identity.st_nlink != 1 ||
      static_cast<uint64_t>(identity.st_size) != body_size ||
      !SecureDirectoryStillCurrent(
          root, components, descriptors, identities)) {
    cleanup();
    Throw(env, "secure temporary file failed durability or identity validation");
    return nullptr;
  }
  if (linkat(
          directory, temporary.c_str(), directory, leaf.c_str(), 0) != 0) {
    const int publication_errno = errno;
    const std::string error = PosixError("linkat publication");
    cleanup();
    if (publication_errno == EEXIST) {
      const int existing = openat(
          directory, leaf.c_str(),
          O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      struct stat existing_identity{};
      struct stat current_existing_identity{};
      const bool durable_existing =
          existing >= 0 &&
          fstat(existing, &existing_identity) == 0 &&
          S_ISREG(existing_identity.st_mode) &&
          existing_identity.st_dev == identities.front().st_dev &&
          existing_identity.st_nlink == 1 &&
          fsync(existing) == 0 &&
          fsync(directory) == 0 &&
          fstatat(
              directory, leaf.c_str(), &current_existing_identity,
              AT_SYMLINK_NOFOLLOW) == 0 &&
          SameIdentity(existing_identity, current_existing_identity) &&
          SecureDirectoryStillCurrent(
              root, components, descriptors, identities);
      if (existing >= 0) CloseNativeDescriptor(existing);
      if (durable_existing) {
        ThrowCode(env, "EEXIST", error);
      } else {
        Throw(env, "existing secure publication failed durability validation");
      }
    } else {
      Throw(env, error);
    }
    return nullptr;
  }
  if (unlinkat(directory, temporary.c_str(), 0) != 0) {
    const std::string error = PosixError("unlinkat temporary publication");
    cleanup();
    Throw(env, error);
    return nullptr;
  }
  temporary_exists = false;
  const int installed = openat(
      directory, leaf.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat installed_identity{};
  struct stat current_installed_identity{};
  if (installed < 0 ||
      fstat(installed, &installed_identity) != 0 ||
      !SameIdentity(identity, installed_identity) ||
      installed_identity.st_nlink != 1 ||
      fsync(installed) != 0 ||
      fsync(directory) != 0 ||
      fstatat(
          directory, leaf.c_str(), &current_installed_identity,
          AT_SYMLINK_NOFOLLOW) != 0 ||
      !SameIdentity(installed_identity, current_installed_identity) ||
      !SecureDirectoryStillCurrent(
          root, components, descriptors, identities)) {
    if (installed >= 0) CloseNativeDescriptor(installed);
    CloseNativeDescriptor(output);
    Throw(env, "secure publication directory failed durability validation");
    return nullptr;
  }
  CloseNativeDescriptor(installed);
  CloseNativeDescriptor(output);
  return Boolean(env, true);
}

napi_value RemoveSecureFile(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  std::string leaf;
  std::string quarantine;
  std::string expected_identity;
  if (argc != 5 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative) ||
      !ReadUtf8(env, args[2], &leaf) ||
      !ReadUtf8(env, args[3], &quarantine) ||
      !ReadUtf8(env, args[4], &expected_identity) ||
      !SafeLeaf(leaf) || !SafeLeaf(quarantine)) {
    Throw(env, "invalid secure file removal");
    return nullptr;
  }
  DescriptorSet descriptors;
  std::vector<struct stat> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, false, &descriptors, &identities, &components)) {
    return Boolean(env, false);
  }
  struct stat identity{};
  if (fstatat(
          descriptors.values.back(), leaf.c_str(), &identity,
          AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return Boolean(env, false);
    Throw(env, PosixError("fstatat removal target"));
    return nullptr;
  }
  if (!S_ISREG(identity.st_mode) ||
      identity.st_dev != identities.front().st_dev ||
      identity.st_nlink != 1 ||
      (!expected_identity.empty() &&
       IdentityToken(identity) != expected_identity) ||
      !SecureDirectoryStillCurrent(
          root, components, descriptors, identities)) {
    Throw(env, "secure removal target failed identity validation");
    return nullptr;
  }
  const int directory = descriptors.values.back();
#ifdef __APPLE__
  const int rename_result = renameatx_np(
      directory, leaf.c_str(), directory, quarantine.c_str(), RENAME_EXCL);
#else
  const int rename_result = static_cast<int>(syscall(
      SYS_renameat2, directory, leaf.c_str(), directory, quarantine.c_str(),
      RENAME_NOREPLACE));
#endif
  if (rename_result != 0) {
    if (errno == ENOENT) return Boolean(env, false);
    Throw(env, PosixError("secure removal quarantine rename"));
    return nullptr;
  }
  const int quarantined = openat(
      directory, quarantine.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat quarantined_identity{};
  const bool quarantine_stable =
      quarantined >= 0 &&
      fstat(quarantined, &quarantined_identity) == 0 &&
      SameIdentity(identity, quarantined_identity) &&
      quarantined_identity.st_nlink == 1 &&
      SecureDirectoryStillCurrent(
          root, components, descriptors, identities);
  if (quarantined >= 0) CloseNativeDescriptor(quarantined);
  if (!quarantine_stable) {
    Throw(env, "secure removal quarantine failed identity validation");
    return nullptr;
  }
  if (unlinkat(directory, quarantine.c_str(), 0) != 0 ||
      fsync(directory) != 0) {
    Throw(env, PosixError("secure quarantined file removal"));
    return nullptr;
  }
  return Boolean(env, true);
}

#endif

#ifdef _WIN32

struct JobAuthority {
  HANDLE handle;
};

std::string WindowsError(const char* operation) {
  const DWORD code = GetLastError();
  LPSTR buffer = nullptr;
  const DWORD length = FormatMessageA(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPSTR>(&buffer), 0, nullptr);
  std::string detail = length && buffer ? std::string(buffer, length) : "unknown error";
  if (buffer) LocalFree(buffer);
  return std::string(operation) + " failed (" + std::to_string(code) + "): " + detail;
}

std::wstring Wide(const std::string& input) {
  if (input.empty()) return {};
  const int length = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
      static_cast<int>(input.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring output(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
          static_cast<int>(input.size()), output.data(), length) != length) {
    return {};
  }
  return output;
}

std::string Utf8(const WCHAR* input, size_t length) {
  if (length == 0) return {};
  const int bytes = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, input, static_cast<int>(length),
      nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string output(static_cast<size_t>(bytes), '\0');
  if (WideCharToMultiByte(
          CP_UTF8, WC_ERR_INVALID_CHARS, input, static_cast<int>(length),
          output.data(), bytes, nullptr, nullptr) != bytes) {
    return {};
  }
  return output;
}

struct WindowsHandleSet {
  std::vector<HANDLE> values;
  ~WindowsHandleSet() {
    for (auto iterator = values.rbegin(); iterator != values.rend(); ++iterator) {
      if (*iterator && *iterator != INVALID_HANDLE_VALUE) CloseNativeHandle(*iterator);
    }
  }
};

struct WindowsIdentity {
  ULONGLONG volume = 0;
  FILE_ID_128 file_id{};
  DWORD attributes = 0;
  DWORD reparse_tag = 0;
  DWORD links = 0;
  uint64_t size = 0;
  int64_t last_write = 0;
  int64_t change = 0;
};

bool GetWindowsIdentity(HANDLE handle, WindowsIdentity* output) {
  FILE_ID_INFO id{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_BASIC_INFO basic{};
  BY_HANDLE_FILE_INFORMATION legacy{};
  if (!GetFileInformationByHandleEx(
          handle, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetFileInformationByHandleEx(
          handle, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandle(handle, &legacy)) {
    return false;
  }
  output->volume = id.VolumeSerialNumber;
  output->file_id = id.FileId;
  output->attributes = tag.FileAttributes;
  output->reparse_tag = tag.ReparseTag;
  output->links = legacy.nNumberOfLinks;
  output->size =
      (static_cast<uint64_t>(legacy.nFileSizeHigh) << 32) |
      legacy.nFileSizeLow;
  output->last_write = basic.LastWriteTime.QuadPart;
  output->change = basic.ChangeTime.QuadPart;
  return true;
}

bool SameContentState(
    const WindowsIdentity& left, const WindowsIdentity& right) {
  return left.size == right.size &&
      left.last_write == right.last_write &&
      left.change == right.change;
}

std::string IdentityToken(const WindowsIdentity& identity) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string output = std::to_string(identity.volume) + ":";
  output.reserve(output.size() + sizeof(identity.file_id.Identifier) * 2);
  for (const unsigned char value : identity.file_id.Identifier) {
    output.push_back(kHex[value >> 4]);
    output.push_back(kHex[value & 0x0f]);
  }
  return output;
}

bool SameIdentity(
    const WindowsIdentity& left, const WindowsIdentity& right) {
  return left.volume == right.volume &&
      std::memcmp(&left.file_id, &right.file_id, sizeof(FILE_ID_128)) == 0 &&
      ((left.attributes ^ right.attributes) & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring WindowsDirectoryLeaseName(const WindowsIdentity& identity) {
  std::ostringstream prefix;prefix<<"Global\\PonderosaDirectory_"<<std::hex<<identity.volume<<"_";
  const std::string ascii=prefix.str();std::wstring name(ascii.begin(),ascii.end());
  const wchar_t* hex=L"0123456789abcdef";
  for(unsigned char byte:identity.file_id.Identifier){name.push_back(hex[byte>>4]);name.push_back(hex[byte&15]);}
  return name;
}
HANDLE AdoptWindowsDirectoryLease(napi_env env,napi_value input,const WindowsIdentity& identity) {
  napi_value pidValue,handleValue;uint32_t pid=0;std::string encoded;
  if(napi_get_named_property(env,input,"sourcePid",&pidValue)!=napi_ok ||
      napi_get_value_uint32(env,pidValue,&pid)!=napi_ok || pid<=1 ||
      napi_get_named_property(env,input,"handle",&handleValue)!=napi_ok || !ReadUtf8(env,handleValue,&encoded) ||
      encoded.empty() || encoded.size()>20 || encoded.find_first_not_of("0123456789")!=std::string::npos)return INVALID_HANDLE_VALUE;
  uintptr_t handle;
  try{handle=static_cast<uintptr_t>(std::stoull(encoded));}catch(...){return INVALID_HANDLE_VALUE;}
  using QueryProcess=NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PULONG);
  struct BasicProcess {LONG exit;PVOID peb;ULONG_PTR affinity;LONG priority;ULONG_PTR pid;ULONG_PTR parent;};
  auto queryProcess=reinterpret_cast<QueryProcess>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryInformationProcess"));
  BasicProcess basic{};
  if(!queryProcess || !NtSuccess(queryProcess(GetCurrentProcess(),0,&basic,sizeof(basic),nullptr)) || basic.parent!=pid)return INVALID_HANDLE_VALUE;
  HANDLE source=OpenProcess(PROCESS_DUP_HANDLE,FALSE,pid);if(!source)return INVALID_HANDLE_VALUE;
  HANDLE lease=INVALID_HANDLE_VALUE;
  const BOOL duplicated=DuplicateHandle(source,reinterpret_cast<HANDLE>(handle),GetCurrentProcess(),&lease,0,FALSE,DUPLICATE_SAME_ACCESS);
  CloseHandle(source);if(!duplicated)return INVALID_HANDLE_VALUE;
  using QueryObject=NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PULONG);
  auto query=reinterpret_cast<QueryObject>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryObject"));
  auto objectText=[&](ULONG information)->std::wstring{
    std::vector<BYTE> buffer(65536);ULONG used=0;
    if(!query || !NtSuccess(query(lease,information,buffer.data(),static_cast<ULONG>(buffer.size()),&used)))return {};
    const auto* text=reinterpret_cast<const UNICODE_STRING*>(buffer.data());
    const uintptr_t begin=reinterpret_cast<uintptr_t>(buffer.data()),address=reinterpret_cast<uintptr_t>(text->Buffer);
    if(!text->Buffer || text->Length%sizeof(WCHAR) || address<begin || address>begin+buffer.size() ||
        text->Length>begin+buffer.size()-address)return {};
    return std::wstring(text->Buffer,text->Length/sizeof(WCHAR));
  };
  const std::wstring type=objectText(2),name=objectText(1);
  const std::wstring expected=L"\\"+WindowsDirectoryLeaseName(identity).substr(7);
  if(type!=L"Event" || name.size()<expected.size() || name.compare(name.size()-expected.size(),expected.size(),expected)!=0){CloseHandle(lease);return INVALID_HANDLE_VALUE;}
  return lease;
}

using NtCreateFilePointer = NTSTATUS(NTAPI*)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtQueryDirectoryFilePointer = NTSTATUS(NTAPI*)(
    HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG,
    FILE_INFORMATION_CLASS, BOOLEAN, PUNICODE_STRING, BOOLEAN);
using NtSetInformationFilePointer = NTSTATUS(NTAPI*)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
using RtlNtStatusToDosErrorPointer = ULONG(WINAPI*)(NTSTATUS);

struct NtApi {
  NtCreateFilePointer create_file = nullptr;
  NtQueryDirectoryFilePointer query_directory = nullptr;
  NtSetInformationFilePointer set_information = nullptr;
  RtlNtStatusToDosErrorPointer status_to_dos = nullptr;

  NtApi() {
    HMODULE module = GetModuleHandleW(L"ntdll.dll");
    if (!module) return;
    create_file = reinterpret_cast<NtCreateFilePointer>(
        GetProcAddress(module, "NtCreateFile"));
    query_directory = reinterpret_cast<NtQueryDirectoryFilePointer>(
        GetProcAddress(module, "NtQueryDirectoryFile"));
    set_information = reinterpret_cast<NtSetInformationFilePointer>(
        GetProcAddress(module, "NtSetInformationFile"));
    status_to_dos = reinterpret_cast<RtlNtStatusToDosErrorPointer>(
        GetProcAddress(module, "RtlNtStatusToDosError"));
  }
};

NtApi& NativeWindowsApi() {
  static NtApi api;
  return api;
}

bool NtSuccess(NTSTATUS status) {
  return status >= 0;
}

std::string NtError(const char* operation, NTSTATUS status) {
  NtApi& api = NativeWindowsApi();
  const DWORD error = api.status_to_dos
      ? static_cast<DWORD>(api.status_to_dos(status))
      : ERROR_GEN_FAILURE;
  SetLastError(error);
  return WindowsError(operation);
}

constexpr ULONG kFileOpen = 1;
constexpr ULONG kFileCreate = 2;
constexpr ULONG kFileOpenIf = 3;
constexpr ULONG kFileDirectoryFile = 0x00000001;
constexpr ULONG kFileSynchronousIoNonAlert = 0x00000020;
constexpr ULONG kFileNonDirectoryFile = 0x00000040;
constexpr ULONG kFileOpenReparsePoint = 0x00200000;
constexpr FILE_INFORMATION_CLASS kFileRenameInformation =
    static_cast<FILE_INFORMATION_CLASS>(10);
constexpr NTSTATUS kStatusNoMoreFiles =
    static_cast<NTSTATUS>(0x80000006L);
// An initial query of an empty, already-open directory can return this rather
// than STATUS_NO_MORE_FILES. It does not mean the retained root is missing.
constexpr NTSTATUS kStatusNoSuchFile =
    static_cast<NTSTATUS>(0xC000000FL);
constexpr NTSTATUS kStatusObjectNameNotFound =
    static_cast<NTSTATUS>(0xC0000034L);
constexpr NTSTATUS kStatusObjectPathNotFound =
    static_cast<NTSTATUS>(0xC000003AL);

HANDLE OpenWindowsRoot(const std::string& root, bool create = false) {
  bool matched = false; HANDLE portable = PortableOpenWindowsRoot(root, &matched);
  if (matched) return portable;
  const std::wstring wide = Wide(root);
  if (wide.empty()) return INVALID_HANDLE_VALUE;
  return CreateFileW(
      wide.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
          SYNCHRONIZE |
          (create ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0),
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
}

NTSTATUS OpenWindowsRelative(
    HANDLE parent, const std::wstring& name, ACCESS_MASK access,
    ULONG disposition, ULONG options, HANDLE* output) {
  NtApi& api = NativeWindowsApi();
  if (!api.create_file || name.empty() ||
      name.size() > (USHRT_MAX / sizeof(WCHAR))) {
    return static_cast<NTSTATUS>(0xC000000DL);
  }
  UNICODE_STRING unicode{};
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(WCHAR));
  unicode.MaximumLength = unicode.Length;
  unicode.Buffer = const_cast<PWCH>(name.data());
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(
      &attributes, &unicode, OBJ_CASE_INSENSITIVE, parent, nullptr);
  IO_STATUS_BLOCK status_block{};
  return api.create_file(
      output, access, &attributes, &status_block, nullptr,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      disposition, options | kFileOpenReparsePoint, nullptr, 0);
}

// An empty relative name reopens the held directory itself, with a distinct
// file object/cursor. No volume-ID lookup, pathname lookup or shared dup cursor.
HANDLE ReopenWindowsDirectoryExact(HANDLE original, DWORD access) {
  WindowsIdentity identity{};
  if (!GetWindowsIdentity(original, &identity) ||
      !(identity.attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  NtApi& api = NativeWindowsApi();
  if (!api.create_file) { SetLastError(ERROR_NOT_SUPPORTED); return INVALID_HANDLE_VALUE; }
  UNICODE_STRING name{};
  name.Buffer = const_cast<PWCH>(L"");
  OBJECT_ATTRIBUTES attributes{};
  InitializeObjectAttributes(&attributes, &name, OBJ_CASE_INSENSITIVE, original, nullptr);
  IO_STATUS_BLOCK ios{};
  HANDLE reopened = INVALID_HANDLE_VALUE;
  const NTSTATUS status = api.create_file(&reopened, access | SYNCHRONIZE,
      &attributes, &ios, nullptr, FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, kFileOpen,
      kFileDirectoryFile | kFileSynchronousIoNonAlert | kFileOpenReparsePoint, nullptr, 0);
  if (!NtSuccess(status)) { NtError("retained directory reopen", status); return INVALID_HANDLE_VALUE; }
  WindowsIdentity current{};
  if (!GetWindowsIdentity(reopened, &current) || !SameIdentity(identity, current) ||
      (current.attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    CloseHandle(reopened); SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  return reopened;
}

bool OpenSecureDirectoryComponents(
    const std::string& root, const std::vector<std::string>& components,
    bool create, WindowsHandleSet* handles,
    std::vector<WindowsIdentity>* identities) {
  HANDLE root_handle = OpenWindowsRoot(root, create);
  if (root_handle == INVALID_HANDLE_VALUE) return false;
  handles->values.push_back(root_handle);
  WindowsIdentity root_identity{};
  if (!GetWindowsIdentity(root_handle, &root_identity) ||
      !(root_identity.attributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (root_identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    return false;
  }
  identities->push_back(root_identity);
  HANDLE parent = root_handle;
  for (const std::string& component : components) {
    const std::wstring wide = Wide(component);
    HANDLE child = INVALID_HANDLE_VALUE;
    const ACCESS_MASK directory_access =
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
        SYNCHRONIZE |
        (create ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0);
    const NTSTATUS status = OpenWindowsRelative(
        parent, wide,
        directory_access,
        create ? kFileOpenIf : kFileOpen,
        kFileDirectoryFile | kFileSynchronousIoNonAlert, &child);
    if (!NtSuccess(status)) return false;
    handles->values.push_back(child);
    WindowsIdentity identity{};
    if (!GetWindowsIdentity(child, &identity) ||
        !(identity.attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        identity.volume != root_identity.volume) {
      return false;
    }
    identities->push_back(identity);
    parent = child;
  }
  return true;
}

bool OpenSecureDirectory(
    const std::string& root, const std::string& relative, bool create,
    WindowsHandleSet* handles, std::vector<WindowsIdentity>* identities,
    std::vector<std::string>* components) {
  if (!ParseRelativePath(relative, components, true)) return false;
  return OpenSecureDirectoryComponents(
      root, *components, create, handles, identities);
}

bool SecureDirectoryStillCurrent(
    const std::string& root, const std::vector<std::string>& components,
    const WindowsHandleSet& handles,
    const std::vector<WindowsIdentity>& identities) {
  HANDLE current_root = OpenWindowsRoot(root);
  if (current_root == INVALID_HANDLE_VALUE) return false;
  WindowsIdentity current_root_identity{};
  const bool root_stable =
      GetWindowsIdentity(current_root, &current_root_identity) &&
      SameIdentity(identities.front(), current_root_identity);
  CloseNativeHandle(current_root);
  if (!root_stable) return false;
  for (size_t index = 0; index < components.size(); ++index) {
    HANDLE current = INVALID_HANDLE_VALUE;
    const NTSTATUS status = OpenWindowsRelative(
        handles.values[index], Wide(components[index]),
        FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
            SYNCHRONIZE,
        kFileOpen, kFileDirectoryFile | kFileSynchronousIoNonAlert,
        &current);
    if (!NtSuccess(status)) return false;
    WindowsIdentity current_identity{};
    const bool stable =
        GetWindowsIdentity(current, &current_identity) &&
        SameIdentity(identities[index + 1], current_identity);
    CloseNativeHandle(current);
    if (!stable) return false;
  }
  return true;
}

napi_value ReadSecureFile(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  uint32_t max_bytes = 0;
  bool require_non_empty = false;
  if (argc != 4 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative) ||
      napi_get_value_uint32(env, args[2], &max_bytes) != napi_ok ||
      napi_get_value_bool(env, args[3], &require_non_empty) != napi_ok) {
    return Null(env);
  }
  std::vector<std::string> components;
  if (!ParseRelativePath(relative, &components)) return Null(env);
  const std::string leaf = components.back();
  components.pop_back();
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
  if (!OpenSecureDirectoryComponents(
          root, components, false, &handles, &identities)) {
    return Null(env);
  }
  HANDLE file = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenWindowsRelative(
      handles.values.back(), Wide(leaf),
      GENERIC_READ | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
      &file);
  if (!NtSuccess(status)) return Null(env);
  handles.values.push_back(file);
  WindowsIdentity before{};
  if (!GetWindowsIdentity(file, &before) ||
      (before.attributes & (FILE_ATTRIBUTE_DIRECTORY |
                            FILE_ATTRIBUTE_REPARSE_POINT)) ||
      before.volume != identities.front().volume ||
      before.links != 1 || before.size > max_bytes ||
      (require_non_empty && before.size == 0)) {
    return Null(env);
  }
  std::vector<uint8_t> body(static_cast<size_t>(before.size));
  size_t offset = 0;
  while (offset < body.size()) {
    const DWORD requested = static_cast<DWORD>(
        (std::min)(body.size() - offset, static_cast<size_t>(UINT32_MAX)));
    DWORD read = 0;
    if (!ReadFile(file, body.data() + offset, requested, &read, nullptr) ||
        read == 0) {
      return Null(env);
    }
    offset += read;
  }
  WindowsIdentity after{};
  if (!GetWindowsIdentity(file, &after) ||
      !SameIdentity(before, after) || !SameContentState(before, after) ||
      after.links != 1 ||
      !SecureDirectoryStillCurrent(
          root, components, handles, identities)) {
    return Null(env);
  }
  HANDLE current = INVALID_HANDLE_VALUE;
  const NTSTATUS current_status = OpenWindowsRelative(
      handles.values[handles.values.size() - 2], Wide(leaf),
      FILE_READ_ATTRIBUTES | SYNCHRONIZE, kFileOpen,
      kFileNonDirectoryFile | kFileSynchronousIoNonAlert, &current);
  if (!NtSuccess(current_status)) return Null(env);
  WindowsIdentity current_identity{};
  const bool leaf_stable =
      GetWindowsIdentity(current, &current_identity) &&
      SameIdentity(before, current_identity) &&
      SameContentState(before, current_identity);
  CloseNativeHandle(current);
  if (!leaf_stable) return Null(env);
  napi_value result;
  if (napi_create_buffer_copy(
          env, body.size(), body.empty() ? nullptr : body.data(),
          nullptr, &result) != napi_ok) {
    return Null(env);
  }
  return result;
}

struct FileIdBothDirectoryEntry {
  ULONG NextEntryOffset;
  ULONG FileIndex;
  LARGE_INTEGER CreationTime;
  LARGE_INTEGER LastAccessTime;
  LARGE_INTEGER LastWriteTime;
  LARGE_INTEGER ChangeTime;
  LARGE_INTEGER EndOfFile;
  LARGE_INTEGER AllocationSize;
  ULONG FileAttributes;
  ULONG FileNameLength;
  ULONG EaSize;
  CCHAR ShortNameLength;
  WCHAR ShortName[12];
  LARGE_INTEGER FileId;
  WCHAR FileName[1];
};

napi_value ListSecureDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  if (argc != 2 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative)) {
    return Null(env);
  }
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, false, &handles, &identities, &components)) {
    return Null(env);
  }
  NtApi& api = NativeWindowsApi();
  if (!api.query_directory) return Null(env);
  napi_value result;
  napi_create_array(env, &result);
  uint32_t output_index = 0;
  std::vector<uint8_t> buffer(64 * 1024);
  BOOLEAN restart = TRUE;
  while (true) {
    IO_STATUS_BLOCK status_block{};
    const NTSTATUS status = api.query_directory(
        handles.values.back(), nullptr, nullptr, nullptr, &status_block,
        buffer.data(), static_cast<ULONG>(buffer.size()),
        static_cast<FILE_INFORMATION_CLASS>(37), FALSE, nullptr, restart);
    restart = FALSE;
    if (status == kStatusNoMoreFiles || status == kStatusNoSuchFile) break;
    if (!NtSuccess(status)) return Null(env);
    size_t offset = 0;
    while (offset < status_block.Information) {
      const auto* entry =
          reinterpret_cast<const FileIdBothDirectoryEntry*>(
              buffer.data() + offset);
      const std::string name = Utf8(
          entry->FileName, entry->FileNameLength / sizeof(WCHAR));
      if (SafeLeaf(name) &&
          !(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        HANDLE retained = INVALID_HANDLE_VALUE;
        const NTSTATUS retained_status = OpenWindowsRelative(
            handles.values.back(), Wide(name),
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            kFileOpen,
            kFileSynchronousIoNonAlert,
            &retained);
        WindowsIdentity retained_identity{};
        if (!NtSuccess(retained_status) ||
            !GetWindowsIdentity(retained, &retained_identity) ||
            (retained_identity.attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            retained_identity.volume != identities.front().volume) {
          if (retained != INVALID_HANDLE_VALUE) CloseNativeHandle(retained);
          if (entry->NextEntryOffset == 0) break;
          offset += entry->NextEntryOffset;
          continue;
        }
        const bool directory =
            retained_identity.attributes & FILE_ATTRIBUTE_DIRECTORY;
        napi_value item;
        napi_create_object(env, &item);
        napi_value name_value;
        napi_create_string_utf8(
            env, name.c_str(), name.size(), &name_value);
        napi_set_named_property(env, item, "name", name_value);
        napi_value kind_value;
        napi_create_string_utf8(
            env, directory ? "directory" : "file",
            NAPI_AUTO_LENGTH, &kind_value);
        napi_set_named_property(env, item, "kind", kind_value);
        if (!directory && retained_identity.size <=
            static_cast<uint64_t>(INT64_MAX)) {
          napi_value size_value;
          napi_create_int64(
              env, static_cast<int64_t>(retained_identity.size),
              &size_value);
          napi_set_named_property(env, item, "size", size_value);
        }
        constexpr double kWindowsToUnixEpoch100ns = 116444736000000000.0;
        const double modified_ms =
            (static_cast<double>(retained_identity.last_write) -
             kWindowsToUnixEpoch100ns) / 10000.0;
        napi_value modified_value;
        napi_create_double(env, modified_ms, &modified_value);
        napi_set_named_property(env, item, "modifiedMs", modified_value);
        const std::string identity_token =
            IdentityToken(retained_identity);
        napi_value identity_value;
        napi_create_string_utf8(
            env, identity_token.c_str(), identity_token.size(),
            &identity_value);
        napi_set_named_property(env, item, "identity", identity_value);
        napi_set_element(env, result, output_index++, item);
        CloseNativeHandle(retained);
      }
      if (entry->NextEntryOffset == 0) break;
      offset += entry->NextEntryOffset;
    }
  }
  if (!SecureDirectoryStillCurrent(
          root, components, handles, identities)) {
    return Null(env);
  }
  return result;
}

void DeleteWindowsFileHandle(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  SetFileInformationByHandle(
      handle, FileDispositionInfo, &disposition, sizeof(disposition));
}

napi_value WriteSecureFileAtomic(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  std::string leaf;
  std::string temporary;
  void* raw_body = nullptr;
  size_t body_size = 0;
  if (argc != 5 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative) ||
      !ReadUtf8(env, args[2], &leaf) ||
      !ReadUtf8(env, args[3], &temporary) ||
      !SafeLeaf(leaf) || !SafeLeaf(temporary) ||
      napi_get_buffer_info(env, args[4], &raw_body, &body_size) != napi_ok ||
      body_size == 0 || body_size > 80 * 1024 * 1024) {
    Throw(env, "invalid secure atomic file publication");
    return nullptr;
  }
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, true, &handles, &identities, &components)) {
    Throw(env, "could not open secure publication directory");
    return nullptr;
  }
  HANDLE output = INVALID_HANDLE_VALUE;
  const NTSTATUS open_status = OpenWindowsRelative(
      handles.values.back(), Wide(temporary),
      GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileCreate, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
      &output);
  if (!NtSuccess(open_status)) {
    Throw(env, NtError("NtCreateFile temporary publication", open_status));
    return nullptr;
  }
  bool installed = false;
  const auto fail = [&](const std::string& error) -> napi_value {
    if (!installed) DeleteWindowsFileHandle(output);
    CloseNativeHandle(output);
    Throw(env, error);
    return nullptr;
  };
  const auto* body = static_cast<const uint8_t*>(raw_body);
  size_t offset = 0;
  while (offset < body_size) {
    const DWORD requested = static_cast<DWORD>(
        (std::min)(body_size - offset, static_cast<size_t>(UINT32_MAX)));
    DWORD written = 0;
    if (!WriteFile(
            output, body + offset, requested, &written, nullptr) ||
        written == 0) {
      return fail(WindowsError("WriteFile"));
    }
    offset += written;
  }
  WindowsIdentity identity{};
  if (!FlushFileBuffers(output) ||
      !GetWindowsIdentity(output, &identity) ||
      (identity.attributes & (FILE_ATTRIBUTE_DIRECTORY |
                              FILE_ATTRIBUTE_REPARSE_POINT)) ||
      identity.volume != identities.front().volume ||
      identity.links != 1 || identity.size != body_size ||
      !SecureDirectoryStillCurrent(
          root, components, handles, identities)) {
    return fail("secure temporary file failed durability or identity validation");
  }
  const std::wstring destination = Wide(leaf);
  const size_t destination_bytes = destination.size() * sizeof(WCHAR);
  const size_t rename_size =
      offsetof(FILE_RENAME_INFO, FileName) + destination_bytes;
  std::vector<uint8_t> rename_buffer(rename_size);
  auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(rename_buffer.data());
  rename->ReplaceIfExists = FALSE;
  rename->RootDirectory = handles.values.back();
  rename->FileNameLength = static_cast<DWORD>(destination_bytes);
  std::memcpy(
      rename->FileName, destination.data(), rename->FileNameLength);
  NtApi& api = NativeWindowsApi();
  IO_STATUS_BLOCK rename_status_block{};
  const NTSTATUS rename_status = api.set_information
      ? api.set_information(
          output, &rename_status_block, rename,
          static_cast<ULONG>(rename_buffer.size()),
          kFileRenameInformation)
      : static_cast<NTSTATUS>(0xC0000002L);
  if (!NtSuccess(rename_status)) {
    const std::string rename_detail =
        NtError("NtSetInformationFile rename", rename_status);
    const DWORD rename_error = GetLastError();
    if (rename_error == ERROR_ALREADY_EXISTS ||
        rename_error == ERROR_FILE_EXISTS) {
      DeleteWindowsFileHandle(output);
      CloseNativeHandle(output);
      HANDLE existing = INVALID_HANDLE_VALUE;
      const NTSTATUS existing_status = OpenWindowsRelative(
          handles.values.back(), Wide(leaf),
          GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
          &existing);
      WindowsIdentity existing_identity{};
      bool durable_existing =
          NtSuccess(existing_status) &&
          GetWindowsIdentity(existing, &existing_identity) &&
          !(existing_identity.attributes &
            (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
          existing_identity.volume == identities.front().volume &&
          existing_identity.links == 1 &&
          FlushFileBuffers(existing) &&
          SecureDirectoryStillCurrent(
              root, components, handles, identities);
      if (durable_existing) {
        HANDLE latest = INVALID_HANDLE_VALUE;
        const NTSTATUS latest_status = OpenWindowsRelative(
            handles.values.back(), Wide(leaf),
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
            &latest);
        WindowsIdentity latest_identity{};
        durable_existing =
            NtSuccess(latest_status) &&
            GetWindowsIdentity(latest, &latest_identity) &&
            SameIdentity(existing_identity, latest_identity);
        if (latest != INVALID_HANDLE_VALUE) CloseNativeHandle(latest);
      }
      if (existing != INVALID_HANDLE_VALUE) CloseNativeHandle(existing);
      if (durable_existing) {
        ThrowCode(env, "EEXIST", rename_detail);
      } else {
        Throw(env, "existing secure publication failed durability validation");
      }
      return nullptr;
    }
    return fail(rename_detail);
  }
  installed = true;
  HANDLE current = INVALID_HANDLE_VALUE;
  const NTSTATUS current_status = OpenWindowsRelative(
      handles.values.back(), Wide(leaf),
      GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
      &current);
  WindowsIdentity current_identity{};
  if (!FlushFileBuffers(output) ||
      !NtSuccess(current_status) ||
      !GetWindowsIdentity(current, &current_identity) ||
      !SameIdentity(identity, current_identity) ||
      current_identity.links != 1 ||
      !FlushFileBuffers(current) ||
      !SecureDirectoryStillCurrent(
          root, components, handles, identities)) {
    if (current != INVALID_HANDLE_VALUE) CloseNativeHandle(current);
    CloseNativeHandle(output);
    Throw(env, "secure publication failed final durability validation");
    return nullptr;
  }
  HANDLE latest = INVALID_HANDLE_VALUE;
  const NTSTATUS latest_status = OpenWindowsRelative(
      handles.values.back(), Wide(leaf),
      FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
      &latest);
  WindowsIdentity latest_identity{};
  if (!NtSuccess(latest_status) ||
      !GetWindowsIdentity(latest, &latest_identity) ||
      !SameIdentity(current_identity, latest_identity)) {
    if (latest != INVALID_HANDLE_VALUE) CloseNativeHandle(latest);
    CloseNativeHandle(current);
    CloseNativeHandle(output);
    Throw(env, "secure publication destination changed after installation");
    return nullptr;
  }
  CloseNativeHandle(latest);
  CloseNativeHandle(current);
  CloseNativeHandle(output);
  return Boolean(env, true);
}

napi_value RemoveSecureFile(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  std::string leaf;
  std::string quarantine;
  std::string expected_identity;
  if (argc != 5 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative) ||
      !ReadUtf8(env, args[2], &leaf) ||
      !ReadUtf8(env, args[3], &quarantine) ||
      !ReadUtf8(env, args[4], &expected_identity) ||
      !SafeLeaf(leaf) || !SafeLeaf(quarantine)) {
    Throw(env, "invalid secure file removal");
    return nullptr;
  }
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
  std::vector<std::string> components;
  if (!OpenSecureDirectory(
          root, relative, false, &handles, &identities, &components)) {
    return Boolean(env, false);
  }
  HANDLE target = INVALID_HANDLE_VALUE;
  const NTSTATUS status = OpenWindowsRelative(
      handles.values.back(), Wide(leaf),
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      kFileOpen, kFileNonDirectoryFile | kFileSynchronousIoNonAlert,
      &target);
  if (status == kStatusObjectNameNotFound ||
      status == kStatusObjectPathNotFound) {
    return Boolean(env, false);
  }
  if (!NtSuccess(status)) {
    Throw(env, NtError("NtCreateFile removal target", status));
    return nullptr;
  }
  WindowsIdentity identity{};
  if (!GetWindowsIdentity(target, &identity) ||
      (identity.attributes & (FILE_ATTRIBUTE_DIRECTORY |
                              FILE_ATTRIBUTE_REPARSE_POINT)) ||
      identity.volume != identities.front().volume ||
      identity.links != 1 ||
      (!expected_identity.empty() &&
       IdentityToken(identity) != expected_identity) ||
      !SecureDirectoryStillCurrent(
          root, components, handles, identities)) {
    CloseNativeHandle(target);
    Throw(env, "secure removal target failed identity validation");
    return nullptr;
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          target, FileDispositionInfo, &disposition,
          sizeof(disposition))) {
    const std::string error = WindowsError(
        "SetFileInformationByHandle disposition");
    CloseNativeHandle(target);
    Throw(env, error);
    return nullptr;
  }
  CloseNativeHandle(target);
  return Boolean(env, true);
}

JobAuthority* Authority(napi_env env, napi_value value) {
  void* raw = nullptr;
  if (napi_get_value_external(env, value, &raw) != napi_ok || !raw) {
    Throw(env, "invalid Windows Job Object authority");
    return nullptr;
  }
  return static_cast<JobAuthority*>(raw);
}

void FinalizeJob(napi_env, void* data, void*) {
  auto* authority = static_cast<JobAuthority*>(data);
  if (authority->handle) CloseNativeHandle(authority->handle);
  delete authority;
}

napi_value CreateWindowsJob(napi_env env, napi_callback_info) {
  HANDLE handle = CreateJobObjectW(nullptr, nullptr);
  if (!handle) {
    Throw(env, WindowsError("CreateJobObjectW"));
    return nullptr;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(
          handle, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    const std::string error = WindowsError("SetInformationJobObject");
    CloseNativeHandle(handle);
    Throw(env, error);
    return nullptr;
  }
  auto* authority = new JobAuthority{handle};
  napi_value external;
  if (napi_create_external(env, authority, FinalizeJob, nullptr, &external) != napi_ok) {
    CloseNativeHandle(handle);
    delete authority;
    Throw(env, "could not create Windows Job Object authority");
    return nullptr;
  }
  return external;
}

napi_value AssignWindowsJob(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) {
    Throw(env, "assignWindowsJob requires a Job and pid");
    return nullptr;
  }
  JobAuthority* authority = Authority(env, args[0]);
  if (!authority || !authority->handle) return nullptr;
  int64_t raw_pid = 0;
  if (napi_get_value_int64(env, args[1], &raw_pid) != napi_ok ||
      raw_pid <= 0 || raw_pid > UINT32_MAX) {
    Throw(env, "invalid Windows process id");
    return nullptr;
  }
  HANDLE process = OpenProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
      FALSE, static_cast<DWORD>(raw_pid));
  if (!process) {
    Throw(env, WindowsError("OpenProcess"));
    return nullptr;
  }
  const BOOL assigned = AssignProcessToJobObject(authority->handle, process);
  const std::string error = assigned ? "" : WindowsError("AssignProcessToJobObject");
  CloseNativeHandle(process);
  if (!assigned) {
    Throw(env, error);
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value TerminateWindowsJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  JobAuthority* authority = argc == 1 ? Authority(env, args[0]) : nullptr;
  if (!authority || !authority->handle) return nullptr;
  if (!TerminateJobObject(authority->handle, 1)) {
    Throw(env, WindowsError("TerminateJobObject"));
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value WindowsJobActiveProcesses(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  JobAuthority* authority = argc == 1 ? Authority(env, args[0]) : nullptr;
  if (!authority || !authority->handle) return nullptr;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(
          authority->handle, JobObjectBasicAccountingInformation,
          &accounting, sizeof(accounting), nullptr)) {
    Throw(env, WindowsError("QueryInformationJobObject"));
    return nullptr;
  }
  napi_value result;
  napi_create_uint32(env, accounting.ActiveProcesses, &result);
  return result;
}

napi_value CloseWindowsJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  JobAuthority* authority = argc == 1 ? Authority(env, args[0]) : nullptr;
  if (!authority) return nullptr;
  if (authority->handle) {
    CloseNativeHandle(authority->handle);
    authority->handle = nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

#else

napi_value Unsupported(napi_env env, napi_callback_info) {
  Throw(env, "Windows Job Objects are unavailable on this platform");
  return nullptr;
}

#endif


napi_value WindowsProcessBirthMarker(napi_env env, napi_callback_info info) {
#ifdef _WIN32
  size_t argc=1;napi_value args[1];uint32_t pid=0;
  napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  if(argc!=1 || napi_get_value_uint32(env,args[0],&pid)!=napi_ok || pid==0)return Null(env);
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
  if(!process)return Null(env);
  FILETIME creation{},exit{},kernel{},user{};
  const BOOL found=GetProcessTimes(process,&creation,&exit,&kernel,&user);
  CloseHandle(process);
  const uint64_t ticks=(static_cast<uint64_t>(creation.dwHighDateTime)<<32)|creation.dwLowDateTime;
  if(!found || ticks==0)return Null(env);
  const std::string marker=std::to_string(ticks);napi_value result;
  napi_create_string_utf8(env,marker.c_str(),marker.size(),&result);return result;
#else
  return Null(env);
#endif
}

napi_value DarwinProcessBirthMarker(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t pid = 0;
  if (argc != 1 || napi_get_value_int32(env, args[0], &pid) != napi_ok ||
      pid <= 0) {
    return Null(env);
  }
  struct proc_bsdinfo process_info{};
  const int bytes = proc_pidinfo(
      pid, PROC_PIDTBSDINFO, 0, &process_info, sizeof(process_info));
  if (bytes != static_cast<int>(sizeof(process_info)) ||
      process_info.pbi_pid != static_cast<uint32_t>(pid) ||
      process_info.pbi_start_tvsec == 0 ||
      process_info.pbi_start_tvusec >= 1000000) {
    return Null(env);
  }
  const std::string marker =
      std::to_string(process_info.pbi_start_tvsec) + ":" +
      std::to_string(process_info.pbi_start_tvusec);
  napi_value value;
  napi_create_string_utf8(env, marker.c_str(), marker.size(), &value);
  return value;
#else
  return Null(env);
#endif
}

napi_value WindowsJobObjectsSupported(napi_env env, napi_callback_info) {
  napi_value value;
#ifdef _WIN32
  napi_get_boolean(env, true, &value);
#else
  napi_get_boolean(env, false, &value);
#endif
  return value;
}

napi_value SecureFileAuthoritySupported(napi_env env, napi_callback_info) {
  napi_value value;
  napi_get_boolean(env, true, &value);
  return value;
}

napi_value DataDirectoryAuthoritySupported(napi_env env, napi_callback_info) {
  napi_value value;
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
  napi_get_boolean(env, true, &value);
#else
  napi_get_boolean(env, false, &value);
#endif
  return value;
}

napi_value DataDirectoryAuthorityUnavailable(napi_env env, napi_callback_info) {
  Throw(env, "descriptor-rooted data-directory authority is unavailable on this platform");
  return nullptr;
}

napi_value EnsureSecureDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  if (argc != 2 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative)) {
    Throw(env, "invalid secure directory creation");
    return nullptr;
  }
#ifdef _WIN32
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
#else
  DescriptorSet handles;
  std::vector<struct stat> identities;
#endif
  std::vector<std::string> components;
  const bool stable = OpenSecureDirectory(
      root, relative, true, &handles, &identities, &components) &&
      SecureDirectoryStillCurrent(root, components, handles, identities);
  return Boolean(env, stable);
}

napi_value SecureDirectoryIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  std::string root;
  std::string relative;
  if (argc != 2 || !ReadUtf8(env, args[0], &root) ||
      !ReadUtf8(env, args[1], &relative)) return Null(env);
#ifdef _WIN32
  WindowsHandleSet handles;
  std::vector<WindowsIdentity> identities;
#else
  DescriptorSet handles;
  std::vector<struct stat> identities;
#endif
  std::vector<std::string> components;
  if (!OpenSecureDirectory(root, relative, false, &handles, &identities,
                           &components) ||
      !SecureDirectoryStillCurrent(root, components, handles, identities)) {
    return Null(env);
  }
  const std::string token = IdentityToken(identities.back());
  napi_value value;
  napi_create_string_utf8(env, token.c_str(), token.size(), &value);
  return value;
}

// Physical mount evidence from the retained descriptor. No pathname parsing or
// st_dev inference: same-filesystem bind mounts have distinct mount identities.
napi_value OfflineMountIdentity(napi_env env, napi_callback_info info) {
#if defined(__linux__) && defined(SYS_statx) && defined(STATX_MNT_ID) && defined(AT_EMPTY_PATH) && defined(AT_SYMLINK_NOFOLLOW)
  size_t argc = 1;
  napi_value args[1]; int32_t fd = -1;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  struct stat before{}, after{};
  struct statx evidence{};
  const unsigned int requested = STATX_INO | STATX_MNT_ID;
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0 ||
      fstat(fd, &before) != 0 ||
      syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
              requested, &evidence) != 0 ||
      (evidence.stx_mask & requested) != requested || evidence.stx_mnt_id == 0 ||
      evidence.stx_ino != static_cast<uint64_t>(before.st_ino) ||
      makedev(evidence.stx_dev_major, evidence.stx_dev_minor) != before.st_dev ||
      fstat(fd, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino) {
    Throw(env, "offline descriptor mount evidence unavailable"); return nullptr;
  }
  napi_value result;
  napi_create_bigint_uint64(env, evidence.stx_mnt_id, &result);
  return result;
#else
  Throw(env, "offline descriptor mount evidence requires Linux statx mount IDs"); return nullptr;
#endif
}

// Offline transfer accepts only ordinary files/directories without extended
// attributes. Inspect every descriptor, rather than assuming a pathname copy
// preserves ACLs, security labels or unsupported metadata. No source mutation.
napi_value OfflineMetadataImpl(napi_env env, napi_callback_info info, bool workspace) {
#ifdef __linux__
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  int32_t source = -1, target = -1;
  int source_flags = 0;
  struct stat before{}, after{}, destination{};
  if (argc < 1 || napi_get_value_int32(env, args[0], &source) != napi_ok ||
      source < 0 || fstat(source, &before) != 0 ||
      (!S_ISREG(before.st_mode) && !S_ISDIR(before.st_mode)) ||
      (S_ISREG(before.st_mode) && (!before.st_nlink || (!workspace && before.st_nlink != 1))) ||
      (before.st_mode & (S_ISUID | S_ISGID | S_ISVTX)) ||
      flistxattr(source, nullptr, 0) != 0 ||
      ioctl(source, FS_IOC_GETFLAGS, &source_flags) != 0 ||
      (source_flags & ~(FS_EXTENT_FL | FS_INDEX_FL)) != 0) {
    Throw(env, "unsupported offline transfer metadata"); return nullptr;
  }
  if (argc == 2) {
    if (napi_get_value_int32(env, args[1], &target) != napi_ok || target < 0 ||
        source == target || fstat(target, &destination) != 0 ||
        (before.st_dev == destination.st_dev && before.st_ino == destination.st_ino) ||
        (before.st_mode & S_IFMT) != (destination.st_mode & S_IFMT) ||
        (S_ISREG(destination.st_mode) && destination.st_nlink != 1) ||
        flistxattr(target, nullptr, 0) != 0 ||
        fchown(target, before.st_uid, before.st_gid) != 0 ||
        fchmod(target, before.st_mode & 0777) != 0) {
      Throw(env, "offline transfer metadata copy refused"); return nullptr;
    }
    const struct timespec times[2] = {before.st_atim, before.st_mtim};
    if (futimens(target, times) != 0 || fsync(target) != 0) {
      Throw(env, "offline transfer metadata sync failed"); return nullptr;
    }
  }
  if (fstat(source, &after) != 0 || before.st_dev != after.st_dev ||
      before.st_ino != after.st_ino || before.st_mode != after.st_mode ||
      before.st_uid != after.st_uid || before.st_gid != after.st_gid ||
      before.st_nlink != after.st_nlink || before.st_size != after.st_size ||
      before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
      before.st_atim.tv_sec != after.st_atim.tv_sec || before.st_atim.tv_nsec != after.st_atim.tv_nsec ||
      before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec ||
      flistxattr(source, nullptr, 0) != 0) {
    Throw(env, "offline transfer source metadata changed"); return nullptr;
  }
  return Boolean(env, true);
#else
  Throw(env, "offline transfer metadata requires Linux"); return nullptr;
#endif
}

// Separate offline helper, not a relaxation of runtime secure-file authority.
napi_value OfflineMetadata(napi_env env, napi_callback_info info) { return OfflineMetadataImpl(env, info, false); }
napi_value OfflineWorkspaceMetadata(napi_env env, napi_callback_info info) { return OfflineMetadataImpl(env, info, true); }

// Reopen the held directory, then seek to its opaque kernel cookie. Each call
// retains at most 128 names, not a vector/JS array proportional to directory size.
napi_value OfflineDirectoryBatch(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 2; napi_value args[2]; int32_t fd = -1; int64_t cookie = -1; bool exact = false;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr); struct stat before{}, after{};
  if (argc != 2 || napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0 ||
      napi_get_value_bigint_int64(env, args[1], &cookie, &exact) != napi_ok || !exact || cookie < 0 || cookie > LONG_MAX ||
      fstat(fd, &before) != 0 || !S_ISDIR(before.st_mode)) {
    Throw(env, "invalid offline directory batch"); return nullptr;
  }
  const int copied = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NOATIME | O_CLOEXEC);
  DIR* directory = copied < 0 ? nullptr : fdopendir(copied);
  if (!directory) { if (copied >= 0) CloseNativeDescriptor(copied); Throw(env, "offline directory enumeration failed"); return nullptr; }
  seekdir(directory, static_cast<long>(cookie));
  napi_value names; napi_create_array(env, &names); uint32_t index = 0; int failure = 0; bool done = false;
  while (index < 128) {
    errno = 0; const struct dirent* entry = readdir(directory);
    if (!entry) { failure = errno; done = failure == 0; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    const size_t length = strnlen(entry->d_name, 256);
    if (length == 0 || length > 255) { failure = EINVAL; break; }
    napi_value name; napi_create_buffer_copy(env, length, entry->d_name, nullptr, &name);
    napi_set_element(env, names, index++, name);
  }
  const long next = telldir(directory);
  if (next < 0 || fstat(fd, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
      before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec) failure = EINVAL;
  closedir(directory);
  if (failure) { Throw(env, "offline directory enumeration incomplete"); return nullptr; }
  napi_value result, value; napi_create_object(env, &result); napi_set_named_property(env, result, "names", names);
  napi_create_bigint_int64(env, next, &value); napi_set_named_property(env, result, "next", value);
  napi_set_named_property(env, result, "done", Boolean(env, done)); return result;
#else
  Throw(env, "offline directory enumeration requires Linux"); return nullptr;
#endif
}

#ifdef __linux__
bool OfflineLinkMountFlags(int fd, unsigned long* flags) {
  struct statvfs evidence{};
  if (fd < 0 || fstatvfs(fd, &evidence) != 0 ||
      !(evidence.f_flag & (ST_NOATIME | ST_RDONLY))) return false;
  *flags = evidence.f_flag;
  return true;
}

bool SameOfflineLink(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode &&
      a.st_uid == b.st_uid && a.st_gid == b.st_gid && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
      a.st_atim.tv_sec == b.st_atim.tv_sec && a.st_atim.tv_nsec == b.st_atim.tv_nsec &&
      a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
      a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
}

// O_PATH retains the link itself. readlinkat's empty path reads its bytes without
// resolving any target. O_PATH ignores O_NOATIME: establish a physical noatime
// or read-only mount BEFORE reading bytes, and recheck it after every read.
// Attribute inspection uses a held parent and no-follow
// named checks; unknown metadata refuses rather than being silently discarded.
bool InspectOfflineLink(int fd, int parent, const std::string& leaf, struct stat* original, std::string* target) {
  struct stat directory{}, named{}, after{};
  unsigned long mount_flags = 0, after_flags = 0;
  if (fd < 0 || parent < 0 || !SafeLeaf(leaf) || fstat(parent, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
      !OfflineLinkMountFlags(fd, &mount_flags) ||
      fstat(fd, original) != 0 || !S_ISLNK(original->st_mode) || original->st_nlink != 1 ||
      (original->st_mode & 07777) != 0777 || original->st_size <= 0 || original->st_size > 4096 ||
      fstatat(parent, leaf.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || !SameOfflineLink(*original, named)) return false;
  const std::string path = "/proc/self/fd/" + std::to_string(parent) + "/" + leaf;
  if (llistxattr(path.c_str(), nullptr, 0) != 0) return false;
#if defined(SYS_statx) && defined(STATX_MNT_ID) && defined(AT_EMPTY_PATH)
  struct statx evidence{};
  const uint64_t required_attributes = STATX_ATTR_IMMUTABLE | STATX_ATTR_APPEND | STATX_ATTR_NODUMP;
  if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS | STATX_MNT_ID, &evidence) != 0 ||
      (evidence.stx_mask & (STATX_INO | STATX_MNT_ID)) != (STATX_INO | STATX_MNT_ID) ||
      (evidence.stx_attributes_mask & required_attributes) != required_attributes || evidence.stx_attributes != 0 ||
      evidence.stx_ino != static_cast<uint64_t>(original->st_ino) ||
      makedev(evidence.stx_dev_major, evidence.stx_dev_minor) != original->st_dev) return false;
#else
  return false;
#endif
  std::vector<char> bytes(static_cast<size_t>(original->st_size) + 1);
  const ssize_t count = readlinkat(fd, "", bytes.data(), bytes.size());
  if (count != original->st_size) return false;
  target->assign(bytes.data(), static_cast<size_t>(count));
  return target->find('\0') == std::string::npos && fstat(fd, &after) == 0 && SameOfflineLink(*original, after) &&
      OfflineLinkMountFlags(fd, &after_flags) && mount_flags == after_flags &&
      fstatat(parent, leaf.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 && SameOfflineLink(*original, named) &&
      llistxattr(path.c_str(), nullptr, 0) == 0;
}
#endif

napi_value OfflineLinkReadMountFlags(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 1; napi_value args[1]; int32_t fd = -1; unsigned long flags = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok || !OfflineLinkMountFlags(fd, &flags)) {
    Throw(env, "offline link reads require a physical noatime or read-only mount"); return nullptr;
  }
  napi_value value; napi_create_bigint_uint64(env, static_cast<uint64_t>(flags), &value); return value;
#else
  Throw(env, "offline link mount policy requires Linux"); return nullptr;
#endif
}

napi_value OfflineOpenLink(napi_env env, napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH)
  size_t argc = 2; napi_value args[2]; int32_t parent = -1; std::string leaf;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  struct stat directory{};
  if (argc != 2 || napi_get_value_int32(env, args[0], &parent) != napi_ok || parent < 0 ||
      !ReadUtf8(env, args[1], &leaf) || !SafeLeaf(leaf) || fstat(parent, &directory) != 0 || !S_ISDIR(directory.st_mode)) {
    Throw(env, "invalid offline link parent"); return nullptr;
  }
  const int fd = openat(parent, leaf.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC);
  struct stat before{}; std::string target;
  if (fd < 0 || !InspectOfflineLink(fd, parent, leaf, &before, &target)) {
    if (fd >= 0) CloseNativeDescriptor(fd);
    Throw(env, "offline link evidence unavailable"); return nullptr;
  }
  napi_value value; napi_create_int32(env, fd, &value); return value;
#else
  Throw(env, "offline links require Linux O_PATH"); return nullptr;
#endif
}

napi_value OfflineReadLink(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 3; napi_value args[3]; int32_t fd = -1, parent = -1; std::string leaf, target;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  struct stat before{};
  if (argc != 3 || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      napi_get_value_int32(env, args[1], &parent) != napi_ok || !ReadUtf8(env, args[2], &leaf) ||
      !InspectOfflineLink(fd, parent, leaf, &before, &target)) {
    Throw(env, "offline link changed or unsupported"); return nullptr;
  }
  napi_value value; napi_create_buffer_copy(env, target.size(), target.data(), nullptr, &value); return value;
#else
  Throw(env, "offline links require Linux"); return nullptr;
#endif
}

napi_value OfflineCopyLink(napi_env env, napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH)
  size_t argc = 6; napi_value args[6]; int32_t source = -1, parent = -1, destination = -1;
  std::string leaf, destination_leaf, original_target; void* bytes = nullptr; size_t size = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  struct stat before{}, directory{};
  unsigned long destination_flags = 0;
  if (argc != 6 || napi_get_value_int32(env, args[0], &source) != napi_ok ||
      napi_get_value_int32(env, args[1], &parent) != napi_ok || !ReadUtf8(env, args[2], &leaf) ||
      napi_get_value_int32(env, args[3], &destination) != napi_ok || destination < 0 ||
      !ReadUtf8(env, args[4], &destination_leaf) || !SafeLeaf(destination_leaf) ||
      napi_get_buffer_info(env, args[5], &bytes, &size) != napi_ok || size == 0 || size > 4096 ||
      std::memchr(bytes, '\0', size) != nullptr || fstat(destination, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
      !OfflineLinkMountFlags(destination, &destination_flags) || !(destination_flags & ST_NOATIME) ||
      !InspectOfflineLink(source, parent, leaf, &before, &original_target)) {
    Throw(env, "invalid offline link copy"); return nullptr;
  }
  const std::string target(static_cast<const char*>(bytes), size);
  if (symlinkat(target.c_str(), destination, destination_leaf.c_str()) != 0) {
    Throw(env, "offline link no-replace creation failed"); return nullptr;
  }
  const int fd = openat(destination, destination_leaf.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC);
  struct stat copied{}, after{}; std::string copied_target, current_target;
  const struct timespec times[2] = {before.st_atim, before.st_mtim};
  bool accepted = fd >= 0 && InspectOfflineLink(fd, destination, destination_leaf, &copied, &copied_target) && copied_target == target &&
      !(copied.st_dev == before.st_dev && copied.st_ino == before.st_ino) &&
      fchownat(destination, destination_leaf.c_str(), before.st_uid, before.st_gid, AT_SYMLINK_NOFOLLOW) == 0 &&
      utimensat(destination, destination_leaf.c_str(), times, AT_SYMLINK_NOFOLLOW) == 0 && fsync(destination) == 0 &&
      InspectOfflineLink(fd, destination, destination_leaf, &copied, &copied_target) && copied_target == target &&
      copied.st_uid == before.st_uid && copied.st_gid == before.st_gid && copied.st_mode == before.st_mode &&
      copied.st_atim.tv_sec == before.st_atim.tv_sec && copied.st_atim.tv_nsec == before.st_atim.tv_nsec &&
      copied.st_mtim.tv_sec == before.st_mtim.tv_sec && copied.st_mtim.tv_nsec == before.st_mtim.tv_nsec &&
      InspectOfflineLink(source, parent, leaf, &after, &current_target) && SameOfflineLink(before, after) && current_target == original_target;
  if (fd >= 0) CloseNativeDescriptor(fd);
  if (!accepted) { Throw(env, "offline link copy verification failed; retained"); return nullptr; }
  return Boolean(env, true);
#else
  Throw(env, "offline links require Linux O_PATH"); return nullptr;
#endif
}

#ifdef __linux__
bool InspectOfflineSpecial(int fd, int parent, const std::string& leaf, struct stat* before) {
#if defined(O_PATH) && defined(SYS_statx) && defined(STATX_MNT_ID)
  struct stat directory{}, named{}, after{}; struct statx evidence{};
  const uint64_t attrs = STATX_ATTR_IMMUTABLE | STATX_ATTR_APPEND | STATX_ATTR_NODUMP;
  const unsigned mask = STATX_TYPE | STATX_MODE | STATX_NLINK | STATX_UID | STATX_GID | STATX_INO | STATX_MNT_ID;
  if (fd < 0 || (fcntl(fd, F_GETFL) & O_PATH) != O_PATH || parent < 0 || !SafeLeaf(leaf) || fstat(fd, before) != 0 ||
      (!S_ISFIFO(before->st_mode) && !S_ISSOCK(before->st_mode)) || before->st_rdev != 0 || before->st_nlink != 1 ||
      (before->st_mode & (S_ISUID | S_ISGID | S_ISVTX)) ||
      fstat(parent, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
      fstatat(parent, leaf.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || !SameOfflineLink(*before, named) ||
      syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, mask, &evidence) != 0 ||
      (evidence.stx_mask & mask) != mask || (evidence.stx_attributes_mask & attrs) != attrs || evidence.stx_attributes != 0 ||
      evidence.stx_mnt_id == 0 || evidence.stx_ino != static_cast<uint64_t>(before->st_ino) ||
      makedev(evidence.stx_dev_major, evidence.stx_dev_minor) != before->st_dev ||
      evidence.stx_mode != before->st_mode || evidence.stx_nlink != before->st_nlink ||
      evidence.stx_uid != before->st_uid || evidence.stx_gid != before->st_gid) return false;
  const std::string path = "/proc/self/fd/" + std::to_string(parent) + "/" + leaf;
  return llistxattr(path.c_str(), nullptr, 0) == 0 && fstat(fd, &after) == 0 && SameOfflineLink(*before, after);
#else
  return false;
#endif
}
#endif

// Metadata-only O_PATH: never open FIFO streams or connect/bind/listen sockets.
napi_value OfflineOpenSpecial(napi_env env, napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH)
  size_t argc = 2; napi_value args[2]; int32_t parent = -1; std::string leaf;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr); struct stat before{};
  if (argc != 2 || napi_get_value_int32(env, args[0], &parent) != napi_ok || parent < 0 ||
      !ReadUtf8(env, args[1], &leaf) || !SafeLeaf(leaf)) { Throw(env, "invalid offline node parent"); return nullptr; }
  const int fd = openat(parent, leaf.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || !InspectOfflineSpecial(fd, parent, leaf, &before)) {
    if (fd >= 0) CloseNativeDescriptor(fd);
    Throw(env, "unsupported offline node metadata"); return nullptr;
  }
  napi_value result; napi_create_int32(env, fd, &result); return result;
#else
  Throw(env, "offline inert nodes require Linux O_PATH"); return nullptr;
#endif
}

napi_value OfflineSpecialMetadata(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 3; napi_value args[3]; int32_t fd = -1, parent = -1; std::string leaf; struct stat before{};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 || napi_get_value_int32(env, args[0], &fd) != napi_ok ||
      napi_get_value_int32(env, args[1], &parent) != napi_ok || !ReadUtf8(env, args[2], &leaf) ||
      !InspectOfflineSpecial(fd, parent, leaf, &before)) { Throw(env, "offline node changed or unsupported"); return nullptr; }
  return Boolean(env, true);
#else
  Throw(env, "offline node metadata requires Linux"); return nullptr;
#endif
}

napi_value OfflineCopySpecial(napi_env env, napi_callback_info info) {
#if defined(__linux__) && defined(O_PATH)
  size_t argc = 5; napi_value args[5]; int32_t source = -1, parent = -1, destination = -1;
  std::string leaf, destination_leaf; struct stat before{}, copied{}, after{}, directory{}, directory_after{};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 5 || napi_get_value_int32(env, args[0], &source) != napi_ok || napi_get_value_int32(env, args[1], &parent) != napi_ok ||
      !ReadUtf8(env, args[2], &leaf) || napi_get_value_int32(env, args[3], &destination) != napi_ok ||
      !ReadUtf8(env, args[4], &destination_leaf) || !SafeLeaf(destination_leaf) ||
      !InspectOfflineSpecial(source, parent, leaf, &before) || fstat(destination, &directory) != 0 || !S_ISDIR(directory.st_mode)) {
    Throw(env, "invalid offline inert node copy"); return nullptr;
  }
  if (mknodat(destination, destination_leaf.c_str(), (before.st_mode & S_IFMT) | 0600, 0) != 0) {
    Throw(env, "offline node no-replace creation unsupported"); return nullptr;
  }
  const int fd = openat(destination, destination_leaf.c_str(), O_PATH | O_NOFOLLOW | O_CLOEXEC);
  const struct timespec times[2] = {before.st_atim, before.st_mtim};
  const bool accepted = fd >= 0 && InspectOfflineSpecial(fd, destination, destination_leaf, &copied) &&
      (copied.st_mode & S_IFMT) == (before.st_mode & S_IFMT) &&
      !(copied.st_dev == before.st_dev && copied.st_ino == before.st_ino) &&
      fchownat(destination, destination_leaf.c_str(), before.st_uid, before.st_gid, AT_SYMLINK_NOFOLLOW) == 0 &&
      fchmodat(destination, destination_leaf.c_str(), before.st_mode & 0777, AT_SYMLINK_NOFOLLOW) == 0 &&
      utimensat(destination, destination_leaf.c_str(), times, AT_SYMLINK_NOFOLLOW) == 0 && fsync(destination) == 0 &&
      InspectOfflineSpecial(fd, destination, destination_leaf, &copied) && copied.st_mode == before.st_mode &&
      copied.st_uid == before.st_uid && copied.st_gid == before.st_gid && copied.st_rdev == before.st_rdev &&
      copied.st_atim.tv_sec == before.st_atim.tv_sec && copied.st_atim.tv_nsec == before.st_atim.tv_nsec &&
      copied.st_mtim.tv_sec == before.st_mtim.tv_sec && copied.st_mtim.tv_nsec == before.st_mtim.tv_nsec &&
      InspectOfflineSpecial(source, parent, leaf, &after) && SameOfflineLink(before, after) &&
      fstat(destination, &directory_after) == 0 && directory.st_dev == directory_after.st_dev && directory.st_ino == directory_after.st_ino;
  if (fd >= 0) CloseNativeDescriptor(fd);
  if (!accepted) { Throw(env, "offline inert node copy verification failed; retained"); return nullptr; }
  return Boolean(env, true);
#else
  Throw(env, "offline inert nodes require Linux O_PATH"); return nullptr;
#endif
}

// Alias an observed fresh regular inode inside ONE clone, never the original.
// Actual parent/leaf/descriptor/type identity is checked around no-replace linkat.
napi_value OfflineLinkFile(napi_env env, napi_callback_info info) {
#ifdef __linux__
  size_t argc = 5; napi_value args[5]; int32_t fd = -1, parent = -1, destination = -1; std::string leaf, output;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr); struct stat before{}, named{}, directory{}, copied{}, after{};
  if (argc != 5 || napi_get_value_int32(env, args[0], &fd) != napi_ok || napi_get_value_int32(env, args[1], &parent) != napi_ok ||
      !ReadUtf8(env, args[2], &leaf) || !SafeLeaf(leaf) || napi_get_value_int32(env, args[3], &destination) != napi_ok ||
      !ReadUtf8(env, args[4], &output) || !SafeLeaf(output) || fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_nlink < 1 ||
      fstat(parent, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
      fstat(destination, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
      fstatat(parent, leaf.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0 || !SameOfflineLink(before, named) ||
      linkat(parent, leaf.c_str(), destination, output.c_str(), 0) != 0 || fsync(fd) != 0 || fsync(destination) != 0 ||
      fstatat(destination, output.c_str(), &copied, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(copied.st_mode) ||
      copied.st_dev != before.st_dev || copied.st_ino != before.st_ino || copied.st_nlink != before.st_nlink + 1 ||
      fstat(fd, &after) != 0 || after.st_dev != before.st_dev || after.st_ino != before.st_ino || after.st_nlink != before.st_nlink + 1 ||
      after.st_mode != before.st_mode || after.st_uid != before.st_uid || after.st_gid != before.st_gid || after.st_size != before.st_size ||
      after.st_atim.tv_sec != before.st_atim.tv_sec || after.st_atim.tv_nsec != before.st_atim.tv_nsec ||
      after.st_mtim.tv_sec != before.st_mtim.tv_sec || after.st_mtim.tv_nsec != before.st_mtim.tv_nsec) {
    Throw(env, "offline clone hardlink refused; any partial retained"); return nullptr;
  }
  return Boolean(env, true);
#else
  Throw(env, "offline clone hardlinks require Linux"); return nullptr;
#endif
}

#include "portable-storage.inc"

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"windowsJobObjectsSupported", nullptr, WindowsJobObjectsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"darwinProcessBirthMarker", nullptr, DarwinProcessBirthMarker, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsProcessBirthMarker", nullptr, WindowsProcessBirthMarker, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"secureFileAuthoritySupported", nullptr, SecureFileAuthoritySupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"acquirePortableDataDirectory", nullptr, AcquirePortableDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"adoptPortableDataDirectory", nullptr, AdoptPortableDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"portableDirectoryLeaseTransfer", nullptr, PortableDirectoryLeaseTransfer, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exportPortableDataDirectory", nullptr, ExportPortableDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"portableDataDirectoryPath", nullptr, PortableDirectoryPath, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releasePortableDataDirectory", nullptr, ReleasePortableDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openStorageDirectory", nullptr, OpenStorageDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readStorageDirectory", nullptr, ReadStorageDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"storageOperation", nullptr, StorageOperation, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"storagePathRegistered", nullptr, StoragePathRegistered, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"syncStorageFile", nullptr, SyncStorageFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeStorageFile", nullptr, CloseStorageFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dataDirectoryAuthoritySupported", nullptr, DataDirectoryAuthoritySupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSecureFile", nullptr, ReadSecureFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listSecureDirectory", nullptr, ListSecureDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"ensureSecureDirectory", nullptr, EnsureSecureDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"secureDirectoryIdentity", nullptr, SecureDirectoryIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeSecureFileAtomic", nullptr, WriteSecureFileAtomic, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeSecureFile", nullptr, RemoveSecureFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineMetadata", nullptr, OfflineMetadata, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineWorkspaceMetadata", nullptr, OfflineWorkspaceMetadata, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineDirectoryBatch", nullptr, OfflineDirectoryBatch, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineOpenSpecial", nullptr, OfflineOpenSpecial, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineSpecialMetadata", nullptr, OfflineSpecialMetadata, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineCopySpecial", nullptr, OfflineCopySpecial, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineLinkFile", nullptr, OfflineLinkFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineMountIdentity", nullptr, OfflineMountIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineLinkReadMountFlags", nullptr, OfflineLinkReadMountFlags, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineOpenLink", nullptr, OfflineOpenLink, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineReadLink", nullptr, OfflineReadLink, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"offlineCopyLink", nullptr, OfflineCopyLink, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef __linux__
      {"acquireDataDirectoryAuthority", nullptr, AcquireDataDirectoryAuthority, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"adoptDataDirectoryDescriptor", nullptr, AdoptDataDirectoryDescriptor, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exportDataDirectoryDescriptor", nullptr, ExportDataDirectoryDescriptor, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dataDirectoryAuthorityPath", nullptr, DataDirectoryAuthorityPath, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseDataDirectoryAuthority", nullptr, ReleaseDataDirectoryAuthority, nullptr, nullptr, nullptr, napi_default, nullptr},
#else
      {"acquireDataDirectoryAuthority", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"adoptDataDirectoryDescriptor", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"exportDataDirectoryDescriptor", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dataDirectoryAuthorityPath", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseDataDirectoryAuthority", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
#ifdef _WIN32
      {"createWindowsJob", nullptr, CreateWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assignWindowsJob", nullptr, AssignWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminateWindowsJob", nullptr, TerminateWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsJobActiveProcesses", nullptr, WindowsJobActiveProcesses, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeWindowsJob", nullptr, CloseWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
#else
      {"createWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assignWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminateWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsJobActiveProcesses", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

extern "C" {
#ifdef _WIN32
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int sqlite3_ponderosastorage_init(sqlite3*, char**, const sqlite3_api_routines* api) {
  SQLITE_EXTENSION_INIT2(api);
  return RegisterPortableSqlite();
}
}
