# Yansı LAN service contract

`createLanServer(options)` is an ES module export from `src/server/index.js`.
It starts an HTTP/WebSocket receiver using Node and `ws`. It has no cloud,
STUN, TURN, or third-party resource dependencies. `port: 0` is supported for tests.

```js
const service = await createLanServer({
  port: 47831,                    // default
  bindHost: '0.0.0.0',            // default, LAN interfaces
  downloadDirectory: '/path/to/received',
  maxFileBytes: 1024 ** 3,        // default, per upload
  onEvent(event) {},
});
```

Host-only methods (Electron IPC must restrict callers to its own desktop window):

| Method | Result |
| --- | --- |
| `getState()` | `{ appName, hostName, running, port, addresses, sharing, viewers, files, downloadDirectory }` |
| `setSharing(boolean)` | New state; notifies approved receiver |
| `approveViewer(id)` | Boolean; one receiver may be approved at a time |
| `rejectViewer(id)` / `disconnectViewer(id)` | Boolean; revokes session credentials immediately |
| `broadcastHostSignal(viewerId, payload)` | Boolean; approved peer only, maximum 128 KiB |
| `listFiles()` | Public file metadata array |
| `registerSharedFile(absolutePath)` | Promise resolving to file metadata; original stays in place |
| `removeFile(id)` | Promise of boolean; removes session access, never deletes original or received files |
| `close()` | Promise; closes sockets and removes incomplete uploads |

`addresses` entries are `{ name, address, url }`. Viewers are
`{ id, name, address, status, connectedAt }`. Public files are
`{ id, name, size, mime, source, direction, createdAt }`, where `source` is
`shared` or `received` and `direction` is `download` or `upload`. Paths and
tokens are excluded from public metadata and host state. Completed uploads are
kept on disk with a UUID prefix. They are listed only in the current session.

## Events

Events are delivered to `onEvent` as one object:

- `{ type: 'state-changed', state }`
- `{ type: 'viewer-request' | 'viewer-approved' | 'viewer-rejected' | 'viewer-disconnected', viewerId, viewer }`
- `{ type: 'viewer-signal', viewerId, payload }`
- `{ type: 'file-received', viewerId, file, path }` (host-only saved path)
- `{ type: 'file-added' | 'file-removed', file }`
- `{ type: 'server-error', message }`

## Receiver WebSocket protocol

Connect to `/signal` on the same origin as the receiver page. No host control
routes are exposed. A foreign browser Origin is rejected; non-browser clients
still need explicit host approval. The server sends an initial
`{ type: 'hello', appName, hostName, pairingRequired: true, sharing }`.

1. Receiver sends `{ type: 'hello', name: 'Mi Box tarayıcı' }` within 15 seconds.
2. Server responds `{ type: 'viewer-pending', viewerId }` and prompts the host.
3. Approval sends `{ type: 'viewer-approved', viewerId, token, sharing }`, then
   `{ type: 'files-changed', files }`. Rejection sends `viewer-rejected` and closes.
4. Both sides use `{ type: 'signal', payload }`. Receiver payload types allowed:
   `offer`, `answer`, `candidate`, `renegotiate`, `ready`, `receiver-stats`.
   Descriptions and candidates carry the current `negotiationId`, for example
   `{ type: 'answer', sdp, negotiationId }` and
   `{ type: 'candidate', candidate, negotiationId }`.
   Approved receivers send `receiver-stats` at two-second intervals with the
   current `negotiationId`, measured FPS, resolution, bitrate, decode time and
   optional decoder details. Rates are `null` until an interval can be measured.
   The host ignores stale negotiation IDs. The service does not interpret SDP
   or add outside ICE services.
5. Host sharing updates send `{ type: 'sharing-changed', sharing }`. File changes
   send `{ type: 'files-changed', files }`.

Unapproved signals receive an `error` message and never reach the host. Binary
messages, payloads over 128 KiB, malformed JSON, and more than 200 messages in
10 seconds close the socket. Heartbeats clear dead connections. Token lifetime
is the approved WebSocket session; reconnects need host approval again. Revocation
also aborts active upload and download streams.

## Receiver HTTP API

Every response has `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
No CORS access is granted. Public endpoints:

- `GET /health` → `{ ok: true, appName }`
- `GET /api/status` → `{ appName, hostName, pairingRequired: true, sharing, maxFileBytes, viewerLimit: 1 }`
- Static receiver files are served from `src/web` only. `/` serves `index.html`.

Approved endpoints use `Authorization: Bearer <token>`:

- `GET /api/files` → `{ files }`
- `POST /api/uploads?name=<encoded filename>` with a raw request body → HTTP 201
  `{ file }`. Streams to a hidden temporary file, enforces actual byte count,
  atomically renames on completion, cleans up aborts, and sanitizes filenames.
- `GET /api/files/:id` → streaming attachment. Single byte ranges and `HEAD` are
  supported. For browser download links, this endpoint alone additionally accepts
  `?token=<token>`. Keep tokens out of logs and third-party URLs.

Errors use `{ error: 'Turkish human-readable message', code: 'MACHINE_CODE' }`.
Unauthorized access is HTTP 401, unknown IDs 404, oversized uploads 413. Files can
only be read by previously registered UUID IDs. Remote paths are never accepted.
HTTP is intended for a trusted local network; screen transport uses WebRTC DTLS,
but file bodies and the temporary session token travel over LAN HTTP in this
prototype. A hostile LAN requires HTTPS before using it for sensitive files.
