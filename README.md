# WhatsApp Message Sender Webhook

A WhatsApp bot that provides a webhook API for sending messages to WhatsApp groups, with support for text, images (via URL or base64), and HTML content. Built with **Baileys** - a lightweight, efficient WhatsApp Web API library.

## Features

- **Webhook API**: Send messages to WhatsApp groups via API calls
- **API Key Authentication**: Secure your webhook endpoints with API key authentication
- **Multiple Message Types**: Support for text, media (via URL or base64), and HTML content
- **HTML to Image Conversion**: Automatically converts HTML content to images
- **Automatic Cleanup**: Automatically deletes generated images after the specified retention period
- **Lightweight**: Uses Baileys library which doesn't require a full Chromium browser for WhatsApp connection
- **Batch Messaging**: Send messages to multiple groups with rate limiting

## Tech Stack

- **WhatsApp Library**: @whiskeysockets/baileys (v6.7.9)
- **HTML to Image**: Puppeteer (only for HTML conversion)
- **Backend**: Express.js
- **Authentication**: Multi-file auth state (persistent sessions)

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and configure:
   ```bash
   cp .env.example .env
   ```
4. Set a secure API key in the `.env` file
5. Start the server:
   ```bash
   node index.js
   ```
6. Scan the generated QR code with your WhatsApp to authenticate

## Migration from whatsapp-web.js

This project has been migrated from `whatsapp-web.js` to `@whiskeysockets/baileys`. Key changes:

- **No Puppeteer for WhatsApp**: Baileys doesn't require a full Chromium browser for WhatsApp connection
- **Authentication**: Changed from LocalAuth to multi-file auth state stored in `baileys_auth/` folder
- **Message Format**: Updated to use Baileys message format
- **Lighter footprint**: Significantly reduced memory and CPU usage

If you're migrating from an older version:
1. Run `npm install` to update dependencies
2. Delete the old `.wwebjs_auth/` folder (optional, but recommended for clean state)
3. Restart the application and scan the QR code again

## API Endpoints

### Health Check

```
GET /api/webhook/health
```

Returns the status of the WhatsApp client.

### Send Message

```
POST /api/webhook/send
```

Headers:
```
X-API-Key: your_api_key_here
Content-Type: application/json
```

Request Body:

```json
{
  "groupId": "1234567890-group@g.us",
  "message": "Hello from the webhook!",
  "mediaType": "url",
  "mediaContent": "https://example.com/image.jpg",
  "html": "<div style='background-color: blue; color: white; padding: 20px;'>This HTML will be converted to an image</div>"
}
```

Parameters:
- `groupId` (required): The WhatsApp group ID to send the message to
- `message` (optional): The text message to send
- `mediaType` (optional): The type of media, can be "url" or "base64"
- `mediaContent` (optional): The media content, either a URL or base64 string
- `html` (optional): HTML content to be converted to an image

At least one of `message`, `mediaContent`, or `html` must be provided.

## Examples

### Sending a Text Message

```json
{
  "groupId": "1234567890-group@g.us",
  "message": "Hello from the webhook!"
}
```

### Sending an Image from URL with Caption

```json
{
  "groupId": "1234567890-group@g.us",
  "message": "Check out this image!",
  "mediaType": "url",
  "mediaContent": "https://example.com/image.jpg"
}
```

### Sending an Image from Base64 with Caption

```json
{
  "groupId": "1234567890-group@g.us",
  "message": "Base64 encoded image",
  "mediaType": "base64",
  "mediaContent": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQE..."
}
```

### Sending HTML Content as Image

```json
{
  "groupId": "1234567890-group@g.us",
  "message": "HTML converted to image",
  "html": "<div style='background-color: blue; color: white; padding: 20px; font-family: Arial;'><h1>Hello World</h1><p>This HTML has been converted to an image.</p></div>"
}
```

## Environment Variables

- `PORT`: The port to run the webhook server on (default: 3000)
- `API_KEY`: The API key for authentication (required)
- `LOG_LEVEL`: Logging level for Pino logger (default: info)
- `IMAGE_DIR`: Directory to store converted HTML images (default: ./images)
- `IMAGE_RETENTION_DAYS`: Number of days to keep images before deletion (default: 1)
- `MAX_BATCH_SIZE`: Maximum number of messages in a batch request (default: 1000)
- `MESSAGE_DELAY_MS`: Delay between messages in batch mode (default: 5000ms)
- `WA_CONNECT_WAIT_MS`: How long a send waits for WhatsApp to reconnect (default: 30000ms)
- `WA_SEND_TIMEOUT_MS`: A single send taking longer than this counts as failed (default: 120000ms)
- `WA_MAX_DOWNTIME_MS`: Down longer than this, the process exits so pm2 restarts it (default: 600000ms)
- `ALERT_WEBHOOK_URL`: Optional Slack/Discord webhook for alerts that need a human (logout, forced restart)

## Staying Connected

The bot recovers on its own from dropped connections, dead sockets, stuck reconnects and long outages (pm2 restart). Restarts and deploys never log it out.

Only one case needs a person: WhatsApp unlinking the device (removed from the phone, or the phone offline for ~14 days). When that happens the bot backs up the old session, sends an alert and waits for a re-link:

- **QR:** open `/api/qr?key=<API_KEY>` in a browser, then on the phone go to Linked devices → Link a device and scan.
- **No camera:** open `/api/pair?key=<API_KEY>&phone=<countrycode+number>` and enter the code on the phone under Linked devices → Link a device → Link with phone number instead.

Monitor `/api/status`: it returns 503 when disconnected, and `needsQrScan: true` when a re-link is needed.

Deploy notes:
- Run a single pm2 instance only (`pm2 start pm2.config.js`). Two processes sharing `baileys_auth` kick each other off.
- Never copy `baileys_auth` between machines.
- Keep the primary phone online at least once every ~14 days.

## License

MIT
