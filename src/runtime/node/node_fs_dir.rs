//! The native directory stream behind `fs.Dir`: the directories that one `fs.opendir` holds open, read a bounded batch at a time.

use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::collections::VecDeque;
use std::sync::Arc;

use bun_core::String as BunString;
use bun_event_loop::{ContextId, Task, Taskable, task_tag};
use bun_jsc::virtual_machine::VirtualMachine;
use bun_jsc::{JSGlobalObject, JSValue, JsResult, StringJsc as _};
use bun_paths::resolve_path::{self, platform};
use bun_sys::FdExt as _;
use bun_sys::{self as sys, E, Fd, Maybe};
use bun_threading::Guarded;

use super::dir_iterator as DirIterator;
use super::fs::{ReaddirEntry, ret};
use super::types::{Buffer, Dirent, Encoding};
use crate::webcore;

/// The JS wrapper of a [`Stream`]. It has no methods: `fs.Dir` hands it to the `node:fs` binding.
#[bun_jsc::JsClass(no_constructor)]
pub(crate) struct DirStream {
    stream: Arc<Stream>,
}

impl DirStream {
    pub(crate) fn create(stream: Arc<Stream>, global: &JSGlobalObject) -> JSValue {
        Self::to_js_boxed(Box::new(DirStream { stream }), global)
    }

    /// The stream of a `DirStream` wrapper, or `None` for any other value.
    pub(crate) fn stream_from_js(value: JSValue) -> Option<Arc<Stream>> {
        let this = <Self as bun_jsc::JsClass>::from_js(value)?;
        // SAFETY: `from_js` returned the live payload of a `DirStream` cell,
        // which `value` keeps alive for this call.
        Some(Arc::clone(unsafe { &(*this).stream }))
    }

    /// Codegen `finalize: true`. The directories close with the last reference: this one, unless a read is on the work pool.
    #[allow(clippy::boxed_local)] // codegen's signature
    pub(crate) fn finalize(self: Box<Self>) {
        if !self.stream.closed.load(Ordering::Relaxed) {
            DirStreamCollected::schedule();
        }
    }

    /// Codegen `estimatedSize: true` entry point. Any thread.
    pub(crate) fn estimated_size(&self) -> usize {
        size_of::<Self>() + size_of::<Stream>() + self.stream.native_bytes.load(Ordering::Relaxed)
    }
}

/// node's warning for a `DirStream` that was collected while open. `Task::ptr` is unused.
pub(crate) struct DirStreamCollected;

impl Taskable for DirStreamCollected {
    const TAG: bun_event_loop::TaskTag = task_tag::DirStreamCollected;
    /// Nothing is owned.
    unsafe fn release_unrun(_: *mut Self) {}
    /// A warning of the process, for the listeners of the realm.
    unsafe fn context(_: *const Self) -> ContextId {
        ContextId::NONE
    }
}

impl DirStreamCollected {
    /// GC sweep, JS thread: script cannot run here, so the warning is a task.
    fn schedule() {
        let vm = VirtualMachine::get();
        if vm.event_loop_ref().is_closed_for_tasks() {
            return;
        }
        vm.event_loop_ref()
            .enqueue_task(Task::init(core::ptr::null_mut::<DirStreamCollected>()));
    }

    pub(crate) fn run(global: &JSGlobalObject) -> JsResult<()> {
        let warning =
            BunString::static_("Closing directory handle on garbage collection").to_js(global)?;
        global.emit_warning(
            warning,
            JSValue::UNDEFINED,
            JSValue::UNDEFINED,
            JSValue::UNDEFINED,
        )
    }
}

/// One open directory stream, shared by its JS wrapper and by the reads and closes on the work pool.
pub(crate) struct Stream {
    walk: Guarded<Walk>,
    /// What the walk holds besides `size_of::<Stream>()`, for the GC.
    native_bytes: AtomicUsize,
    /// An explicit close happened. A stream collected without one warns.
    closed: AtomicBool,
}

