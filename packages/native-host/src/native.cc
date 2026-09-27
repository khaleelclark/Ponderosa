#include <node_api.h>

#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winternl.h>
#include <io.h>
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
#endif
#endif

namespace {

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
      close(*iterator);
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
  close(current_root);
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
};

void CloseDataDirectoryAuthority(DataDirectoryAuthority* authority) {
  if (!authority || authority->descriptor < 0) return;
  flock(authority->descriptor, LOCK_UN);
  close(authority->descriptor);
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
    close(descriptor);
    Throw(env, detail);
    return nullptr;
  }
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    const int lock_error = errno;
    close(descriptor);
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
  if (verification >= 0) close(verification);
  if (!stable) {
    flock(descriptor, LOCK_UN);
    close(descriptor);
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
  close(current_root);
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
    close(duplicate);
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
      body_size == 0 || body_size > 64 * 1024 * 1024) {
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
    close(output);
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
      if (existing >= 0) close(existing);
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
    if (installed >= 0) close(installed);
    close(output);
    Throw(env, "secure publication directory failed durability validation");
    return nullptr;
  }
  close(installed);
  close(output);
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
  if (quarantined >= 0) close(quarantined);
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
      if (*iterator && *iterator != INVALID_HANDLE_VALUE) CloseHandle(*iterator);
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
constexpr NTSTATUS kStatusObjectNameNotFound =
    static_cast<NTSTATUS>(0xC0000034L);
constexpr NTSTATUS kStatusObjectPathNotFound =
    static_cast<NTSTATUS>(0xC000003AL);

HANDLE OpenWindowsRoot(const std::string& root, bool create = false) {
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
  CloseHandle(current_root);
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
    CloseHandle(current);
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
  CloseHandle(current);
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
    if (status == kStatusNoMoreFiles) break;
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
          if (retained != INVALID_HANDLE_VALUE) CloseHandle(retained);
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
        CloseHandle(retained);
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
      body_size == 0 || body_size > 64 * 1024 * 1024) {
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
    CloseHandle(output);
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
      CloseHandle(output);
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
        if (latest != INVALID_HANDLE_VALUE) CloseHandle(latest);
      }
      if (existing != INVALID_HANDLE_VALUE) CloseHandle(existing);
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
    if (current != INVALID_HANDLE_VALUE) CloseHandle(current);
    CloseHandle(output);
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
    if (latest != INVALID_HANDLE_VALUE) CloseHandle(latest);
    CloseHandle(current);
    CloseHandle(output);
    Throw(env, "secure publication destination changed after installation");
    return nullptr;
  }
  CloseHandle(latest);
  CloseHandle(current);
  CloseHandle(output);
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
    CloseHandle(target);
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
    CloseHandle(target);
    Throw(env, error);
    return nullptr;
  }
  CloseHandle(target);
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
  if (authority->handle) CloseHandle(authority->handle);
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
    CloseHandle(handle);
    Throw(env, error);
    return nullptr;
  }
  auto* authority = new JobAuthority{handle};
  napi_value external;
  if (napi_create_external(env, authority, FinalizeJob, nullptr, &external) != napi_ok) {
    CloseHandle(handle);
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
  CloseHandle(process);
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
    CloseHandle(authority->handle);
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
#ifdef __linux__
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

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"windowsJobObjectsSupported", nullptr, WindowsJobObjectsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"darwinProcessBirthMarker", nullptr, DarwinProcessBirthMarker, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"secureFileAuthoritySupported", nullptr, SecureFileAuthoritySupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dataDirectoryAuthoritySupported", nullptr, DataDirectoryAuthoritySupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSecureFile", nullptr, ReadSecureFile, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listSecureDirectory", nullptr, ListSecureDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"ensureSecureDirectory", nullptr, EnsureSecureDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"secureDirectoryIdentity", nullptr, SecureDirectoryIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeSecureFileAtomic", nullptr, WriteSecureFileAtomic, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeSecureFile", nullptr, RemoveSecureFile, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef __linux__
      {"acquireDataDirectoryAuthority", nullptr, AcquireDataDirectoryAuthority, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"dataDirectoryAuthorityPath", nullptr, DataDirectoryAuthorityPath, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseDataDirectoryAuthority", nullptr, ReleaseDataDirectoryAuthority, nullptr, nullptr, nullptr, napi_default, nullptr},
#else
      {"acquireDataDirectoryAuthority", nullptr, DataDirectoryAuthorityUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
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
