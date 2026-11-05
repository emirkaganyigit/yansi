# Yansı

Mirror a Fedora desktop to a TV browser over your local network, with system audio and two-way file sharing.

Yansı runs on the PC. Open the address it displays in a compatible Mi Box, phone, or computer browser, approve the connection on the PC, and choose a screen or window to share. No TV APK, cloud account, or external signaling service is required. The desktop and viewer interfaces are currently in Turkish.

## Features

- Screen or window capture through the system screen-sharing picker on KDE Wayland.
- System output audio over the same WebRTC connection; microphone capture is not used.
- Browser receiver with fullscreen, fit controls, audio toggle, and TV remote keyboard navigation.
- Desktop approval for each session, with one approved viewer at a time.
- Download selected PC files and upload files to the PC, up to 1 GiB per file.
- Motion and text modes, 720p/1080p targets, and live sender/receiver statistics.
- A self-contained Linux x64 package with an optional per-user installer.

## Requirements

The initial target is **Fedora 44, KDE Plasma, Wayland, Linux x64**. Other desktops and distributions have not been verified.

The PC needs a working PipeWire/XDG Desktop Portal screen-sharing setup. System audio also needs `pactl` and `parec`, provided by Fedora's `pulseaudio-utils` package. If they are unavailable, Yansı reports the audio error and can continue sharing video.

The receiving browser must support WebRTC and MediaStream video playback. A browser being able to open the page does not guarantee that it can play the stream. Keep both devices on the same local network; guest Wi-Fi may prevent devices from reaching each other.

## Install

Download the Linux x64 archive from [Releases](https://github.com/emirkaganyigit/yansi/releases/latest), extract it, then run these commands from the extracted package's parent directory:

```bash
cd yansi-linux-x64
./install.sh
```

The installer does not require `sudo`. It places the app in `~/.local/opt/yansi`, adds a **Yansı** application-menu entry, and creates `~/.local/bin/yansi`. Launch it from the application menu or run:

```bash
~/.local/bin/yansi
```

If `~/.local/bin` is on your `PATH`, the `yansi` command also works. To run the extracted package without installing it, use `./Yansi.sh` instead. Node.js is included in the Electron runtime; a separate Node.js installation is not needed for the packaged app.

To update, close Yansı, extract a newer release, and run its `./install.sh`. To uninstall:

```bash
~/.local/opt/yansi/uninstall.sh
```

Uninstalling removes the app, launcher, and menu entry. It preserves the application profile and received files.

## Share your screen and audio

1. Start Yansı. The local server starts automatically and shows its address, normally `http://<PC-IP>:47831`. If that port is occupied, use the address actually shown in the app.
2. Open that address in the Mi Box or another device's browser and select **Bilgisayara bağlan** (Connect to PC).
3. Approve the request in the desktop app.
4. Select **Ekranı paylaş** (Share screen), then choose a screen or window in KDE's system picker.
5. On the TV, select **Tam ekran** (Fullscreen) and **Sesi aç** (Enable sound).
6. Select **Paylaşımı bitir** (Stop sharing) on the PC when finished.

The **Sistem sesini TV’ye aktar** (Send system audio to TV) option is enabled by default. Browser audio starts muted until the viewer explicitly enables it. The capture includes **all audio from the PC's default output**, even when sharing a single window. It does not include the microphone, and it does not mute the PC speakers. Disable the option before starting if you only want video. After changing the PC's output device, stop and restart sharing.

Sharing stops when the PC locks or sleeps. Refresh the receiver page after updating Yansı.

## Share files

Select or drag files into the desktop app's **Dosyalar** (Files) section. The approved viewer can download them or upload files to the PC. Received files are saved in the system Downloads directory under `Yansi/`; they are not opened automatically.

Only explicitly selected or session-received files are exposed to the viewer. File selection and viewer approval are session-only, so they must be repeated after restarting the app. Large simultaneous transfers can compete with the screen stream for network capacity.

## Improve motion playback

Start with **Akıcı · video ve TV** (Motion · video and TV) and **720p**. Motion mode prioritizes frame rate and may reduce the actual resolution under load. **Net metin · masaüstü** (Sharp text · desktop) prioritizes detail. Both modes target up to 30 fps; actual frame rate and resolution depend on capture, encoding, network conditions, and receiver capabilities. 4K and gaming performance have not been validated.

The local PC preview is off by default to reduce playback work. Preview, quality, and mode changes preserve the active media connection. An optional H.264 preference is available when supported locally; it retains other codecs as fallbacks, does not guarantee hardware acceleration, and reconnects the media session when changed.

**Yayın durumu** (Stream status) shows measured send/decode frame rates, actual dimensions, bitrate, encode/decode times, and network round-trip time. Unsupported or not-yet-available measurements display `—`. Network round-trip time is not total screen-to-TV latency, and a static desktop may naturally produce fewer frames.

For a more reliable link, connect the PC by Ethernet when possible. With Wi-Fi, try a strong 5 GHz connection on both devices; weak signal may need better coverage or a wired connection. Two wireless devices share airtime, so the advertised Wi-Fi link rate is not the usable streaming throughput.

## Connection and privacy notes

Yansı is an early local-network application intended for a trusted home or test network. The receiver page, signaling, and file transfers use **HTTP without TLS**. Do not expose the service through internet port forwarding. Approval tokens are revoked when the session ends; permanent device pairing and HTTPS are not implemented.

No scripts are fetched from third-party services at runtime, and Yansı does not use STUN/TURN servers or cloud accounts. The viewer cannot approve itself, start desktop capture, or browse arbitrary PC paths. The Electron renderer runs with Node integration disabled, context isolation enabled, and sandboxing enabled.

If the page does not open, check the displayed address, network isolation, and Fedora firewall configuration. The default HTTP/WebSocket port is `47831/tcp`; Yansı does not modify the firewall. If the page opens but video does not arrive, also check screen-capture permission, browser compatibility, and local WebRTC UDP connectivity. HTTP reachability alone does not confirm that the media connection can succeed. If several addresses appear, use the one belonging to the local Wi-Fi or Ethernet network rather than a VPN or virtual interface.

## Develop and test

Requires **Node.js 22.12 or newer** and npm. From the repository root:

```bash
npm ci
npm start
```

Development profiles and received files stay under `.local/development/` in the repository.

```bash
npm run check
npm test
npm run test:install
npm run test:desktop
npm run package
```

The desktop smoke test needs a graphical session. It sends a generated moving image and synthetic audio through a real WebRTC connection, checks media and file transfer behavior, and does not automatically capture the user's screen or system sound. Tests cannot establish real Mi Box performance or replace an on-device KDE/PipeWire capture check.

The installer test uses a temporary directory to verify installation, upgrade, launcher paths, conflict rejection, and uninstall behavior without modifying your installed app.

Packaging includes the Electron runtime and produces `dist/yansi-linux-x64/` plus a versioned `.tar.gz` archive. To install your build:

```bash
./dist/yansi-linux-x64/install.sh
```

### Source layout

| Directory | Purpose |
| --- | --- |
| `src/main/` | Electron lifecycle, preload bridge, screen capture, and system audio capture |
| `src/renderer/` | Desktop interface, WebRTC sender, audio worklet, and diagnostics |
| `src/server/` | Local HTTP/WebSocket service, viewer approval, and streamed file transfers |
| `src/web/` | Browser receiver for TV, phone, and PC |
| `scripts/` | Development launcher, packaging, and desktop smoke test |
| `tests/` | Server, audio pipeline, and stream-statistics tests |

## License

[MIT](LICENSE)