// SAFETY: the walk is reached only through its lock, and nothing in it is
// thread-affine: descriptors, iterator buffers and owned bytes (the Windows
// iterator's raw name filter is never set).
unsafe impl Send for Stream {}
// SAFETY: see `Send`.
unsafe impl Sync for Stream {}

struct Walk {
    encoding: Encoding,
    recursive: bool,
    /// `None` once closed.
    root: Option<Level>,
    root_ended: bool,
    /// Open child directories, the next one to read at the front.
    children: VecDeque<Level>,
    /// The result of the next read: a child that could not be opened, or a read that failed after the batch had entries.
    pending: Option<sys::Error>,
    /// Counts the batches. A child is read by a later batch than the one that opened it.
    batch: u32,
    bytes: usize,
}

/// One directory of the walk.
struct Level {
    source: Source,
    /// `Dirent.parentPath` of its entries.
    path: Box<[u8]>,
    /// The batch that opened it.
    born: u32,
    /// Entries left in its turn at the front of the queue.
    turn_left: u32,
}

enum Source {
    Os {
        fd: Fd,
        /// Made at the first read.
        iter: Option<LevelIter>,
    },
    /// A `/$bunfs/` directory of a compiled binary. There is no descriptor.
    Graph {
        key: Box<[u8]>,
        /// Listed at the first read.
        entries: Option<std::vec::IntoIter<(Box<[u8]>, bool)>>,
    },
}

impl Drop for Source {
    fn drop(&mut self) {
        if let Source::Os { fd, .. } = self {
            fd.close();
        }
    }
}

enum LevelIter {
    Narrow(Box<DirIterator::WrappedIterator>),
    /// String names come from the UTF-16 iterator, as in `fs.readdir`.
    #[cfg(windows)]
    Wide(Box<DirIterator::WrappedIteratorW>),
}

impl LevelIter {
    fn new<T: ReaddirEntry>(fd: Fd) -> Self {
        #[cfg(windows)]
        if T::IS_U16 {
            return LevelIter::Wide(Box::new(DirIterator::WrappedIteratorW::init(fd)));
        }
        LevelIter::Narrow(Box::new(DirIterator::WrappedIterator::init(fd)))
    }

    fn bytes(&self) -> usize {
        match self {
            LevelIter::Narrow(_) => size_of::<DirIterator::WrappedIterator>(),
            #[cfg(windows)]
            LevelIter::Wide(_) => size_of::<DirIterator::WrappedIteratorW>(),
        }
    }
}

/// How a level's read stopped.
enum Stop {
    /// It gave the entries that were asked for.
    Filled,
    /// The directory has no more entries.
    Ended,
    /// The next entry needs the OS, and this read must not use it.
    NeedsOs,
    /// A child directory could not be opened. Its entry is not reported, as in node.
    ChildFailed(sys::Error),
}

/// What a level's read needs from the walk.
struct TakeCx<'a> {
    encoding: Encoding,
    recursive: bool,
    may_use_os: bool,
    batch: u32,
    /// Children this batch opened.
    opened: &'a mut Vec<Level>,
}

/// One batch of entries.
pub(crate) struct DirBatch {
    entries: ret::Readdir,
    /// The stream has no more entries after this batch.
    ended: bool,
}

impl DirBatch {
    /// The entries as a JS array. A trailing `null` says that the stream ended.
    pub(crate) fn into_js(self, global: &JSGlobalObject) -> JsResult<JSValue> {
        let end = usize::from(self.ended);
        let (array, len) = match self.entries {
            ret::Readdir::WithFileTypes(items) => {
                let len = items.len();
                let array = JSValue::create_empty_array(global, len + end)?;
                let mut previous_path: *mut bun_jsc::JSString = core::ptr::null_mut();
                for (i, item) in items.into_vec().into_iter().enumerate() {
                    let value = item.into_js(global, Some(&mut previous_path))?;
                    array.put_index(global, i as u32, value)?;
                }
                (array, len)
            }
            ret::Readdir::Buffers(mut items) => {
                let len = items.len();
                let array = JSValue::create_empty_array(global, len + end)?;
                for (i, item) in items.iter_mut().enumerate() {
                    let value = item.to_node_buffer(global)?;
                    array.put_index(global, i as u32, value)?;
                }
                (array, len)
            }
            ret::Readdir::Files(_) => unreachable!("a directory stream reads Dirents or Buffers"),
        };
        if self.ended {
            array.put_index(global, len as u32, JSValue::NULL)?;
        }
        Ok(array)
    }
}

