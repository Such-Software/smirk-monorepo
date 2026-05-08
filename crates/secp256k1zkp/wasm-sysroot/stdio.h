#ifndef WASM_SYSROOT_STDIO_H
#define WASM_SYSROOT_STDIO_H
#include <stddef.h>
typedef struct __sFILE FILE;
extern FILE *stderr;
extern FILE *stdout;
extern FILE *stdin;
int fprintf(FILE *stream, const char *format, ...);
int printf(const char *format, ...);
int sprintf(char *str, const char *format, ...);
int snprintf(char *str, size_t size, const char *format, ...);
int vfprintf(FILE *stream, const char *format, void *ap);
int fputs(const char *s, FILE *stream);
int fflush(FILE *stream);
#endif
