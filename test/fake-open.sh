#!/bin/sh
# Stand-in for `open` in tests: records the URL instead of launching an editor.
echo "$1" >> "${FAKE_OPEN_LOG:-/tmp/dshdev/opened-urls.log}"
