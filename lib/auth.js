// Email + one-time-passcode login for the configuration panel and the force
// page, ported from domotic-center (auth/auth.go).
//
// A login works in two steps:
//  1. request(email): a 6-digit code is stored in memory for a short TTL
//     (default 5 minutes) and emailed through the configured SMTP account.
//  2. verify(email, code): on success a signed HS256 JWT is returned. It has a
//     long expiry (default 1 year) and is kept in the browser's localStorage.
//
// Only the addresses listed in config.json "auth.mails" may sign in. Unlike
// domotic-center, a token is also refused once its email leaves that list, so
// removing an address from the panel revokes its session immediately.
//
// All state lives in memory: pending codes are lost on restart, issued tokens
// stay valid as long as "auth.jwt_secret" does not change.

const crypto = require('crypto');

const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5; // failed verifications before a code is invalidated
const APP_NAME = 'Solar Panel Watch';

class AuthError extends Error {
    constructor(code) {
        super(code);
        this.code = code; // 'not-allowed', 'invalid-code', 'code-expired' or 'too-many-attempts'
    }
}

function normalize(email) {
    return String(email || '').trim().toLowerCase();
}

// Maps the "auth" section of config.json to createAuth options.
function readOptions(config) {
    const auth = config && typeof config.auth === 'object' && config.auth ? config.auth : {};
    const sender = auth.sender || {};
    const smtp = auth.smtp || {};
    return {
        mails: Array.isArray(auth.mails) ? auth.mails : [],
        senderUser: sender.user || '',
        senderPass: sender.pass || '',
        smtpHost: smtp.host || 'smtp.gmail.com',
        smtpPort: smtp.port || 587,
        jwtSecret: auth.jwt_secret || '',
        otpTtlMinutes: auth.otp_ttl_minutes > 0 ? auth.otp_ttl_minutes : 5,
        tokenValidityHours: auth.token_validity_hours > 0 ? auth.token_validity_hours : 24 * 365
    };
}

function base64url(input) {
    return Buffer.from(input).toString('base64url');
}

function randomCode() {
    return String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function smtpTransport(options) {
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
        host: options.smtpHost,
        port: options.smtpPort,
        secure: options.smtpPort === 465,
        auth: {user: options.senderUser, pass: options.senderPass}
    });
}

// Logs in to the SMTP server with the sender, without sending anything.
function smtpCheck(options) {
    return smtpTransport(options).verify();
}

// Sends the code with the sender's Gmail account.
function smtpMailer(options, to, code) {
    if (!options.senderUser) return Promise.reject(new Error('no sender configured'));
    return smtpTransport(options).sendMail({
        from: options.senderUser,
        to,
        subject: `${APP_NAME} : code de connexion`,
        html: `<p>Bonjour,</p>` +
            `<p>Votre code de connexion pour ${APP_NAME} est :</p>` +
            `<p style="font-size:26px;font-weight:bold;letter-spacing:4px">${code}</p>` +
            `<p>Ce code expire dans ${options.otpTtlMinutes} minutes. Si vous n&rsquo;avez pas demandé ce code, ignorez ce message.</p>`
    });
}

// deps.now (clock in ms), deps.mailer(options, to, code) and
// deps.checkSender(options) are stubbed in tests.
function createAuth(initialOptions, deps = {}) {
    const now = deps.now || Date.now;
    const mailer = deps.mailer || smtpMailer;
    const checkSender = deps.checkSender || smtpCheck;
    const otps = new Map();
    const fallbackSecret = crypto.randomBytes(32);
    let options;
    let allowed;
    let secret;

    // Applies new options (e.g. after the panel saved config.json) without
    // restarting. An empty jwt_secret falls back to a per-process random one.
    function configure(next) {
        options = {...readOptions({}), ...next};
        allowed = new Set(options.mails.map(normalize).filter(Boolean));
        secret = options.jwtSecret ? Buffer.from(options.jwtSecret) : fallbackSecret;
        for (const email of otps.keys()) {
            if (!allowed.has(email)) otps.delete(email);
        }
    }

    function sign(email) {
        const iat = Math.floor(now() / 1000);
        const header = base64url('{"alg":"HS256","typ":"JWT"}');
        const payload = base64url(JSON.stringify({sub: email, iat, exp: iat + options.tokenValidityHours * 3600}));
        const signature = crypto.createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
        return header + '.' + payload + '.' + signature;
    }

    // Generates and emails a code. Unknown addresses are rejected with
    // 'not-allowed'; callers should not reveal that to the client. sender
    // ({senderUser, senderPass}) replaces the configured one, for the first
    // login before any sender is saved.
    async function request(email, sender) {
        const key = normalize(email);
        if (!allowed.has(key)) throw new AuthError('not-allowed');
        const code = randomCode();
        otps.set(key, {code, expiry: now() + options.otpTtlMinutes * 60000, attempts: 0});
        await mailer({...options, ...sender}, key, code);
    }

    // Checks code for email. On success the code is consumed and a JWT returned.
    function verify(email, code) {
        const key = normalize(email);
        const entry = otps.get(key);
        if (!entry) throw new AuthError('invalid-code');
        if (now() > entry.expiry) {
            otps.delete(key);
            throw new AuthError('code-expired');
        }
        if (entry.attempts >= MAX_ATTEMPTS) {
            otps.delete(key);
            throw new AuthError('too-many-attempts');
        }
        if (entry.code !== String(code).trim()) {
            entry.attempts++;
            throw new AuthError('invalid-code');
        }
        otps.delete(key);
        return sign(key);
    }

    // Returns the email a valid, unexpired and still whitelisted token was
    // issued for, or null.
    function parse(token) {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const expected = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
        const given = Buffer.from(parts[2], 'base64url');
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        let claims;
        try {
            claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        } catch (err) {
            return null;
        }
        if (!claims || typeof claims.sub !== 'string') return null;
        if (claims.exp && Math.floor(now() / 1000) > claims.exp) return null;
        return allowed.has(claims.sub) ? claims.sub : null;
    }

    // Express middleware: answers 401 unless the request carries a valid
    // "Authorization: Bearer <token>", whose email is kept in req.authEmail.
    function requireLogin(req, res, next) {
        const header = req.get('Authorization') || '';
        const email = parse(header.startsWith('Bearer ') ? header.slice(7) : '');
        if (!email) return res.status(401).json({ok: false, error: 'not-authenticated'});
        req.authEmail = email;
        next();
    }

    configure(initialOptions);
    return {
        configure,
        request,
        verify,
        parse,
        requireLogin,
        allowed: (email) => allowed.has(normalize(email)),
        otpTtlMinutes: () => options.otpTtlMinutes,
        senderConfigured: () => Boolean(options.senderUser && options.senderPass),
        // Resolves when the SMTP server accepts sender ({senderUser, senderPass}).
        checkSender: (sender) => checkSender({...options, ...sender})
    };
}

module.exports = {createAuth, readOptions, normalize, AuthError};
