These two files are the browser wrapper of ffmpeg.wasm (`@ffmpeg/ffmpeg` 0.12.15, MIT licence,
https://github.com/ffmpegwasm/ffmpeg.wasm), kept on the site so its background worker loads from the same address as the page.

The converter itself (`@ffmpeg/core` 0.12.10, about 31 MB, GPL-2.0-or-later) is not stored here. Couchcast downloads it from
unpkg.com the first time someone uses "Fix the sound", and the browser keeps it for next time.