impl Stream {
    /// `path` is the caller's, for the error. `path_z` is the one the OS opens and `Dirent.parentPath` reports.
    pub(crate) fn open(
        path: &[u8],
        path_z: &bun_core::ZStr,
        encoding: Encoding,
        recursive: bool,
    ) -> Maybe<Arc<Stream>> {
        let source = match Source::open_root(path_z) {
            Ok(source) => source,
            Err(err) => return Err(open_error(&err, path)),
        };
        let root = Level {
            source,
            path: Box::from(path_z.as_bytes()),
            born: 0,
            turn_left: 0,
        };
        let bytes = root.bytes();
        Ok(Arc::new(Stream {
            walk: Guarded::new(Walk {
                encoding,
                recursive,
                root: Some(root),
                root_ended: false,
                children: VecDeque::new(),
                pending: None,
                batch: 0,
                bytes,
            }),
            native_bytes: AtomicUsize::new(bytes),
            closed: AtomicBool::new(false),
        }))
    }

    /// At most `limit` entries. `may_use_os: false` gives only what needs no system call, `Ok(None)` when that is nothing.
    pub(crate) fn read(&self, limit: u32, may_use_os: bool) -> Maybe<Option<DirBatch>> {
        let mut walk = self.walk.lock();
        let result = match walk.encoding {
            Encoding::Buffer => walk.read_batch::<Buffer>(limit, may_use_os),
            _ => walk.read_batch::<Dirent>(limit, may_use_os),
        };
        self.native_bytes.store(walk.bytes, Ordering::Relaxed);
        result
    }

    /// Closes every directory of the walk.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let mut walk = self.walk.lock();
        walk.root = None;
        walk.children.clear();
        walk.pending = None;
        walk.bytes = 0;
        self.native_bytes.store(0, Ordering::Relaxed);
    }
}

