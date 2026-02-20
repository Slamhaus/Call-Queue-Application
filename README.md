# SignalWire Call Queue

A browser-based call queue application using SignalWire's SWML. Callers dial in, choose Sales or Support via IVR, and wait in a queue. Agents see queued calls in real-time and can connect with one click.

## Features

- IVR routing (Press 1 for Sales, Press 2 for Support)
- Real-time queue display with caller info and wait times
- Multi-agent support with status indicators
- Audio notification when calls enter the queue
- Visual feedback during call connection (Connecting... → Hang Up)
- SWML Webhooks served dynamically from your server (URLs auto-update when ngrok changes)

## Prerequisites

- Node.js
- ngrok (for local development)
- SignalWire account with a phone number

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Start ngrok in another terminal:
   ```bash
   ngrok http 3000
   ```

4. Open http://localhost:3000 in your browser

5. Enter your SignalWire credentials and ngrok URL, then click Connect

6. In the SignalWire dashboard, assign the `queue-inbound-ivr` resource to your phone number

## Usage

1. **Call your SignalWire number** - You'll hear the IVR
2. **Press 1 or 2** - Routes to Sales or Support queue
3. **Watch the queue** - Caller appears in the agent UI
4. **Click "Dial Queue"** - Connects you to the waiting caller
5. **Click "Hang Up"** - Ends the call

## Project Structure

```
Queue/
├── server.js          # Express + WebSocket server, SWML endpoints
├── public/
│   └── index.html     # Agent web UI
└── package.json
```

## Server Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /swml/ivr` | Returns IVR SWML for inbound calls |
| `POST /swml/agent-connector` | Returns SWML for agent queue connection |
| `POST /swml/hangup` | Returns hangup SWML |
| `POST /webhook/queue-status` | Receives queue events from SignalWire |
| `GET /health` | Health check |
| `GET /debug/state` | View current queue and agent state |

## Changing ngrok URL

When your ngrok URL changes, just reconnect in the browser. The app automatically updates the webhook URLs in SignalWire.
