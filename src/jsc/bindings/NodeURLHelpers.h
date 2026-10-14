#pragma once

// URL helpers implemented in NodeURL.cpp, declared separately so
// WebCore-layer consumers (URLDecomposition.cpp, DOMURL.cpp) do not pull in
// ZigGlobalObject.h via NodeURL.h.

#include <cstdint>
#include <wtf/URL.h>

namespace JSC {
class JSGlobalObject;
class ThrowScope;
}

namespace Bun {

// True when every xn-- label in `host` is valid UTS #46 punycode.
bool hasValidPunycodeHost(WTF::StringView host);

// Why Bun::fileURLToPath() gave no path. Mirrored by `ToFileSystemPathError` in src/jsc/DOMURL.rs.
enum class FileURLToPathError : uint8_t {
    NotFileURL = 0,
    InvalidHost = 1,
    // An encoded "/", and on Windows an encoded "\".
    InvalidPath = 2,
    // The percent-decoded path is not UTF-8.
    Undecodable = 3,
};

// `%2f` or `%2F` in a path that has a "%", and on Windows `%5c` or `%5C`.
bool hasEncodedPathSeparator(WTF::StringView path);

// Node's fileURLToPath() for the host platform, in Node's order of checks. Sets `error` when the result is empty.
// https://github.com/nodejs/node/blob/v26.3.0/lib/internal/url.js#L1622-L1631
ALWAYS_INLINE WTF::Markable<WTF::String> fileURLToPath(const WTF::URL& url, FileURLToPathError& error)
{
    if (!url.protocolIsFile()) {
        error = FileURLToPathError::NotFileURL;
        return {};
    }
#if !OS(WINDOWS)
    // On Windows the host is the server of a UNC path.
    if (!url.host().isEmpty()) {
        error = FileURLToPathError::InvalidHost;
        return {};
    }
#endif
    const WTF::StringView encodedPath = url.path();
    if (encodedPath.contains('%') && hasEncodedPathSeparator(encodedPath)) {
        error = FileURLToPathError::InvalidPath;
        return {};
    }
    auto path = url.fileSystemPath();
    if (!path)
        error = FileURLToPathError::Undecodable;
    return path;
}

// What Node's fileURLToPath() throws for `Undecodable`. It has no `code`, so it is not ERR_INVALID_URI.
void throwURIMalformed(JSC::ThrowScope&, JSC::JSGlobalObject*);

// For a file: URL that Bun made from a path (a source origin, import.meta.url). It always decodes.
// A URL from the user needs `url.fileSystemPath()` and a branch for the empty result.
WTF::String fileSystemPathOfInternalURL(const WTF::URL&);

} // namespace Bun