impl Walk {
    fn read_batch<T: ReaddirEntry>(
        &mut self,
        limit: u32,
        may_use_os: bool,
    ) -> Maybe<Option<DirBatch>> {
        if self.root.is_none() {
            return Err(sys::Error::from_code(E::EBADF, sys::Tag::scandir));
        }
        // A recursive walk opens directories as it goes, so each of its batches is one read with the OS.
        if !may_use_os && (self.recursive || self.pending.is_some()) {
            return Ok(None);
        }
        if let Some(err) = self.pending.take() {
            return Err(err);
        }

        let limit = limit.max(1);
        self.batch = self.batch.wrapping_add(1);
        let mut out: Vec<T> = Vec::with_capacity((limit as usize).min(64));
        let mut opened: Vec<Level> = Vec::new();
        let mut needs_os = false;

        while out.len() < limit as usize {
            let from_child = match self.children.front() {
                // This batch opened it: its entry is not with the caller yet.
                Some(front) if front.born == self.batch => break,
                Some(_) => true,
                None if self.root_ended => break,
                None => false,
            };
            let level = if from_child {
                self.children.front_mut().expect("checked above")
            } else {
                self.root.as_mut().expect("checked above")
            };
            let room = limit - out.len() as u32;
            let want = if from_child {
                if level.turn_left == 0 {
                    level.turn_left = limit;
                }
                level.turn_left.min(room)
            } else {
                room
            };

            let before = out.len();
            let bytes_before = level.bytes();
            let stop = level.take::<T>(
                &mut out,
                want as usize,
                &mut TakeCx {
                    encoding: self.encoding,
                    recursive: self.recursive,
                    may_use_os,
                    batch: self.batch,
                    opened: &mut opened,
                },
            );
            self.bytes = self.bytes - bytes_before + level.bytes();
            let got = (out.len() - before) as u32;
            let failed = stop.is_err();
            // A read that failed ends its directory: the next read must not fail the same way forever.
            let ended = failed || matches!(stop, Ok(Stop::Ended));

            if from_child {
                level.turn_left -= got;
                let turn_done = level.turn_left == 0;
                if ended {
                    if let Some(level) = self.children.pop_front() {
                        self.bytes -= level.bytes();
                    }
                } else if turn_done {
                    self.children.rotate_left(1);
                }
            } else if ended {
                self.root_ended = true;
            }
            for child in opened.drain(..) {
                self.bytes += child.bytes();
                self.children.push_back(child);
            }

            match stop {
                Ok(Stop::Filled | Stop::Ended) => {}
                Ok(Stop::NeedsOs) => {
                    needs_os = true;
                    break;
                }
                Ok(Stop::ChildFailed(err)) | Err(err) => {
                    if out.is_empty() {
                        return Err(err);
                    }
                    self.pending = Some(err);
                    break;
                }
            }
        }

        let ended = self.pending.is_none() && self.root_ended && self.children.is_empty();
        if needs_os && out.is_empty() {
            return Ok(None);
        }
        Ok(Some(DirBatch {
            entries: T::into_readdir(out),
            ended,
        }))
    }
}

impl Level {
    fn bytes(&self) -> usize {
        size_of::<Self>()
            + self.path.len()
            + match &self.source {
                Source::Os { iter, .. } => iter.as_ref().map_or(0, LevelIter::bytes),
                Source::Graph { key, entries } => {
                    key.len()
                        + entries
                            .as_ref()
                            .map_or(0, |entries| size_of_val(entries.as_slice()))
                }
            }
    }

    /// Appends at most `want` entries of this directory to `out`.
    fn take<T: ReaddirEntry>(
        &mut self,
        out: &mut Vec<T>,
        want: usize,
        cx: &mut TakeCx<'_>,
    ) -> Maybe<Stop> {
        let path: &[u8] = &self.path;
        match &mut self.source {
            Source::Os { fd, iter } => {
                let iter = match iter {
                    Some(iter) => iter,
                    None if !cx.may_use_os => return Ok(Stop::NeedsOs),
                    None => iter.insert(LevelIter::new::<T>(*fd)),
                };
                match iter {
                    LevelIter::Narrow(iter) => take_narrow::<T>(iter, *fd, path, out, want, cx),
                    #[cfg(windows)]
                    LevelIter::Wide(iter) => take_wide::<T>(iter, *fd, path, out, want, cx),
                }
            }
            Source::Graph { key, entries } => take_graph::<T>(key, entries, path, out, want, cx),
        }
    }
}

impl Source {
    fn open_root(path_z: &bun_core::ZStr) -> Maybe<Source> {
        if let Some(graph) = bun_standalone_graph::Graph::get_ref() {
            if bun_standalone_graph::is_bun_standalone_file_path(path_z.as_bytes()) {
                return match graph.dir_key(path_z.as_bytes()) {
                    Ok(key) => Ok(Source::Graph {
                        key: Box::from(key),
                        entries: None,
                    }),
                    Err(errno) => Err(sys::Error::from_code(errno, sys::Tag::opendir)),
                };
            }
        }
        #[cfg(not(windows))]
        let fd = sys::open(
            path_z,
            sys::O::DIRECTORY | sys::O::RDONLY | sys::O::CLOEXEC,
            0,
        )?;
        #[cfg(windows)]
        let fd = sys::open_dir_at_windows_a(
            Fd::cwd(),
            path_z.as_bytes(),
            sys::WindowsOpenDirOptions {
                iterable: true,
                ..Default::default()
            },
        )?;
        Ok(Source::Os { fd, iter: None })
    }
}

