# ENCORE XO™ Shoot

Companion PWA for shooting video on your phone and beaming it into the [ENCORE XO™ editor](https://encorexo.com) via a 6-digit PIN.

Live at [shoot.encorexo.com](https://shoot.encorexo.com).

## Flow

1. In the editor at [encorexo.com](https://encorexo.com), tap **SYNC PHONE** to get a 6-digit code.
2. On the phone, visit [shoot.encorexo.com](https://shoot.encorexo.com), enter the code.
3. Shoot video. Tap **SEND TO EDITOR**. Clip flows into the editor timeline within seconds.
4. Session PIN expires after 15 minutes.

## Stack

- Vite + React 19
- Camera capture via `MediaRecorder` API
- Uploads to a Cloudflare Worker that stores in R2

## Dev

```
npm install
npm run dev
```

Point your phone at `http://<your-computer-ip>:5174` on the same LAN to test camera capture.
