const GoogleStrategy = require("passport-google-oauth20").Strategy;
const FacebookStrategy = require("passport-facebook").Strategy;

function buildVerifyCallback(db, env, provider) {
  return (req, accessToken, refreshToken, profile, done) => {
    try {
      if (!profile.id) return done(new Error("OAuth provider returned no account identifier."));
      const existingIdentity = db.prepare(`
        SELECT u.id, u.name, u.email, u.phone, u.role, u.status
        FROM identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = ? AND i.provider_id = ?
      `).get(provider, profile.id);

      if (req.session?.identityLinkProvider) {
        const targetId = Number(req.session.identityLinkUserId);
        const startedAt = Number(req.session.identityLinkStartedAt);
        const target = db.prepare(`
          SELECT id, name, email, phone, role, status, staff_role
          FROM users WHERE id = ?
        `).get(targetId);
        if (req.session.identityLinkProvider !== provider ||
            !Number.isSafeInteger(targetId) ||
            !Number.isFinite(startedAt) ||
            Date.now() - startedAt > 10 * 60 * 1000) {
          return done(new Error("Identity-link request expired or provider did not match."));
        }
        if (!target || target.status !== "active") {
          return done(new Error("The account to link is unavailable."));
        }
        if (existingIdentity && existingIdentity.id !== target.id) {
          return done(new Error("This provider identity is already linked to another account."));
        }
        if (!existingIdentity) {
          const linkIdentity = db.transaction(() => {
            const result = db.prepare("INSERT INTO identities (user_id, provider, provider_id) VALUES (?, ?, ?)")
              .run(target.id, provider, profile.id);
            db.prepare(`
              INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, details)
              VALUES (?, 'identity.linked', 'identity', ?, ?)
            `).run(target.id, result.lastInsertRowid, JSON.stringify({ provider }));
          });
          linkIdentity();
        }
        return done(null, target);
      }

      if (existingIdentity) {
        if (existingIdentity.status !== "active") {
          return done(null, false, { message: "This account is disabled." });
        }
        return done(null, existingIdentity);
      }

      const email = profile.emails?.[0]?.value?.trim().toLowerCase() || null;
      const name = profile.displayName?.trim() || email || `${provider} user`;
      const adminEmails = new Set(
        (env.ADMIN_EMAILS || "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      );
      const verifiedGoogleEmail = provider === "google" && profile._json?.email_verified === true;
      const role = verifiedGoogleEmail && email && adminEmails.has(email) ? "admin" : "customer";
      const createAccount = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO users (name, email, role) VALUES (?, ?, ?)
        `).run(name.slice(0, 120), email, role);
        db.prepare(`
          INSERT INTO identities (user_id, provider, provider_id) VALUES (?, ?, ?)
        `).run(result.lastInsertRowid, provider, profile.id);
        return db.prepare(`
          SELECT id, name, email, phone, role, status, staff_role FROM users WHERE id = ?
        `).get(result.lastInsertRowid);
      });
      done(null, createAccount());
    } catch (error) {
      done(error);
    }
  };
}

function configurePassport(passport, db, env) {
  const validateProvider = (label, id, secret, callbackUrl) => {
    if (Boolean(id) !== Boolean(secret)) {
      throw new Error(`${label} OAuth requires both client ID and client secret.`);
    }
    if (!id) return false;
    if (!callbackUrl) throw new Error(`${label} OAuth callback URL is required.`);
    let parsedCallback;
    try {
      parsedCallback = new URL(callbackUrl);
    } catch {
      throw new Error(`${label} OAuth callback URL must be a valid absolute URL.`);
    }
    if (env.NODE_ENV === "production" && parsedCallback.protocol !== "https:") {
      throw new Error(`${label} OAuth callback URL must use HTTPS in production.`);
    }
    return true;
  };

  const googleConfigured = validateProvider(
    "Google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL
  );
  const facebookConfigured = validateProvider(
    "Facebook", env.FACEBOOK_APP_ID, env.FACEBOOK_APP_SECRET, env.FACEBOOK_CALLBACK_URL
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    try {
      const user = db.prepare(`
        SELECT id, name, email, phone, username, role, status, staff_role, created_at
        FROM users WHERE id = ?
      `).get(id);
      done(null, user || false);
    } catch (error) {
      done(error);
    }
  });

  if (googleConfigured) {
    passport.use("google", new GoogleStrategy({
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
      state: true,
      passReqToCallback: true
    }, buildVerifyCallback(db, env, "google")));
  }

  if (facebookConfigured) {
    passport.use("facebook", new FacebookStrategy({
      clientID: env.FACEBOOK_APP_ID,
      clientSecret: env.FACEBOOK_APP_SECRET,
      callbackURL: env.FACEBOOK_CALLBACK_URL,
      profileFields: ["id", "displayName", "emails"],
      state: true,
      passReqToCallback: true
    }, buildVerifyCallback(db, env, "facebook")));
  }
}

module.exports = { buildVerifyCallback, configurePassport };
