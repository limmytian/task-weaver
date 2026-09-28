/* A test-only modified shared-library wrapper, not a production artifact. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>

__attribute__((constructor)) static void replacement_marker(void) {
  fputs("VIPS_USER_REPLACEMENT_ACTIVE\n", stderr);
}

int vips_init(const char *name) {
  int (*original)(const char *) = dlsym(RTLD_NEXT, "vips_init");
  if (!original) abort();
  return original(name);
}
