# Backend local and phone testing

The backend is configured to listen on `0.0.0.0`, so it is reachable from a phone on the same Wi-Fi network. The frontend automatically uses the same host that served the page and changes the port to `3001`.

## Start the backend

```bash
npm install
cp .env.local.example .env
npm run dev:lan
```

The API and Socket.IO server run on port `3001`:

```text
http://localhost:3001
http://YOUR_COMPUTER_LAN_IP:3001
```

You do not need to put the IP address in the backend code. `HOST=0.0.0.0` makes the server accept connections on Wi-Fi, Ethernet, and localhost interfaces automatically.

## Start the frontend

In the frontend directory:

```bash
npm install
cp .env.local.example .env.local
npm run dev:phone
npx cap run android -l --external
```

The frontend automatically maps:

| Frontend page | Backend API and Socket.IO |
|---|---|
| `http://localhost:5000` | `http://localhost:3001` |
| `http://192.168.1.25:5000` | `http://192.168.1.25:3001` |

The phone and computer must be on the same Wi-Fi network. Allow ports `5000` and `3001` through the computer firewall. The backend allows private LAN origins only when `NODE_ENV=development`; production deployments continue to require explicit `ALLOWED_ORIGINS` values.
