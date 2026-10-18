#!/usr/bin/env python3
"""Narrow Botkeep Developer API client for the approved Dshoof workload.

The credential is read only from BOTKEEP_API_KEY. No redirects or automatic
write retries are permitted. Keep one Idempotency-Key for each logical write;
a timeout means its remote outcome must be inspected before any retry.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import ssl
import sys
import time
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import (HTTPRedirectHandler, HTTPSHandler, ProxyHandler,
                            Request, build_opener)
import uuid

WORKLOAD_ID = "83275da8-1731-45e5-a55e-91e3a564cf88"
ORIGIN = "https://api.botkeep.cloud"
PREFIX = "/api/v1/developer"
MAX_UPLOAD_BASE64 = 5_333_336
MAX_RESPONSE = 32 * 1024 * 1024
REPOSITORY = Path(__file__).resolve().parents[2]
_KEY = re.compile(r"[A-Za-z0-9_-]{16,64}\Z")
_OPERATION = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")


class ClientError(Exception):
    """Messages deliberately exclude response bodies, credentials and headers."""


class GuardError(ClientError):
    pass


class APIError(ClientError):
    def __init__(self, message, *, status=None):
        super().__init__(message)
        self.status = status


class UncertainWriteError(APIError):
    def __init__(self, *, idempotency_key, status=None, operation_id=None):
        super().__init__(
            "Write outcome is uncertain. Inspect remote state before retrying; "
            "retain the original Idempotency-Key.", status=status)
        self.idempotency_key = idempotency_key
        self.operation_id = operation_id


class OperationError(APIError):
    def __init__(self, message, *, operation_id, state=None):
        super().__init__(message)
        self.operation_id = operation_id
        self.state = state


class RedirectRefused(APIError):
    pass


@dataclass(frozen=True)
class APIResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise APIError("API response was not valid JSON.",
                           status=self.status) from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def remote_path(value, *, write=False, allow_root=False):
    if not isinstance(value, str) or not value or len(value) > 500:
        raise GuardError("Invalid remote file path.")
    if any(ord(c) < 32 or ord(c) == 127 for c in value) or "\\" in value or "%" in value:
        raise GuardError("Remote file path is not canonical.")
    if value == "/" and allow_root:
        return value
    parts = value.lstrip("/").split("/")
    if value.startswith("//") or any(p in ("", ".", "..") for p in parts):
        raise GuardError("Remote file path is not canonical.")
    if write and any(p.lower() in ("data", "node_modules") or
                     p.lower() == ".env" or p.lower().startswith(".env.") or
                     p.lower().startswith(".dshoof") for p in parts):
        raise GuardError("Persistent data, credentials and installed runtime paths are protected.")
    return value


def _idempotency(value):
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise GuardError("A stable 16–64 character Idempotency-Key is required.")
    return value


def _operation_timeout(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 900:
        raise GuardError("Operation timeout must be between zero and 900 seconds.")
    return value


def _retry_after(headers, *, default=1.0, maximum=30.0):
    value = headers.get("retry-after", "")
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            seconds = default
    if not 0 <= seconds < float("inf"):
        seconds = default
    return min(maximum, max(0.0, seconds))


class BotkeepClient:
    def __init__(self, *, workload_id=WORKLOAD_ID, environ=None, opener=None,
                 timeout=20.0, read_retries=2, sleep=time.sleep,
                 clock=time.monotonic):
        if workload_id != WORKLOAD_ID:
            raise GuardError("This client is limited to the approved workload.")
        environment = os.environ if environ is None else environ
        key = environment.get("BOTKEEP_API_KEY", "")
        if not isinstance(key, str) or not key or any(not 33 <= ord(c) <= 126 for c in key):
            raise GuardError("BOTKEEP_API_KEY must be supplied securely in the environment.")
        if not 0 < timeout <= 60 or not isinstance(read_retries, int) or not 0 <= read_retries <= 3:
            raise GuardError("Invalid bounded request/retry settings.")
        self._key = key
        # ProxyHandler honors HTTPS_PROXY/NO_PROXY; system TLS validation stays on.
        self._opener = opener or build_opener(
            ProxyHandler(), HTTPSHandler(context=ssl.create_default_context()),
            _NoRedirect())
        self._timeout, self._read_retries = float(timeout), read_retries
        self._sleep, self._clock = sleep, clock
        self._operations = {}
        self._write_identities = {}
        self._workload = PREFIX + "/workloads/" + WORKLOAD_ID

    def _guard(self, method, path):
        reads = {"", "/files", "/file", "/files/download", "/logs",
                 "/backups", "/github", "/startup-check"}
        writes = {("POST", "/actions"), ("POST", "/files/upload-batch"),
                  ("PUT", "/file"), ("POST", "/backups")}
        if path.startswith(self._workload):
            suffix = path[len(self._workload):]
            if method == "GET" and suffix in reads or (method, suffix) in writes:
                return
        operation_prefix = PREFIX + "/operations/"
        operation = path.removeprefix(operation_prefix)
        if method == "GET" and path.startswith(operation_prefix) and operation in self._operations:
            return
        raise GuardError("Endpoint or method is outside the approved operations.")

    def _request(self, method, path, *, query=None, payload=None,
                 idempotency_key=None, max_bytes=MAX_RESPONSE, deadline=None):
        self._guard(method, path)
        self._guard_parameters(method, path, query, payload)
        is_write = method != "GET"
        if is_write:
            _idempotency(idempotency_key)
        headers = {"Authorization": "Bearer " + self._key,
                   "Accept": "application/json", "User-Agent": "Dshoof-Botkeep-Client/1.0"}
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False,
                              separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if is_write:
            headers["Idempotency-Key"] = idempotency_key
            identity = hashlib.sha256(method.encode() + b"\0" + path.encode() + b"\0" + (body or b"")).digest()
            if idempotency_key in self._write_identities and self._write_identities[idempotency_key] != identity:
                raise GuardError("This Idempotency-Key is already bound to a different logical write.")
            self._write_identities[idempotency_key] = identity
        url = ORIGIN + path + ("?" + urlencode(query) if query else "")
        attempts = 1 if is_write else self._read_retries + 1
        for attempt in range(attempts):
            remaining = deadline - self._clock() if deadline is not None else self._timeout
            if remaining <= 0:
                raise APIError("Read deadline expired.")
            request = Request(url, data=body, headers=headers, method=method)
            try:
                try:
                    response = self._opener.open(request, timeout=min(self._timeout, remaining))
                except HTTPError as error:
                    response = error
                with response:
                    status = response.status if hasattr(response, "status") else response.code
                    response_headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
                    data = response.read(max_bytes + 1)
                if len(data) > max_bytes:
                    if is_write:
                        raise UncertainWriteError(idempotency_key=idempotency_key, status=status)
                    raise APIError("API response exceeded the bounded size limit.", status=status)
            except (TimeoutError, URLError, OSError, HTTPException):
                if is_write:
                    raise UncertainWriteError(idempotency_key=idempotency_key) from None
                if attempt + 1 == attempts:
                    raise APIError("Read request failed or timed out.") from None
                self._wait(min(2 ** attempt, 4), deadline)
                continue
            if 300 <= status < 400:
                raise RedirectRefused("API redirect refused; credentials were not forwarded.", status=status)
            if 200 <= status < 300:
                return APIResponse(status, response_headers, data)
            if not is_write and status in (429, 500, 502, 503, 504) and attempt + 1 < attempts:
                self._wait(_retry_after(response_headers, default=2 ** attempt), deadline)
                continue
            if is_write and status >= 500:
                raise UncertainWriteError(idempotency_key=idempotency_key, status=status)
            raise APIError("Botkeep API rejected the request (HTTP " + str(status) + ").", status=status)
        raise APIError("Read retry limit reached.")

    def _guard_parameters(self, method, path, query, payload):
        """Keep the low-level request path inside the same scope as helpers."""
        suffix = path[len(self._workload):] if path.startswith(self._workload) else ""
        if method == "GET":
            names = {"/files": {"directory"}, "/file": {"path"},
                     "/files/download": {"path"}, "/logs": {"lines"}}.get(suffix, set())
            if payload is not None or query is not None and (not isinstance(query, dict) or not set(query) <= names):
                raise GuardError("Unexpected parameters for this read endpoint.")
            if query and "path" in query:
                remote_path(query["path"])
            if query and "directory" in query:
                remote_path(query["directory"], allow_root=True)
            if query and "lines" in query:
                lines = query["lines"]
                if not isinstance(lines, int) or isinstance(lines, bool) or not 1 <= lines <= 200:
                    raise GuardError("Log line count must be between 1 and 200.")
            return
        if query or not isinstance(payload, dict):
            raise GuardError("Unexpected write parameters.")
        if suffix == "/actions":
            if set(payload) != {"action"} or payload["action"] not in ("start", "stop", "restart"):
                raise GuardError("Only start, stop and restart are authorized.")
        elif suffix == "/file":
            if not {"path", "type"} <= set(payload) or not set(payload) <= {"path", "type", "content", "revision", "createOnly"}:
                raise GuardError("Unexpected file write fields.")
            remote_path(payload["path"], write=True)
            if payload["type"] != "file" or not isinstance(payload.get("content", ""), str) or len(payload.get("content", "")) > 500_000 or not isinstance(payload.get("createOnly", False), bool):
                raise GuardError("Invalid guarded file write.")
            if payload.get("revision") is not None and (not isinstance(payload["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", payload["revision"])):
                raise GuardError("A file revision must be its lowercase SHA-256 digest.")
        elif suffix == "/files/upload-batch":
            files = payload.get("files")
            if set(payload) != {"files"} or not isinstance(files, list) or not 1 <= len(files) <= 4:
                raise GuardError("An upload batch must contain between one and four files.")
            paths = set()
            for item in files:
                if not isinstance(item, dict) or set(item) != {"path", "data", "overwrite"}:
                    raise GuardError("Unexpected upload fields.")
                path = remote_path(item["path"], write=True)
                canonical = path.lstrip("/")
                if canonical in paths:
                    raise GuardError("Duplicate remote path in upload batch.")
                paths.add(canonical)
                if not isinstance(item["data"], str) or len(item["data"]) > MAX_UPLOAD_BASE64 or not isinstance(item["overwrite"], bool):
                    raise GuardError("Invalid upload data or overwrite flag.")
                try:
                    base64.b64decode(item["data"], validate=True)
                except (ValueError, TypeError):
                    raise GuardError("Upload data must be valid base64.") from None
        elif suffix == "/backups":
            name = payload.get("name")
            if not {"name"} <= set(payload) or not set(payload) <= {"name", "requestId"} or not isinstance(name, str) or not 2 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
                raise GuardError("Invalid backup creation fields.")
            if payload.get("requestId") is not None:
                try:
                    uuid.UUID(payload["requestId"])
                except (ValueError, TypeError, AttributeError):
                    raise GuardError("Backup requestId must be a UUID.") from None

    def _wait(self, seconds, deadline=None):
        if deadline is not None:
            seconds = min(seconds, max(0.0, deadline - self._clock()))
        self._sleep(seconds)

    def inspect(self):
        return self._request("GET", self._workload)

    def list_files(self, directory="/"):
        return self._request("GET", self._workload + "/files",
                             query={"directory": remote_path(directory, allow_root=True)})

    def read_file(self, path):
        return self._request("GET", self._workload + "/file",
                             query={"path": remote_path(path)})

    def download_file(self, path):
        return self._request("GET", self._workload + "/files/download",
                             query={"path": remote_path(path)}, max_bytes=128 * 1024 * 1024)

    def logs(self, lines=100):
        if not isinstance(lines, int) or isinstance(lines, bool) or not 1 <= lines <= 200:
            raise GuardError("Log line count must be between 1 and 200.")
        return self._request("GET", self._workload + "/logs", query={"lines": lines})

    def backups(self):
        return self._request("GET", self._workload + "/backups")

    def github(self):
        return self._request("GET", self._workload + "/github")

    def startup_check(self):
        return self._request("GET", self._workload + "/startup-check")

    def _complete(self, response, idempotency_key, wait_timeout):
        if response.status != 202:
            return response
        try:
            operation = response.json()["operation"]
            operation_id = operation["id"]
            if not isinstance(operation_id, str) or not _OPERATION.fullmatch(operation_id):
                raise ValueError()
            self._check_workload(operation)
        except (KeyError, TypeError, ValueError, APIError, GuardError):
            raise UncertainWriteError(idempotency_key=idempotency_key,
                                      status=202) from None
        self._operations[operation_id] = idempotency_key
        return self.wait_operation(operation_id, timeout=wait_timeout)

    @staticmethod
    def _check_workload(operation):
        for name in ("workload_id", "workloadId", "service_id", "serviceId"):
            if name in operation and operation[name] != WORKLOAD_ID:
                raise GuardError("Operation belongs to a different workload.")
        if isinstance(operation.get("workload"), dict) and operation["workload"].get("id") != WORKLOAD_ID:
            raise GuardError("Operation belongs to a different workload.")

    def wait_operation(self, operation_id, *, timeout=180):
        if operation_id not in self._operations:
            raise GuardError("Only operations accepted for this approved workload may be polled.")
        _operation_timeout(timeout)
        deadline = self._clock() + timeout
        while self._clock() < deadline:
            try:
                response = self._request("GET", PREFIX + "/operations/" + operation_id, deadline=deadline)
            except APIError as error:
                raise UncertainWriteError(idempotency_key=self._operations[operation_id], status=error.status, operation_id=operation_id) from None
            data = response.json()
            operation = data.get("operation", data) if isinstance(data, dict) else None
            if not isinstance(operation, dict) or operation.get("id", operation_id) != operation_id:
                raise OperationError("Unexpected operation response; completion is unverified.", operation_id=operation_id)
            self._check_workload(operation)
            state = str(operation.get("status", operation.get("state", ""))).lower().replace("-", "_")
            failed_result = isinstance(operation.get("result"), dict) and operation["result"].get("success") is False
            if state in ("failed", "error", "cancelled", "canceled", "rejected", "timed_out") or operation.get("success") is False or failed_result or operation.get("error"):
                raise OperationError("Remote operation failed; inspect its private response.", operation_id=operation_id, state=state)
            if state in ("succeeded", "success", "completed", "done"):
                return response
            if state not in ("queued", "pending", "running", "in_progress", "processing", "accepted", "scheduled", "started", "waiting"):
                raise OperationError("Unknown operation state; completion is unverified.", operation_id=operation_id, state=state)
            self._wait(max(0.1, _retry_after(response.headers, maximum=10)), deadline)
        raise UncertainWriteError(idempotency_key=self._operations[operation_id], operation_id=operation_id)

    def action(self, action, *, idempotency_key, wait_timeout=180):
        _operation_timeout(wait_timeout)
        if action not in ("start", "stop", "restart"):
            raise GuardError("Only start, stop and restart are authorized.")
        response = self._request("POST", self._workload + "/actions",
                                 payload={"action": action}, idempotency_key=idempotency_key)
        return self._complete(response, idempotency_key, wait_timeout)

    def create_backup(self, name, *, idempotency_key, request_id=None, wait_timeout=300):
        _operation_timeout(wait_timeout)
        if not isinstance(name, str) or not 2 <= len(name) <= 80 or any(ord(c) < 32 for c in name):
            raise GuardError("Backup name must contain between 2 and 80 printable characters.")
        payload = {"name": name}
        if request_id is not None:
            try:
                payload["requestId"] = str(uuid.UUID(request_id))
            except (ValueError, AttributeError, TypeError):
                raise GuardError("Backup requestId must be a UUID.") from None
        response = self._request("POST", self._workload + "/backups", payload=payload,
                                 idempotency_key=idempotency_key)
        return self._complete(response, idempotency_key, wait_timeout)

    def write_file(self, path, content, *, idempotency_key, revision=None,
                   create_only=False, wait_timeout=180):
        _operation_timeout(wait_timeout)
        path = remote_path(path, write=True)
        if not isinstance(content, str) or len(content) > 500_000:
            raise GuardError("Text files must contain at most 500000 characters.")
        if revision is not None and (not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision)):
            raise GuardError("A file revision must be its lowercase SHA-256 digest.")
        if not isinstance(create_only, bool):
            raise GuardError("create_only must be boolean.")
        payload = {"path": path, "type": "file", "content": content, "createOnly": create_only}
        if revision is not None:
            payload["revision"] = revision
        response = self._request("PUT", self._workload + "/file", payload=payload,
                                 idempotency_key=idempotency_key)
        return self._complete(response, idempotency_key, wait_timeout)

    def upload_batch(self, files, *, idempotency_key, overwrite=False, wait_timeout=180):
        _operation_timeout(wait_timeout)
        if not isinstance(files, Mapping) or not 1 <= len(files) <= 4:
            raise GuardError("An upload batch must contain between one and four files.")
        if not isinstance(overwrite, bool):
            raise GuardError("overwrite must be boolean.")
        uploads = []
        for path, content in files.items():
            path = remote_path(path, write=True)
            if not isinstance(content, bytes):
                raise GuardError("Upload content must be bytes.")
            encoded = base64.b64encode(content).decode("ascii")
            if len(encoded) > MAX_UPLOAD_BASE64:
                raise GuardError("A file exceeds Botkeep's base64 upload limit.")
            uploads.append({"path": path, "data": encoded, "overwrite": overwrite})
        response = self._request("POST", self._workload + "/files/upload-batch",
                                 payload={"files": uploads}, idempotency_key=idempotency_key)
        return self._complete(response, idempotency_key, wait_timeout)

    def save_private_response(self, response, destination):
        target = Path(destination).expanduser().resolve()
        if target == REPOSITORY or REPOSITORY in target.parents:
            raise GuardError("Private responses must be saved outside the repository.")
        if self._key.encode("utf-8") in response.body:
            raise GuardError("Response unexpectedly contained the API credential; saving was refused.")
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(target, flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                descriptor = None
                output.write(response.body)
                output.flush()
                os.fsync(output.fileno())
        finally:
            if descriptor is not None:
                os.close(descriptor)
        return {"bytes": len(response.body), "sha256": hashlib.sha256(response.body).hexdigest()}


def metadata(value):
    """Small stdout whitelist; file contents, logs and arbitrary errors stay private."""
    allowed = {"id", "workload_id", "workloadId", "name", "status", "state",
               "action", "type", "size", "path", "revision", "success"}
    wrappers = {"workload", "operation", "files", "data", "items"}
    if isinstance(value, list):
        return [metadata(item) for item in value[:200] if isinstance(item, dict)]
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        if key in allowed and isinstance(item, (str, int, float, bool, type(None))):
            result[key] = item[:200] if isinstance(item, str) else item
        elif key in wrappers and isinstance(item, (dict, list)):
            result[key] = metadata(item)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "files", "read"))
    parser.add_argument("--path", default="/")
    parser.add_argument("--output", help="New private response file outside the repository; required for read")
    args = parser.parse_args()
    if args.command == "read" and not args.output:
        parser.error("read requires --output outside the repository")
    try:
        client = BotkeepClient()
        response = (client.inspect() if args.command == "inspect" else
                    client.list_files(args.path) if args.command == "files" else
                    client.read_file(args.path))
        result = client.save_private_response(response, args.output) if args.output else metadata(response.json())
        print(json.dumps(result, ensure_ascii=False).replace(client._key, "[redacted]"))
        return 0
    except (ClientError, OSError):
        # No raw transport exceptions, response bodies, credentials or headers.
        print("Botkeep request did not complete; inspect the guarded client error in a private session.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
