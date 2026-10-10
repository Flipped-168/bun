### Problem
- On Linux, Android and FreeBSD a directory read that a signal interrupts fails with `EINTR`. `fs.readdirSync`, `fs.promises.readdir`, `fs.opendirSync` and `Bun.Glob` throw `EINTR: interrupted system call`. A caller that reads an iterator error as the end of the directory (bin linking, prune) continues with a short listing.
- Each of the four iterator arms makes one `getdents64` or `getdents` call and returns any negative result (`src/sys/lib.rs`, `src/runtime/node/dir_iterator.rs`). macOS retries since #41086.

### Fix
- `bun_sys::getdents64` (Linux, Android) and `bun_sys::getdents` (FreeBSD) loop on `EINTR`, next to `getdirentries64`. Both iterators call them.
- The FreeBSD wrapper reads `ENOENT` as the end of the directory, as both FreeBSD arms did.
- Verified: `test/js/node/fs/fs-eintr-linux.test.ts` (8 of 8 rows report `EINTR` on 1.4.3). Also `cargo check` for the 12 CI targets.

### Background
- `getdents64` returns `EINTR` when a signal arrives during a read on an interruptible filesystem (NFS, CIFS, FUSE).
- Node never reports it: libuv runs an fs request again on `EINTR` (`uv__fs_work`).
- bun has two directory iterators, each with one arm for each OS: `bun_sys::dir_iterator` (Glob, install, resolver) and the one of `node:fs`.
- Considered the retry inside each of the four arms: the same lines four times, and the next reader gets none. The wrapper is the shape #41086 gave macOS.

### Downsides
- None found on the success path: in release builds `text` is 256 bytes smaller, the wrapper is inlined, and the `getdents64` calls for each read are the same.
- A read that gets `EINTR` on every call does not return. libuv behaves the same.

<details><summary>Notes</summary>

Test. A signal cannot be aimed at one syscall of a directory read. The test compiles an `LD_PRELOAD` library that interposes libc `syscall()` (bun issues `getdents64` through it) and fails one `getdents64` of a marked directory with `EINTR`: the first read (`eintr-first-*`) or the read that reports the end of the directory (`eintr-second-*`). The library creates `<dir>.interrupted` when it does, and the test checks that file, so a pass cannot come from a shim that did not interpose. Rows: `fs.readdirSync`, `fs.promises.readdir`, `fs.opendirSync` with `readSync` (the `node:fs` iterator) and `Bun.Glob` (the `bun_sys` iterator). It is glibc-only, like the two shim tests in `fs.test.ts`, and sits next to `fs-eintr-darwin.test.ts`. On 1.4.3 and on a debug build of main every row reports `EINTR`.

Measurements. Release builds of one commit (base 519963edc8), with and without the two changed source files: `text` 80,701,156 and 80,700,900 bytes, file size equal. `bun_sys::dir_iterator::State::next` grows from 599 to 608 bytes and `node::dir_iterator::NewIterator<false>::next` from 547 to 571. There is no `getdents64` symbol in the changed build: the wrapper is inlined in both callers. After the syscall the success path is three instructions in both builds (`test`, one conditional jump, `je`). An interposing counter sees 2 `getdents64` calls for a directory of 3 entries and 5 for one of 1000, before and after, for `readdirSync` and `Bun.Glob`.

Design. The retry could also live inside `linux_syscall::getdents64` (FreeBSD would keep two arms), or in the OS-independent `next()` above the arms (the arm would still return `EINTR` for another layer to hide). The choice was made directly from the reasons in Background. A review of #41480 had asked for this shape in its own change. #41480 carried the retry inside the four arms; that was removed there.

#44195 rewrites the record parsing in the same four `next` functions and edits the buffer arguments of the calls this change replaces. The second of the two to land needs a small rebase.

Other suites. `test/js/node/fs/fs.test.ts`: 613 pass. Three recursive `readdir` stress tests (`should work x 100`) time out in the debug build on the machine used, and they time out the same way with main's `src/`. `test/js/node/fs/dir.test.ts`: 23 pass. `test/js/bun/glob/scan.test.ts`: the same six recursive scans time out with and without the change.
</details>
