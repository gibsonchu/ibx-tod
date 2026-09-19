#!/usr/bin/env python3
"""Static dev server that never caches, so edits show up on reload."""
import http.server, os, sys

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()
    def send_header(self, k, v):
        if k.lower() == 'last-modified':
            return
        super().send_header(k, v)
    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 5178), H).serve_forever()
