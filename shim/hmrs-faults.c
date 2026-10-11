/*
 * libhmrs-faults.so - test scaffolding for hm-radio-simulator, loaded into a daemon with LD_PRELOAD.
 *
 * It changes no daemon code, only what the kernel answers on one file descriptor: read() and select()/poll() on the
 * fd whose path (/proc/self/fd/N) resolves to the device named in HMRS_FAULT_DEV fail with the errno the test asks
 * for, the way a stale /dev/mmd_bidcos (ENODEV after a multimacd restart) or an unplugged USB adapter (EIO) fails.
 * Every other fd, and that fd while no fault is set, goes straight to libc.
 *
 * The orders come from the file HMRS_FAULT_CTL, read on every call (one line):
 *   clear                 no fault
 *   fail <ERRNO>          every read() fails with ERRNO (ENODEV, EIO, ...); select()/poll() report the fd readable,
 *                         as they do for such a device, so the daemon goes on to read()
 *   fail-once <ERRNO>     the next read() fails, then the file is set back to "clear"
 *   eintr-once            the next read() fails with EINTR, then "clear"
 *   select-fail <ERRNO>   every select()/poll() fails with ERRNO
 * Each injected failure is appended to HMRS_FAULT_LOG (one line: the call and the errno), for the test's assertions.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static ssize_t (*real_read)(int, void *, size_t);
static int (*real_select)(int, fd_set *, fd_set *, fd_set *, struct timeval *);
static int (*real_poll)(struct pollfd *, nfds_t, int);

static void init(void) {
    if (!real_read) {
        real_read = (ssize_t (*)(int, void *, size_t))dlsym(RTLD_NEXT, "read");
        real_select = (int (*)(int, fd_set *, fd_set *, fd_set *, struct timeval *))dlsym(RTLD_NEXT, "select");
        real_poll = (int (*)(struct pollfd *, nfds_t, int))dlsym(RTLD_NEXT, "poll");
    }
}

/* whether fd is the device under test (its link target equals the realpath of HMRS_FAULT_DEV) */
static int is_target(int fd) {
    const char *dev = getenv("HMRS_FAULT_DEV");
    if (!dev || fd < 0) {
        return 0;
    }
    char want[PATH_MAX], link[64], have[PATH_MAX];
    if (!realpath(dev, want)) {
        return 0;
    }
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, have, sizeof(have) - 1);
    if (n <= 0) {
        return 0;
    }
    have[n] = 0;
    return strcmp(want, have) == 0;
}

enum mode { CLEAR, FAIL, FAIL_ONCE, EINTR_ONCE, SELECT_FAIL };

static int errno_by_name(const char *name) {
    static const struct { const char *name; int value; } names[] = {
        {"ENODEV", ENODEV}, {"EIO", EIO}, {"EBADF", EBADF}, {"ENXIO", ENXIO}, {"EINTR", EINTR}, {"EAGAIN", EAGAIN},
        {"EINVAL", EINVAL}, {"ENOMEM", ENOMEM},
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (strcmp(names[i].name, name) == 0) {
            return names[i].value;
        }
    }
    return atoi(name) > 0 ? atoi(name) : EIO;
}

/* reads the control file with raw syscalls (no recursion into the wrappers) */
static enum mode current(int *err) {
    const char *ctl = getenv("HMRS_FAULT_CTL");
    *err = 0;
    if (!ctl) {
        return CLEAR;
    }
    int fd = (int)syscall(SYS_openat, AT_FDCWD, ctl, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return CLEAR;
    }
    char buf[64] = {0};
    ssize_t n = syscall(SYS_read, fd, buf, sizeof(buf) - 1);
    syscall(SYS_close, fd);
    if (n <= 0) {
        return CLEAR;
    }
    char word[24] = {0}, arg[24] = {0};
    if (sscanf(buf, "%23s %23s", word, arg) < 1) {
        return CLEAR;
    }
    if (strcmp(word, "fail") == 0) {
        *err = errno_by_name(arg);
        return FAIL;
    }
    if (strcmp(word, "fail-once") == 0) {
        *err = errno_by_name(arg);
        return FAIL_ONCE;
    }
    if (strcmp(word, "eintr-once") == 0) {
        *err = EINTR;
        return EINTR_ONCE;
    }
    if (strcmp(word, "select-fail") == 0) {
        *err = errno_by_name(arg);
        return SELECT_FAIL;
    }
    return CLEAR;
}

static void set_clear(void) {
    const char *ctl = getenv("HMRS_FAULT_CTL");
    if (!ctl) {
        return;
    }
    int fd = (int)syscall(SYS_openat, AT_FDCWD, ctl, O_WRONLY | O_TRUNC | O_CLOEXEC);
    if (fd >= 0) {
        syscall(SYS_write, fd, "clear\n", 6);
        syscall(SYS_close, fd);
    }
}

static void note(const char *call, int err) {
    const char *log = getenv("HMRS_FAULT_LOG");
    if (!log) {
        return;
    }
    int fd = (int)syscall(SYS_openat, AT_FDCWD, log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        char line[64];
        int n = snprintf(line, sizeof(line), "%s %s\n", call, strerrorname_np(err) ? strerrorname_np(err) : "?");
        syscall(SYS_write, fd, line, n);
        syscall(SYS_close, fd);
    }
}

ssize_t read(int fd, void *buf, size_t count) {
    init();
    int err;
    enum mode mode = current(&err);
    if (mode != CLEAR && mode != SELECT_FAIL && is_target(fd)) {
        if (mode == FAIL_ONCE || mode == EINTR_ONCE) {
            set_clear();
        }
        note("read", err);
        errno = err;
        return -1;
    }
    return real_read(fd, buf, count);
}

ssize_t __read_chk(int fd, void *buf, size_t count, size_t buflen) {
    (void)buflen;
    return read(fd, buf, count);
}

int select(int nfds, fd_set *readfds, fd_set *writefds, fd_set *exceptfds, struct timeval *timeout) {
    init();
    int err;
    enum mode mode = current(&err);
    if (mode != CLEAR && readfds) {
        for (int fd = 0; fd < nfds; fd++) {
            if (FD_ISSET(fd, readfds) && is_target(fd)) {
                if (mode == SELECT_FAIL) {
                    note("select", err);
                    errno = err;
                    return -1;
                }
                /* a failing device is reported readable: the daemon goes on to read() */
                FD_ZERO(readfds);
                FD_SET(fd, readfds);
                if (writefds) {
                    FD_ZERO(writefds);
                }
                if (exceptfds) {
                    FD_ZERO(exceptfds);
                }
                return 1;
            }
        }
    }
    return real_select(nfds, readfds, writefds, exceptfds, timeout);
}

int poll(struct pollfd *fds, nfds_t nfds, int timeout) {
    init();
    int err;
    enum mode mode = current(&err);
    if (mode != CLEAR) {
        for (nfds_t i = 0; i < nfds; i++) {
            if ((fds[i].events & POLLIN) && is_target(fds[i].fd)) {
                if (mode == SELECT_FAIL) {
                    note("poll", err);
                    errno = err;
                    return -1;
                }
                for (nfds_t j = 0; j < nfds; j++) {
                    fds[j].revents = 0;
                }
                fds[i].revents = POLLIN;
                return 1;
            }
        }
    }
    return real_poll(fds, nfds, timeout);
}
