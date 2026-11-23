const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pino = require('pino');
const { router: webhookRouter } = require('./routes/webhook');
const { setupImageCleanupScheduler } = require('./utils/imageUtils');
const { setWhatsAppClient, setHealthCheck } = require('./whatsappclient');
const { restoreCredsIfCorrupt, makeAtomicSaveCreds, backupCreds } = require('./utils/authState');

process.setMaxListeners(15);
const logFilePath = path.join(__dirname, 'sc_commands.txt');

// Load environment variables
require('dotenv').config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Initialize Express server
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

// Add webhook routes
app.use('/api/webhook', webhookRouter);

// Add status endpoint (503 when not connected — point an uptime monitor here)
app.get('/api/status', (req, res) => {
	const { getWhatsAppClient } = require('./whatsappclient');
	const client = getWhatsAppClient();
	const details = {
		connected: isConnected,
		needsQrScan: !hasSession,
		downSinceSeconds: isConnected
			? 0
			: Math.round((Date.now() - disconnectedSince) / 1000),
	};
	if (client) {
		res.json({ success: true, message: 'WhatsApp client is ready.', ...details });
	} else {
		res.status(503).json({
			success: false,
			message: 'WhatsApp client is not ready.',
			...details,
		});
	}
});

const escapeHtml = (text) =>
	String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Remote re-link page. pm2 sends stdout to /dev/null, so the terminal QR is
// never visible — open /api/qr?key=<API_KEY> in a browser and scan instead.
app.get('/api/qr', async (req, res) => {
	const key = req.headers['x-api-key'] || req.query.key;
	if (!key || key !== process.env.API_KEY) {
		return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Key' });
	}

	let body;
	if (isConnected) {
		body = '<h2>WhatsApp is connected.</h2><p>Nothing to scan.</p>';
	} else if (!latestQr) {
		body = hasSession
			? '<h2>Reconnecting with saved session…</h2><p>No QR needed. This page refreshes.</p>'
			: '<h2>Generating QR…</h2><p>This page refreshes.</p>';
	} else {
		let qrHtml;
		try {
			// Lazy require — a missing package must never take the bot down
			const QRCode = require('qrcode');
			qrHtml = `<img src="${await QRCode.toDataURL(latestQr, { width: 320, margin: 2 })}" alt="WhatsApp QR">`;
		} catch {
			qrHtml = await new Promise((resolve) =>
				qrcode.generate(latestQr, { small: true }, (text) =>
					resolve(`<pre style="line-height:1;font-size:12px">${escapeHtml(text)}</pre>`)
				)
			);
		}
		body = `<h2>Scan with WhatsApp → Linked devices → Link a device</h2>${qrHtml}<p>QR rotates every ~20s. This page refreshes.</p>`;
	}

	res.set('Cache-Control', 'no-store');
	res.send(
		`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"><title>WhatsApp Link</title></head><body style="font-family:sans-serif;text-align:center;padding:24px;background:#fff;color:#111">${body}</body></html>`
	);
});

// Re-link without a camera: GET /api/pair?key=<API_KEY>&phone=<countrycode+number>
// returns an 8-char code to enter on the phone under
// Linked devices → Link a device → Link with phone number instead.
app.get('/api/pair', async (req, res) => {
	const key = req.headers['x-api-key'] || req.query.key;
	if (!key || key !== process.env.API_KEY) {
		return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API Key' });
	}
	const phone = String(req.query.phone || '').replace(/\D/g, '');
	if (!/^\d{8,15}$/.test(phone)) {
		return res.status(400).json({ success: false, message: 'phone must be digits with country code, e.g. 9779800000000' });
	}
	if (hasSession) {
		return res.status(409).json({ success: false, message: 'Already linked — no pairing needed.' });
	}
	// Socket must be up and waiting for login (a QR has been issued)
	if (!sock || !latestQr) {
		return res.status(503).json({ success: false, message: 'Not ready to pair yet. Retry in a few seconds.' });
	}
	try {
		const code = await sock.requestPairingCode(phone);
		logger.info('Pairing code issued');
		res.json({ success: true, code, message: 'Enter this code on the phone within ~2 minutes.' });
	} catch (error) {
		logger.error({ err: error }, 'Failed to get pairing code');
		res.status(500).json({ success: false, message: 'Failed to get pairing code', error: error.message });
	}
});

