#include <node_api.h>

#include <cstdint>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
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

bool ReadUtf8(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  output->assign(buffer.data(), length);
  return true;
}

bool ParseRelativePath(const std::string& input, std::vector<std::string>* components) {
  if (input.empty() || input.size() > 4096 || input[0] == '/' || input[0] == '\\') return false;
  std::string current;
  for (const char value : input) {
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

bool SameIdentity(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
      (left.st_mode & S_IFMT) == (right.st_mode & S_IFMT);
}

napi_value Null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
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
  const int root_fd = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
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
      !SameIdentity(before, after) || before.st_size != after.st_size ||
      after.st_nlink != 1) {
    return Null(env);
  }

  const int current_root = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
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
        !SameIdentity(identities[index + 1], current)) {
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
#ifdef _WIN32
  napi_get_boolean(env, false, &value);
#else
  napi_get_boolean(env, true, &value);
#endif
  return value;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"windowsJobObjectsSupported", nullptr, WindowsJobObjectsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"secureFileAuthoritySupported", nullptr, SecureFileAuthoritySupported, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef _WIN32
      {"createWindowsJob", nullptr, CreateWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assignWindowsJob", nullptr, AssignWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminateWindowsJob", nullptr, TerminateWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsJobActiveProcesses", nullptr, WindowsJobActiveProcesses, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeWindowsJob", nullptr, CloseWindowsJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSecureFile", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
#else
      {"createWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"assignWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminateWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"windowsJobActiveProcesses", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeWindowsJob", nullptr, Unsupported, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readSecureFile", nullptr, ReadSecureFile, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(
      env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
