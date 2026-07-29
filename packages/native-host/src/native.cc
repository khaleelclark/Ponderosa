#include <node_api.h>

#include <cstdint>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

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

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"windowsJobObjectsSupported", nullptr, WindowsJobObjectsSupported, nullptr, nullptr, nullptr, napi_default, nullptr},
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