fn open_error(err: &sys::Error, path: &[u8]) -> sys::Error {
    sys::Error {
        errno: err.errno,
        syscall: sys::Tag::opendir,
        path: Box::from(path),
        ..Default::default()
    }
}

fn read_error(err: &sys::Error, path: &[u8]) -> sys::Error {
    sys::Error {
        errno: err.errno,
        syscall: sys::Tag::scandir,
        path: Box::from(path),
        ..Default::default()
    }
}

/// ENOENT from a read of an open directory: it was removed. `readdir(3)`, and so node's `Dir`, reports the end.
fn is_removed_directory(err: &sys::Error) -> bool {
    err.get_errno() == E::ENOENT
}

/// The child directory's path, as node's `path.join(dirent.parentPath, dirent.name)` gives it.
fn child_path(parent: &[u8], name: &[u8]) -> Box<[u8]> {
    let mut spill = Vec::new();
    Box::from(resolve_path::join_spill::<platform::Auto>(
        &mut spill,
        &[parent, name],
    ))
}

fn parent_path_string(path: &[u8], encoding: Encoding) -> BunString {
    webcore::encoding::to_bun_string(
        bun_paths::string_paths::without_nt_prefix::<u8>(path),
        super::fs::encoding_to_node(encoding),
    )
}

fn take_narrow<T: ReaddirEntry>(
    iter: &mut DirIterator::WrappedIterator,
    fd: Fd,
    path: &[u8],
    out: &mut Vec<T>,
    want: usize,
    cx: &mut TakeCx<'_>,
) -> Maybe<Stop> {
    let mut parent_path = BunString::DEAD;
    for _ in 0..want {
        #[cfg(not(windows))]
        let position = iter.position();
        let next = if cx.may_use_os {
            iter.next()
        } else {
            iter.next_buffered()
        };
        let current = match next {
            Err(err) if is_removed_directory(&err) => return Ok(Stop::Ended),
            Err(err) => return Err(read_error(&err, path)),
            Ok(None) if cx.may_use_os => return Ok(Stop::Ended),
            Ok(None) => return Ok(Stop::NeedsOs),
            Ok(Some(current)) => current,
        };
        let name = current.name.slice();
        #[allow(unused_mut)]
        let mut kind = current.kind;

        // Some filesystems do not report the type. The walk needs it, and so does a Dirent.
        #[cfg(not(windows))]
        if kind == sys::FileKind::Unknown && (T::IS_DIRENT || cx.recursive) {
            if !cx.may_use_os {
                iter.rewind(position);
                return Ok(Stop::NeedsOs);
            }
            if let Ok(stat) = sys::lstatat(fd, current.name_assume_z()) {
                kind = sys::kind_from_mode(stat.st_mode as sys::Mode);
            }
        }

        if cx.recursive && kind == sys::FileKind::Directory {
            let child = child_path(path, name);
            #[cfg(not(windows))]
            let opened = sys::openat(
                fd,
                current.name_assume_z(),
                sys::O::DIRECTORY | sys::O::RDONLY | sys::O::CLOEXEC | sys::O::NOFOLLOW,
                0,
            );
            #[cfg(windows)]
            let opened = sys::open_dir_at_windows_a(fd, name, CHILD_OPEN_OPTIONS);
            match opened {
                Ok(child_fd) => cx.opened.push(Level {
                    source: Source::Os {
                        fd: child_fd,
                        iter: None,
                    },
                    path: child,
                    born: cx.batch,
                    turn_left: 0,
                }),
                Err(err) => return Ok(Stop::ChildFailed(open_error(&err, &child))),
            }
        }

        if T::IS_DIRENT && parent_path.is_empty() {
            parent_path = parent_path_string(path, cx.encoding);
        }
        T::append_entry(out, name, &parent_path, kind, cx.encoding);
    }
    Ok(Stop::Filled)
}

