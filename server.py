
import http.server
import json
import mimetypes
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

HF_REPO = "https://huggingface.co/datasets/sapien-sim/PartNetMobility"
METADATA_URL = HF_REPO + "/resolve/main/metadata.json"
METADATA_MAX_AGE = 6 * 3600

VIEWER_ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.environ.get("CACHE_DIR", os.path.join(VIEWER_ROOT, "cache"))
MODELS_DIR = os.path.join(CACHE_DIR, "models")
MAX_CACHED_MODELS = int(os.environ.get("MAX_CACHED_MODELS", "32"))

MODEL_ID_RE = re.compile(r"^\d+$")

DEV_HF_TOKEN_ENV = False

_global_lock = threading.Lock()
_model_locks = {}
_metadata_cache = {"data": None, "fetched_at": 0.0}

class AuthError(Exception):

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status

def hf_get(url, token):

    if not token:
        raise AuthError(401, "HuggingFace token required")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        return urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        raise auth_error_for(e)

def auth_error_for(e):
    if e.code in (401, 403):
        return AuthError(e.code, "HuggingFace refused the token; it must be a read token with access "
                                 "to the gated dataset sapien-sim/PartNetMobility (request access on "
                                 "HuggingFace first)")
    return e

def validate_token(token):

    if not token:
        raise AuthError(401, "HuggingFace token required")
    with hf_get(HF_REPO + "/resolve/main/.gitattributes", token) as r:
        r.read()

def load_metadata(token, force=False):

    with _global_lock:
        data, fetched_at = _metadata_cache["data"], _metadata_cache["fetched_at"]
    if data and not force and time.time() - fetched_at < METADATA_MAX_AGE:
        return data

    disk_path = os.path.join(CACHE_DIR, "metadata.json")
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with hf_get(METADATA_URL, token) as r:
            payload = r.read()
        data = json.loads(payload)
        with open(disk_path, "wb") as f:
            f.write(payload)
    except AuthError:
        if data:
            return data
        raise
    except Exception as e:
        if data:
            return data
        if os.path.exists(disk_path):
            with open(disk_path, "rb") as f:
                data = json.load(f)
            print("metadata fetch failed (%s); using cached copy" % e)
            with _global_lock:
                _metadata_cache["data"], _metadata_cache["fetched_at"] = data, time.time()
            return data
        raise
    with _global_lock:
        _metadata_cache["data"], _metadata_cache["fetched_at"] = data, time.time()
    return data

def model_lock(model_id):
    with _global_lock:
        return _model_locks.setdefault(model_id, threading.Lock())

def evict_cache():

    if not os.path.isdir(MODELS_DIR):
        return
    entries = []
    now = time.time()
    for name in os.listdir(MODELS_DIR):
        path = os.path.join(MODELS_DIR, name)
        if name.endswith(".tmp"):

            if now - os.path.getmtime(path) > 3600:
                shutil.rmtree(path, ignore_errors=True)
            continue
        if os.path.isdir(path):
            entries.append((os.path.getmtime(path), path))
    entries.sort()
    for _, path in entries[: max(0, len(entries) - MAX_CACHED_MODELS)]:
        shutil.rmtree(path, ignore_errors=True)

def ensure_model(model_id, token):

    dest = os.path.join(MODELS_DIR, model_id)
    if os.path.isdir(dest):
        os.utime(dest)
        return dest

    with model_lock(model_id):
        if os.path.isdir(dest):
            os.utime(dest)
            return dest
        os.makedirs(MODELS_DIR, exist_ok=True)
        tmp = dest + ".tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        zip_path = os.path.join(tmp, model_id + ".zip")
        url = HF_REPO + "/resolve/main/%s.zip" % model_id
        print("downloading model %s" % model_id)
        with hf_get(url, token) as r, open(zip_path, "wb") as f:
            shutil.copyfileobj(r, f)
        with zipfile.ZipFile(zip_path) as z:
            for member in z.namelist():

                parts = member.split("/", 1)
                rel = parts[1] if len(parts) == 2 else parts[0]
                if not rel or member.endswith("/"):
                    continue
                target = os.path.normpath(os.path.join(tmp, rel))
                if not target.startswith(tmp + os.sep):
                    raise RuntimeError("unsafe path in zip: %s" % member)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(member) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
        os.remove(zip_path)
        os.replace(tmp, dest)
        evict_cache()
        return dest

CONTENT_TYPES = {
    ".json": "application/json",
    ".obj": "text/plain",
    ".mtl": "text/plain",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".urdf": "text/plain",
}

def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args))

    def send_bytes(self, body, ctype, status=200):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        with open(path, "rb") as f:
            body = f.read()
        self.send_bytes(body, content_type(path))

    def not_found(self):
        self.send_bytes(b"not found", "text/plain; charset=utf-8", 404)

    def error(self, status, message):
        self.send_bytes(message.encode(), "text/plain; charset=utf-8", status)

    def request_token(self):

        token = (self.headers.get("X-HF-Token") or "").strip()
        if token:
            return token
        if DEV_HF_TOKEN_ENV:
            return os.environ.get("HF_TOKEN") or ""
        return ""

    def do_GET(self):
        try:
            self.handle_get()
        except BrokenPipeError:
            pass
        except Exception as e:
            print("error handling %s: %s" % (self.path, e))
            try:
                self.error(502, "internal error: %s" % e)
            except Exception:
                pass

    def handle_get(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.request.unquote(path)

        if path == "/api/metadata":
            token = self.request_token()
            try:
                validate_token(token)
                data = load_metadata(token)
            except AuthError as e:
                return self.error(e.status, str(e))
            except Exception as e:
                return self.error(502, "failed to fetch dataset metadata: %s" % e)
            body = json.dumps(data).encode()
            return self.send_bytes(body, "application/json")

        m = re.match(r"^/api/data/dataset/(\d+)/(.+)$", path)
        if m:
            model_id, rel = m.group(1), m.group(2)
            if not MODEL_ID_RE.match(model_id):
                return self.error(400, "bad model id")
            token = self.request_token()
            if not token:
                return self.error(401, "HuggingFace token required")
            try:
                base = ensure_model(model_id, token)
            except AuthError as e:
                return self.error(e.status, str(e))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return self.error(404, "no such model: %s" % model_id)
                return self.error(502, "failed to fetch model %s: %s" % (model_id, e))
            except Exception as e:
                return self.error(502, "failed to fetch model %s: %s" % (model_id, e))
            target = os.path.normpath(os.path.join(base, rel))
            if not target.startswith(base + os.sep) or not os.path.isfile(target):
                return self.not_found()
            return self.send_file(target)

        if path.startswith("/api/"):
            return self.not_found()

        rel = path.lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(VIEWER_ROOT, rel))
        if not target.startswith(VIEWER_ROOT + os.sep) or not os.path.isfile(target):
            return self.not_found()
        return self.send_file(target)

def main():
    global DEV_HF_TOKEN_ENV
    port = 4200
    for arg in sys.argv[1:]:
        if arg == "--dev-hf-token-env":
            DEV_HF_TOKEN_ENV = True
        elif arg.isdigit():
            port = int(arg)
        else:
            print("unknown argument: %s" % arg)
            sys.exit(2)
    if DEV_HF_TOKEN_ENV:

        try:
            load_metadata(os.environ.get("HF_TOKEN") or "")
            print("dataset metadata loaded")
        except Exception as e:
            print("warning: could not prefetch metadata: %s" % e)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("serving viewer on 0.0.0.0 port %d" % port)
    server.serve_forever()

if __name__ == "__main__":
    main()
