const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });

module.exports = {
    apps: [{
      name: "wbot-sender",
      script: "index.js",
      cwd: __dirname,
      // fork, not cluster: cluster reload overlaps old+new workers = two sockets on one session
      exec_mode: 'fork',
      // Never run two instances — they share baileys_auth and kick each other off
      instances: 1,
      autorestart: true,
      watch: false,
      // Restart on leaks instead of degrading until the socket dies
      max_memory_restart: '1G',
      // Back off if crash-looping instead of hammering WhatsApp with logins
      exp_backoff_restart_delay: 2000,
      // Keep logs so disconnect reasons are visible (install pm2-logrotate)
      out_file: path.join(logDir, 'out.log'),
      error_file: path.join(logDir, 'error.log'),
      // Stable file names (otherwise pm2 appends the process id)
      merge_logs: true,
      time: true
    }]
};
