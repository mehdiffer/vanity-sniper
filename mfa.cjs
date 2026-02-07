const { program } = require("commander");
const chalk = require("chalk");
const ora = require("ora");
const tls = require("tls");
const http2 = require("http2");
const fs = require("fs");
const path = require("path");

const config = {
  discordHost: "canary.discord.com",
  discordToken: "your_token",
  password: "your_password"
};

if (!config.discordToken || !config.password) {
  console.log(chalk.red("Missing token or password in config."));
  process.exit(1);
}

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ravi/1.0.9164 Chrome/124.0.6367.243 Electron/30.2.0 Safari/537.36",
  "Authorization": config.discordToken,
  "Content-Type": "application/json",
  "X-Super-Properties": "eyJvcyI6IkFuZHJvaWQiLCJicm93c2VyIjoiQW5kcm9pZCBDaHJvbWUiLCJkZXZpY2UiOiJBbmRyb2lkIiwic3lzdGVtX2xvY2FsZSI6InRyLVRSIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKExpbnV4OyBBbmRyb2lkIDYuMDsgTmV4dXMgNSBCdWlsZC9NUkE1OE4pIEFwcGxlV2ViS2l0LzUzNy4zNiAoS0hUTUwsIGxpa2UgR2Vja28pIENocm9tZS8xMzEuMC4wLjAgTW9iaWxlIFNhZmFyaS81MzcuMzYiLCJicm93c2VyX3ZlcnNpb24iOiIxMzEuMC4wLjAiLCJvc192ZXJzaW9uIjoiNi4wIiwicmVmZXJyZXIiOiJodHRwczovL2Rpc2NvcmQuY29tL2NoYW5uZWxzL0BtZS8xMzAzMDQ1MDIyNjQzNTIzNjU1IiwicmVmZXJyaW5nX2RvbWFpbiI6ImRpc2NvcmQuY29tIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjM1NTYyNCwiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbCwiaGFzX2NsaWVudF9tb2RzIjpmYWxzZX0="
};

const tlsOptions = {
  rejectUnauthorized: false,
  secureContext: tls.createSecureContext({ secureProtocol: "TLSv1_2_method" }),
  ALPNProtocols: ["h2"]
};

const createSession = () => new Promise((resolve, reject) => {
  const session = http2.connect(`https://${config.discordHost}`, {
    settings: { enablePush: false },
    createConnection: () => tls.connect(443, config.discordHost, tlsOptions)
  });

  session.on("connect", () => resolve(session));
  session.on("error", reject);
});

const request = (session, method, pathname, body = null) => new Promise((resolve, reject) => {
  const reqHeaders = {
    ...headers,
    ":method": method,
    ":path": pathname,
    ":authority": config.discordHost,
    ":scheme": "https"
  };

  const stream = session.request(reqHeaders);
  const chunks = [];

  stream.on("data", chunk => chunks.push(chunk));
  stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
  stream.on("error", err => {
    stream.destroy();
    reject(err);
  });

  if (body) stream.end(body);
  else stream.end();
});

const saveToken = (token) => {
  const file = path.join(__dirname, "mfa.txt");
  fs.writeFileSync(file, token, "utf8");
  console.log(chalk.gray(`MFA token saved → ${file} (${new Date().toISOString()})`));
};

const refresh = async () => {
  const spinner = ora("Requesting MFA challenge...").start();

  let session;
  try {
    session = await createSession();

    const challenge = await request(session, "PATCH", "/api/v9/guilds/0/vanity-url");
    const parsed = JSON.parse(challenge);

    if (parsed.code === 60003 && parsed.mfa?.ticket) {
      spinner.text = "Submitting password...";

      const finish = await request(
        session,
        "POST",
        "/api/v9/mfa/finish",
        JSON.stringify({
          ticket: parsed.mfa.ticket,
          mfa_type: "password",
          data: config.password
        })
      );

      const result = JSON.parse(finish);

      if (result.token) {
        spinner.succeed(chalk.green(`Success → New MFA token: ${result.token.slice(0, 15)}...`));
        saveToken(result.token);
        return true;
      }
    }

    spinner.fail(chalk.red("Challenge failed or unexpected response"));
    return false;
  } catch (err) {
    spinner.fail(chalk.red(`Error: ${err.message}`));
    return false;
  } finally {
    if (session) session.close();
  }
};

const run = async () => {
  console.log(chalk.bold.blue("\nDiscord MFA Refresher"));
  console.log(chalk.gray("Auto-refresh every 4 minutes\n"));

  let ok = await refresh();

  if (!ok) {
    console.log(chalk.yellow("Initial refresh failed → retrying in 5s..."));
    setTimeout(run, 5000);
    return;
  }

  setInterval(async () => {
    console.log(chalk.gray(`${new Date().toLocaleTimeString()} → Refreshing`));
    await refresh();
  }, 4 * 60 * 1000);
};

program
  .name("mfa-refresher")
  .description("Discord MFA token auto refresher")
  .version("1.0.0")
  .action(run);

program.parse();