// Global variable to hold the socket connection
let sock = null;
let isConnected = false;
let isShuttingDown = false;
let isLoggedOut = false;
let hasSession = false;
let latestQr = null;
let consecutiveLoggedOut = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let initGeneration = 0;
let lastInitAt = 0;
let disconnectedSince = Date.now();
let lastKnownVersion = null;
let probeInFlight = null;
// Latest pending creds.json write — awaited before reloading auth from disk
let credsSaving = Promise.resolve();

const AUTH_FOLDER = path.join(__dirname, 'baileys_auth');
// Reconnect that hasn't opened or closed by then is stuck — force a fresh socket
const STUCK_RECONNECT_MS = 2 * 60 * 1000;
// Still down after this — exit so pm2 restarts the whole process
const MAX_DOWNTIME_MS = parseInt(process.env.WA_MAX_DOWNTIME_MS || '600000');
const HEALTH_PROBE_TIMEOUT_MS = 20000;

// Optional: POST to a Slack/Discord-compatible webhook when a human is needed
async function notifyAlert(text) {
	logger.error(`ALERT: ${text}`);
	if (!process.env.ALERT_WEBHOOK_URL) return;
	try {
		await fetch(process.env.ALERT_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, content: text }),
			signal: AbortSignal.timeout(10000),
		});
	} catch (error) {
		logger.error({ err: error }, 'Failed to send alert');
	}
}

// Round-trip ping to WhatsApp. A socket can look open while actually dead
// (half-open TCP, stuck stream) — on failure, end it so the normal reconnect runs.
function checkConnectionHealth() {
	if (!isConnected || !sock) return Promise.resolve(false);
	if (probeInFlight) return probeInFlight;

	const probedSock = sock;
	probeInFlight = probedSock
		.query(
			{
				tag: 'iq',
				attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' },
				content: [{ tag: 'ping', attrs: {} }],
			},
			HEALTH_PROBE_TIMEOUT_MS
		)
		.then(() => true)
		.catch((error) => {
			if (probedSock === sock) {
				logger.warn({ err: error }, 'Health probe failed. Forcing reconnect...');
				probedSock.end(new Error('Health probe failed'));
			}
			return false;
		})
		.finally(() => {
			probeInFlight = null;
		});
	return probeInFlight;
}
setHealthCheck(checkConnectionHealth);

// Single pending reconnect at a time, exponential backoff capped at 60s
function scheduleReconnect(delayMs) {
	if (isShuttingDown || reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		initializeClient();
	}, delayMs);
}

function markDisconnected() {
	if (isConnected) disconnectedSince = Date.now();
	isConnected = false;
}

