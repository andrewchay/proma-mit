#define NAPI_VERSION 8
#include <node_api.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

/* 所有子目录操作相对已打开的目录句柄，不跟随符号链接。 */
static napi_value MakeDirectories(napi_env env, napi_callback_info info) {
  size_t count = 2, root_len = 0, relative_len = 0;
  napi_value args[2], result;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2
      || napi_get_value_string_utf8(env, args[0], NULL, 0, &root_len) != napi_ok
      || napi_get_value_string_utf8(env, args[1], NULL, 0, &relative_len) != napi_ok
      || root_len == 0 || root_len > 4096 || relative_len == 0 || relative_len > 4096) {
    napi_throw_error(env, NULL, "安全目录参数无效"); return NULL;
  }
  char *root = calloc(root_len + 1, 1), *relative = calloc(relative_len + 1, 1);
  if (!root || !relative) { free(root); free(relative); napi_throw_error(env, NULL, "安全目录内存分配失败"); return NULL; }
  size_t read_root = 0, read_relative = 0;
  if (napi_get_value_string_utf8(env, args[0], root, root_len + 1, &read_root) != napi_ok
      || napi_get_value_string_utf8(env, args[1], relative, relative_len + 1, &read_relative) != napi_ok
      || read_root != root_len || read_relative != relative_len || strlen(root) != root_len || strlen(relative) != relative_len
      || root[0] != '/' || relative[0] == '/' || relative[relative_len - 1] == '/' || strstr(relative, "//") || strchr(relative, '\\')) {
    free(root); free(relative); napi_throw_error(env, NULL, "安全目录路径无效"); return NULL;
  }
  int fd = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  free(root);
  if (fd < 0) { free(relative); napi_throw_error(env, NULL, "无法安全打开工作树根目录"); return NULL; }
  char *cursor = relative;
  while (cursor && *cursor) {
    char *next = strchr(cursor, '/'); if (next) *next++ = '\0';
    if (!*cursor || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0 || strcmp(cursor, ".git") == 0) {
      close(fd); free(relative); napi_throw_error(env, NULL, "安全目录包含非法路径段"); return NULL;
    }
    int child = openat(fd, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0 && errno == ENOENT) {
      if (mkdirat(fd, cursor, 0700) != 0 && errno != EEXIST) {
        close(fd); free(relative); napi_throw_error(env, NULL, "无法创建授权目录"); return NULL;
      }
      child = openat(fd, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (child < 0) { close(fd); free(relative); napi_throw_error(env, NULL, "授权目录不可用或包含符号链接"); return NULL; }
    close(fd); fd = child; cursor = next;
  }
  close(fd); free(relative);
  napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor property = { "makeDirectories", NULL, MakeDirectories, NULL, NULL, NULL, napi_default, NULL };
  napi_define_properties(env, exports, 1, &property); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
