const crypto = require("node:crypto");

const YOCO_CHECKOUT_URL = "https://payments.yoco.com/api/checkouts";

function createYocoCheckout({ env, payment, booking, fetchImpl = fetch }) {
  if (!env.YOCO_SECRET_KEY) throw new Error("Yoco checkout is not configured.");
  if (payment.currency !== "ZAR") throw new Error("Yoco currently supports ZAR payments only.");
  const baseUrl = new URL(env.BASE_URL || "http://localhost:3000");
  if (env.NODE_ENV === "production" && baseUrl.protocol !== "https:") {
    throw new Error("BASE_URL must use HTTPS for production payment checkout.");
  }
  const payload = {
    amount: payment.amount_cents,
    currency: payment.currency,
    successUrl: new URL("/login.html?payment=complete", baseUrl).toString(),
    cancelUrl: new URL("/login.html?payment=cancelled", baseUrl).toString(),
    failureUrl: new URL("/login.html?payment=failed", baseUrl).toString(),
    clientReferenceId: String(payment.id),
    externalId: String(booking.id),
    metadata: { bookingId: String(booking.id), paymentId: String(payment.id) },
    lineItems: [{
      displayName: `Guest house booking ${booking.id}`,
      quantity: 1,
      description: `${booking.booking_option} ${booking.checkin_date} to ${booking.checkout_date}`,
      pricingDetails: { price: payment.amount_cents }
    }]
  };
  return fetchImpl(YOCO_CHECKOUT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": payment.idempotency_key
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Yoco checkout returned HTTP ${response.status}.`);
    if (body.amount !== payment.amount_cents || body.currency !== payment.currency ||
        typeof body.id !== "string" || typeof body.redirectUrl !== "string") {
      throw new Error("Yoco returned an invalid checkout response.");
    }
    const redirect = new URL(body.redirectUrl);
    if (redirect.protocol !== "https:" || !["c.yoco.com", "checkout.yoco.com"].includes(redirect.hostname)) {
      throw new Error("Yoco returned an unexpected checkout URL.");
    }
    return { id: body.id, url: redirect.toString() };
  });
}

function verifyYocoWebhook({ secret, id, timestamp, signature, rawBody, now = Date.now() }) {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+=*$/.test(secret) ||
      typeof id !== "string" || !id || typeof timestamp !== "string" ||
      typeof signature !== "string" || !Buffer.isBuffer(rawBody)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds * 1000) > 180000) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  if (!key.length) return false;
  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    rawBody
  ]);
  const expected = crypto.createHmac("sha256", key).update(signedContent).digest();
  return signature.split(/\s+/).some((versioned) => {
    const [version, suppliedText] = versioned.split(",", 2);
    if (version !== "v1" || !suppliedText) return false;
    const supplied = Buffer.from(suppliedText, "base64");
    return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
  });
}

module.exports = { createYocoCheckout, verifyYocoWebhook };
