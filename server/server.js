require("dotenv").config();
const { createApp } = require("./app");
const { flushEmailOutbox } = require("./email");

const app = createApp();
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const server = app.listen(port, () => {
  console.log(`Ngqamakwe API listening on port ${port}`);
});

const emailPoller = setInterval(() => {
  if (!app.locals.mailer) return;
  flushEmailOutbox(app.locals.db, app.locals.mailer).catch((error) => {
    console.error("Email outbox poll failed:", error);
  });
}, 60_000);
emailPoller.unref();

function shutdown() {
  clearInterval(emailPoller);
  server.close(() => {
    app.locals.db.close();
    app.locals.mailer?.close();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
