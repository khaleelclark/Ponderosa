// Linux-only test interposer: deterministically replace a directory exactly
// before its descriptor-relative stat/open. No hooks in production code.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int fired;
static void replace(const char *name, const char *boundary) {
  const char *enabled = getenv("PONDEROSA_RACE_ENABLED");
  const char *leaf = getenv("PONDEROSA_RACE_LEAF");
  const char *at = getenv("PONDEROSA_RACE_BOUNDARY");
  if (fired || !enabled || strcmp(enabled,"1") || !leaf || strcmp(name,leaf) || !at || strcmp(at,boundary)) return;
  fired = 1;
  const char *source = getenv("PONDEROSA_RACE_SOURCE");
  const char *backup = getenv("PONDEROSA_RACE_BACKUP");
  const char *target = getenv("PONDEROSA_RACE_TARGET");
  const char *action = getenv("PONDEROSA_RACE_ACTION");
  if (rename(source,backup) != 0) _exit(81);
  if ((action && !strcmp(action,"move") ? rename(target,source) : symlink(target,source)) != 0) _exit(82);
  int marker = syscall(SYS_openat,AT_FDCWD,getenv("PONDEROSA_RACE_MARKER"),O_WRONLY|O_CREAT|O_EXCL,0600);
  if (marker < 0) _exit(83);
  close(marker);
}

int openat(int directory, const char *name, int flags, ...) {
  static int (*original)(int,const char*,int,...);
  if (!original) original = dlsym(RTLD_NEXT,"openat");
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list args; va_start(args,flags); mode = va_arg(args,int); va_end(args); }
  replace(name,"open");
  return original(directory,name,flags,mode);
}

int fstatat(int directory, const char *name, struct stat *result, int flags) {
  static int (*original)(int,const char*,struct stat*,int);
  if (!original) original = dlsym(RTLD_NEXT,"fstatat");
  replace(name,"stat");
  return original(directory,name,result,flags);
}

int openat64(int directory, const char *name, int flags, ...) {
  static int (*original)(int,const char*,int,...);
  if (!original) original = dlsym(RTLD_NEXT,"openat64");
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list args; va_start(args,flags); mode = va_arg(args,int); va_end(args); }
  replace(name,"open");
  return original(directory,name,flags,mode);
}

int fstatat64(int directory, const char *name, struct stat64 *result, int flags) {
  static int (*original)(int,const char*,struct stat64*,int);
  if (!original) original = dlsym(RTLD_NEXT,"fstatat64");
  replace(name,"stat");
  return original(directory,name,result,flags);
}
