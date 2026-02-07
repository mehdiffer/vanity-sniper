import http2 from 'http2';
import WebSocket from 'ws';
import fs from 'fs';
import chalk from 'chalk';

const CONFIG = {
  serverID: 'guild_id',
  host: 'https://canary.discord.com',
  token: 'your_token',
  webhookURL: 'webhook_url',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  superProps: 'eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ=='
};

let mfaToken = '';
const servers = new Map();
const client = http2.connect(CONFIG.host);
let heartbeatInterval = null;
let isMonitoring = false;

const getTime = () => new Date().toLocaleTimeString('en-US', { hour12: false });

const log = (msg, type = 'info') => {
  const time = chalk.gray(`[${getTime()}]`);
  const symbol = {
    success: chalk.green('✓'),
    info: chalk.blue('•'),
    warn: chalk.yellow('!'),
    error: chalk.red('✗')
  }[type] || chalk.blue('•');
  console.log(`${time} ${symbol} ${msg}`);
};

const loadMfa = () => {
  try {
    mfaToken = fs.readFileSync('mfa.txt', 'utf8').trim();
    if (mfaToken) log('MFA token loaded', 'success');
  } catch {
    mfaToken = '';
  }
};

loadMfa();
fs.watch('mfa.txt', () => loadMfa());

const getHeaders = (method, path) => ({
  ':method': method,
  ':path': path,
  authorization: CONFIG.token,
  'x-discord-mfa-authorization': mfaToken,
  'user-agent': CONFIG.userAgent,
  'x-super-properties': CONFIG.superProps,
  'content-type': 'application/json'
});

const notify = (content) => {
  if (!CONFIG.webhookURL) return;
  fetch(CONFIG.webhookURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(() => {});
};

const claim = (code) => {
  log(`Claiming: ${code}`);
  const body = Buffer.from(JSON.stringify({ code }));

  if (!mfaToken) {
    log(`MFA token empty - cannot claim`, 'error');
    return;
  }

  Promise.all(Array.from({ length: 5 }, () => {
    const start = Date.now();
    const req = client.request(
      getHeaders('PATCH', `/api/v9/guilds/${CONFIG.serverID}/vanity-url`),
      { weight: 255, exclusive: true }
    );

    return new Promise(resolve => {
      req.on('response', (headers) => {
        const duration = Date.now() - start;
        if ([200, 204].includes(headers[':status'])) {
          log(`Claimed: ${code} (${duration}ms)`, 'success');
          notify(`@everyone Claimed: ${code} (${duration}ms)`);
        } else {
          log(`Failed: ${code} - Status ${headers[':status']}`, 'error');
        }
        resolve();
      });

      req.on('error', () => resolve());
      req.end(body);
    });
  })).catch(() => {});
};

const banner = () => {
  console.log('');
  console.log(chalk.cyanBright('Vanity Sniper') + chalk.gray(' • ') + chalk.greenBright('Mehdiffer'));
  console.log(chalk.gray('├─ Status: ') + chalk.greenBright('Online'));
  console.log(chalk.gray('├─ Guilds: ') + chalk.cyanBright(servers.size));
  console.log(chalk.gray('└─ Webhook: ') + chalk.greenBright('Active'));
  console.log('');
};

const connect = () => {
  const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

  ws.on('open', () => {
    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: CONFIG.token,
        intents: 1,
        properties: { os: 'linux', browser: 'chrome', device: 'mehdiffer' }
      }
    }));
  });

  ws.on('message', (data) => {
    const { t, d, op } = JSON.parse(data.toString());

    if (t === 'GUILD_UPDATE' || t === 'GUILD_DELETE') {
      const guildId = d.guild_id || d.id;
      const oldVanity = servers.get(guildId);

      if (oldVanity && (t === 'GUILD_DELETE' || d.vanity_url_code !== oldVanity)) {
        claim(oldVanity);
      }
      if (d.vanity_url_code) {
        servers.set(guildId, d.vanity_url_code);
      }
    } else if (t === 'READY') {
      d.guilds.forEach(g => g.vanity_url_code && servers.set(g.id, g.vanity_url_code));
      if (!isMonitoring) {
        banner();
        log('Gateway connected', 'success');
        log('READY - Monitoring active', 'success');
        isMonitoring = true;
      }
    }

    if (op === 10) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), d.heartbeat_interval);
    }
  });

  ws.on('close', () => {
    log('Gateway disconnected - reconnecting...');
    isMonitoring = false;
    clearInterval(heartbeatInterval);
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    log(`Error: ${err.message}`);
  });
};

setInterval(() => {
  if (!client.destroyed) {
    client.request(getHeaders('GET', '/api/v9/users/@me')).end();
  } else {
    log('Client destroyed');
    process.exit(1);
  }
}, 1900);

client.on('connect', connect);
client.on('error', (err) => {
  log(`Connection error: ${err.message}`);
});

log('Connecting to Discord...');