#[cfg(windows)]
const CHILD_OPEN_OPTIONS: sys::WindowsOpenDirOptions = sys::WindowsOpenDirOptions {
    iterable: true,
    no_follow: true,
    can_rename_or_delete: false,
    op: sys::WindowsOpenDirOp::OnlyOpen,
};

#[cfg(windows)]
fn take_wide<T: ReaddirEntry>(
    iter: &mut DirIterator::WrappedIteratorW,
    fd: Fd,
    path: &[u8],
    out: &mut Vec<T>,
    want: usize,
    cx: &mut TakeCx<'_>,
) -> Maybe<Stop> {
    let mut parent_path = BunString::DEAD;
    // The wide name as UTF-8 (what libuv gives): for an encoding other than utf8, and for a child's path.
    let mut name_buffer = bun_paths::path_buffer_pool::get();
    for _ in 0..want {
        let next = if cx.may_use_os {
            iter.next()
        } else {
            iter.next_buffered()
        };
        let current = match next {
            Err(err) if is_removed_directory(&err) => return Ok(Stop::Ended),
            Err(err) => return Err(read_error(&err, path)),
            Ok(None) if cx.may_use_os => return Ok(Stop::Ended),
            Ok(None) => return Ok(Stop::NeedsOs),
            Ok(Some(current)) => current,
        };
        let name = current.name.slice();

        if cx.recursive && current.kind == sys::FileKind::Directory {
            let child = child_path(
                path,
                bun_paths::string_paths::from_w_path(&mut name_buffer[..], name).as_bytes(),
            );
            match sys::open_dir_at_windows(fd, name, CHILD_OPEN_OPTIONS) {
                Ok(child_fd) => cx.opened.push(Level {
                    source: Source::Os {
                        fd: child_fd,
                        iter: None,
                    },
                    path: child,
                    born: cx.batch,
                    turn_left: 0,
                }),
                Err(err) => return Ok(Stop::ChildFailed(open_error(&err, &child))),
            }
        }

        if T::IS_DIRENT && parent_path.is_empty() {
            parent_path = parent_path_string(path, cx.encoding);
        }
        T::append_entry_w(
            out,
            name,
            &parent_path,
            current.kind,
            cx.encoding,
            (cx.encoding != Encoding::Utf8).then_some(&mut *name_buffer),
        );
    }
    Ok(Stop::Filled)
}

fn take_graph<T: ReaddirEntry>(
    key: &[u8],
    entries: &mut Option<std::vec::IntoIter<(Box<[u8]>, bool)>>,
    path: &[u8],
    out: &mut Vec<T>,
    want: usize,
    cx: &mut TakeCx<'_>,
) -> Maybe<Stop> {
    let entries = entries.get_or_insert_with(|| {
        bun_standalone_graph::Graph::get_ref()
            .and_then(|graph| graph.readdir(key, false))
            .unwrap_or_default()
            .into_iter()
    });
    let mut parent_path = BunString::DEAD;
    for _ in 0..want {
        let Some((name, is_dir)) = entries.next() else {
            return Ok(Stop::Ended);
        };
        let kind = if is_dir {
            sys::FileKind::Directory
        } else {
            sys::FileKind::File
        };
        if cx.recursive && is_dir {
            let mut child_key = Vec::with_capacity(key.len() + 1 + name.len());
            child_key.extend_from_slice(key);
            child_key.push(b'/');
            child_key.extend_from_slice(&name);
            cx.opened.push(Level {
                source: Source::Graph {
                    key: child_key.into_boxed_slice(),
                    entries: None,
                },
                path: child_path(path, &name),
                born: cx.batch,
                turn_left: 0,
            });
        }
        if T::IS_DIRENT && parent_path.is_empty() {
            parent_path = parent_path_string(path, cx.encoding);
        }
        T::append_entry(out, &name, &parent_path, kind, cx.encoding);
    }
    Ok(Stop::Filled)
}
