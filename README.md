# NerdLingo
NerdLingo is an open-source project for real-time conference captions.

Status: early Vibeathon development. Live audio capture, Gemini Live translation, two operator sessions, and a temporary audience view are available. Deployment configuration is included but has not been deployed.

## Structure

- `apps/web`: Next.js web application.
- `apps/server`: Node.js backend foundation.

## Requirements

- Node.js 20.12 or later
- npm 10 or later

## Installation

```bash
npm install
```

## Commands

```bash
npm run dev:web
npm run dev:server
npm run build
npm run lint
npm run typecheck
```

The backend health check is available at `http://localhost:3001/health` by default.

Gemini Live transcription sessions have a continuous-streaming limit of approximately 10 minutes. Automatic session rollover is not implemented yet.

## Environment variables

Copy `.env.example` to a local `.env` file when needed. `PORT` controls the server port. `GEMINI_API_KEY` is read by the backend only. `NEXT_PUBLIC_BACKEND_URL` is an optional public backend origin for the web app (for example, `https://your-service.onrender.com`); it is converted to `wss://` automatically for WebSocket connections.

## Deployment configuration

`render.yaml` defines the backend web service from the repository root, with `/health` as its health check. In Vercel, import this monorepo with `apps/web` as the project Root Directory and configure `NEXT_PUBLIC_BACKEND_URL` to the deployed Render HTTPS origin before building the frontend. Set `GEMINI_API_KEY` only in Render's server-side environment.

## License

MIT License