// Initialize WhatsApp client with Baileys
async function initializeClient() {
	const generation = ++initGeneration;
	lastInitAt = Date.now();
	try {
		// Baileys is ESM-only — load via dynamic import from CommonJS
		const {
			default: makeWASocket,
			useMultiFileAuthState,
			BufferJSON,
			DisconnectReason,
			fetchLatestBaileysVersion,
			makeCacheableSignalKeyStore,
		} = await import('@whiskeysockets/baileys');

		// Ensure auth folder exists
		if (!fs.existsSync(AUTH_FOLDER)) {
			fs.mkdirSync(AUTH_FOLDER, { recursive: true });
		}

		// Load auth state. Finish any in-flight creds write first, and repair a
		// corrupt creds.json from backup — otherwise Baileys silently starts a
		// brand-new identity and the session is lost.
		await credsSaving;
		restoreCredsIfCorrupt(AUTH_FOLDER, logger);
		const { state } = await useMultiFileAuthState(AUTH_FOLDER);
		const atomicSave = makeAtomicSaveCreds(AUTH_FOLDER, state.creds, BufferJSON, logger);
		const saveCreds = () => (credsSaving = atomicSave());
		// `account` is only set on a completed pairing; `me` alone can be left
		// behind by an abandoned pairing-code attempt
		hasSession = Boolean(state.creds.me && state.creds.account);

		// Get latest WA web version. axios has no default timeout — a hung
		// request here would stall the reconnect forever.
		const fetched = await fetchLatestBaileysVersion({ timeout: 10000 });
		if (fetched.isLatest) lastKnownVersion = fetched.version;
		// On fetch failure prefer the last fetched version over Baileys' bundled
		// one, which can be old enough for WhatsApp to reject
		const version = lastKnownVersion || fetched.version;

		// A newer initializeClient() started while we were awaiting — let it win
		if (generation !== initGeneration) return;
		logger.info(`Using WA version ${version}, fetched latest: ${fetched.isLatest}`);

		// Close previous socket so two sockets never share one session (440 fight).
		// Clear `sock` first so its close event is ignored by the stale check below.
		const oldSock = sock;
		sock = null;
		try {
			oldSock?.end(undefined);
		} catch (error) {
			logger.warn({ err: error }, 'Error closing previous socket');
		}

		// Create socket connection
		const currentSock = makeWASocket({
			version,
			logger: pino({ level: 'silent' }), // Use silent mode for Baileys internal logging
			printQRInTerminal: false, // We'll handle QR manually
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(
					state.keys,
					pino({ level: 'silent' })
				),
			},
			generateHighQualityLinkPreview: true,
			// Browser info
			browser: ['WhatsApp Webhook', 'Chrome', '120.0.0'],
			markOnlineOnConnect: true,
		});
		sock = currentSock;

		// Handle connection updates
		sock.ev.on('connection.update', async (update) => {
			// Ignore events from a socket that has since been replaced
			if (currentSock !== sock) return;

			const { connection, lastDisconnect, qr } = update;

			// Display QR code (also served at /api/qr)
			if (qr) {
				latestQr = qr;
				qrcode.generate(qr, { small: true });
				logger.info('QR Code generated. Scan with WhatsApp or open /api/qr.');
			}

			// Handle connection status
			if (connection === 'close') {
				const statusCode = lastDisconnect?.error?.output?.statusCode;
				markDisconnected();
				latestQr = null;
				// Drop dead socket so webhook waits for reconnect instead of failing on it
				setWhatsAppClient(null);
				logger.warn(
					{ err: lastDisconnect?.error, statusCode },
					'Connection closed'
				);

				if (statusCode === DisconnectReason.loggedOut) {
					consecutiveLoggedOut++;
					if (consecutiveLoggedOut >= 2) {
						// Confirmed unlinked — creds are dead. Back them up and start
						// fresh so a new QR is immediately available at /api/qr.
						isLoggedOut = true;
						hasSession = false;
						try {
							fs.renameSync(AUTH_FOLDER, `${AUTH_FOLDER}.loggedout-${Date.now()}`);
						} catch (error) {
							logger.error({ err: error }, 'Failed to back up dead auth folder');
						}
						notifyAlert(
							'WhatsApp bot was logged out (device unlinked). Open /api/qr?key=<API_KEY> on the bot server and scan to re-link.'
						);
					} else {
						logger.warn('Got loggedOut — retrying once with saved session before resetting it.');
					}
					scheduleReconnect(5000);
				} else {
					if (statusCode === DisconnectReason.connectionReplaced) {
						logger.error(
							'Session opened elsewhere — another process is using the same baileys_auth. Stop it or sessions will keep kicking each other.'
						);
					}
					let delay = Math.min(5000 * 2 ** reconnectAttempts, 60000);
					if (statusCode === DisconnectReason.restartRequired) {
						// Normal right after QR scan; short pause lets saveCreds finish writing
						delay = 2000;
					} else if (!hasSession) {
						// Waiting for a QR scan — keep a fresh QR available
						delay = 3000;
					}
					reconnectAttempts++;
					logger.info(`Reconnecting in ${delay}ms...`);
					scheduleReconnect(delay);
				}
			} else if (connection === 'open') {
				logger.info('WhatsApp connection opened successfully!');
				isConnected = true;
				isLoggedOut = false;
				hasSession = true;
				latestQr = null;
				consecutiveLoggedOut = 0;
				reconnectAttempts = 0;
				setWhatsAppClient(sock);
				// Session proven good — snapshot it as last-known-good
				credsSaving.then(() => backupCreds(AUTH_FOLDER, logger));
			} else if (connection === 'connecting') {
				logger.info('Connecting to WhatsApp...');
				markDisconnected();
			}
		});

		// Save credentials whenever they're updated
		sock.ev.on('creds.update', saveCreds);

		// Handle incoming messages
		sock.ev.on('messages.upsert', async ({ messages, type }) => {
			try {
				if (type !== 'notify') return;

				for (const message of messages) {
					// Skip if message is from self
					if (message.key.fromMe) continue;

					const messageContent =
						message.message?.conversation ||
						message.message?.extendedTextMessage?.text ||
						'';

					logger.debug(
						`Message received from ${message.key.remoteJid}: ${messageContent}`
					);

					// Handle SchoolCode messages
					if (messageContent.startsWith('SchoolCode:')) {
						const groupId = message.key.remoteJid;
						const logEntry = `${messageContent.trim()}, ${groupId}\n`;

						const requestBody = {
							schoolCode: messageContent.split(':')[1]?.trim(),
							groupId,
						};

						const requestOptions = {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								Accept: 'application/json',
								'x-api-key': process.env.AA_WAPP_KEY,
							},
							body: JSON.stringify(requestBody),
						};

						await fetch(
							`${process.env.AA_WAPP_API}/config/whatsapp`,
							requestOptions
						);

						fs.appendFile(logFilePath, logEntry, (err) => {
							if (err) {
								logger.error(
									{ err },
									'Error writing to SchoolCode commands log file'
								);
							} else {
								logger.info(
									`Recorded SchoolCode command from group: ${groupId}`
								);
							}
						});
					}
				}
			} catch (error) {
				logger.error({ err: error }, 'Error handling message');
			}
		});

		// Handle group updates
		sock.ev.on('groups.update', (updates) => {
			for (const update of updates) {
				logger.debug(`Group updated: ${update.id}`);
			}
		});

		// Handle presence updates (optional)
		sock.ev.on('presence.update', ({ id, presences }) => {
			// You can handle presence updates here if needed
		});
	} catch (error) {
		logger.error({ err: error }, 'Error initializing WhatsApp client');
		// Stale attempt failing must not tear down a newer one
		if (generation !== initGeneration) return;
		logger.info('Retrying initialization in 10s...');
		scheduleReconnect(10000);
	}
}

// Watchdog: Baileys sometimes stalls mid-reconnect without emitting 'open' or
// 'close', leaving the client "not ready" forever. Detect and recover.
setInterval(() => {
	if (isShuttingDown) return;

	// Looks connected — verify it really is
	if (isConnected) {
		checkConnectionHealth();
		return;
	}

	// Nothing to recover automatically: waiting for a QR scan
	if (isLoggedOut || !hasSession) return;

	const downFor = Date.now() - disconnectedSince;
	if (downFor > MAX_DOWNTIME_MS) {
		isShuttingDown = true;
		try {
			sock?.end(undefined);
		} catch {}
		notifyAlert(
			`WhatsApp bot down for ${Math.round(downFor / 1000)}s. Restarting process via pm2.`
		).finally(() => process.exit(1));
		return;
	}

	if (!reconnectTimer && Date.now() - lastInitAt > STUCK_RECONNECT_MS) {
		logger.warn('Reconnect stalled. Forcing a fresh socket...');
		initializeClient();
	}
}, 30000);

// Process shutdown handling
// Close the socket only — never logout() here, that unlinks the device
// and forces a new QR scan on every pm2 restart/deploy.
function shutdown(signal) {
	logger.info(`${signal} received. Closing WhatsApp connection (session kept)...`);
	isShuttingDown = true;
	try {
		sock?.end(undefined);
	} catch (error) {
		logger.error({ err: error }, 'Error during graceful shutdown');
	}
	process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Uncaught exception handler
process.on('uncaughtException', (error) => {
	logger.error({ err: error }, 'Uncaught exception');
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
	logger.error({ err: reason }, 'Unhandled rejection');
});

// Start the Express server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
	logger.info(`Webhook server is running on port ${PORT}`);
});

// Set up image cleanup scheduler
setupImageCleanupScheduler();

// Initialize WhatsApp client
logger.info('Initializing WhatsApp client with Baileys...');
initializeClient();
