const assert = require('node:assert/strict');
const test = require('node:test');

const {createAuth, readOptions} = require('../lib/auth');

function setup(overrides = {}) {
    let clock = 1_700_000_000_000;
    const sent = [];
    const auth = createAuth({
        ...readOptions({auth: {mails: [' Cedced19@Gmail.com '], jwt_secret: 'test-secret'}}),
        ...overrides
    }, {
        now: () => clock,
        mailer: (options, to, code) => {
            sent.push({to, code});
            return Promise.resolve();
        }
    });
    return {auth, sent, advance: (ms) => { clock += ms; }};
}

test('readOptions applies the domotic-center defaults', () => {
    assert.deepEqual(readOptions({}), {
        mails: [],
        senderUser: '',
        senderPass: '',
        smtpHost: 'smtp.gmail.com',
        smtpPort: 587,
        jwtSecret: '',
        otpTtlMinutes: 5,
        tokenValidityHours: 24 * 365
    });
});

test('only whitelisted emails receive a code, matched case-insensitively', async () => {
    const {auth, sent} = setup();
    await assert.rejects(auth.request('someone@example.com'), {code: 'not-allowed'});
    await auth.request('CEDCED19@gmail.com');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'cedced19@gmail.com');
    assert.match(sent[0].code, /^\d{6}$/);
});

test('a correct code yields a token that identifies the user, and is single use', async () => {
    const {auth, sent} = setup();
    await auth.request('cedced19@gmail.com');
    const token = auth.verify('cedced19@gmail.com', sent[0].code);
    assert.equal(auth.parse(token), 'cedced19@gmail.com');
    assert.throws(() => auth.verify('cedced19@gmail.com', sent[0].code), {code: 'invalid-code'});
});

test('codes expire and are invalidated after too many wrong attempts', async () => {
    const {auth, sent, advance} = setup();
    await auth.request('cedced19@gmail.com');
    advance(5 * 60000 + 1);
    assert.throws(() => auth.verify('cedced19@gmail.com', sent[0].code), {code: 'code-expired'});

    await auth.request('cedced19@gmail.com');
    const wrong = sent[1].code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
        assert.throws(() => auth.verify('cedced19@gmail.com', wrong), {code: 'invalid-code'});
    }
    assert.throws(() => auth.verify('cedced19@gmail.com', sent[1].code), {code: 'too-many-attempts'});
});

test('tokens are refused when tampered, expired, signed with another secret or no longer whitelisted', async () => {
    const {auth, sent, advance} = setup({tokenValidityHours: 1});
    await auth.request('cedced19@gmail.com');
    const token = auth.verify('cedced19@gmail.com', sent[0].code);

    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({sub: 'cedced19@gmail.com', exp: 9999999999})).toString('base64url');
    assert.equal(auth.parse(`${header}.${forged}.${signature}`), null);
    assert.equal(auth.parse('not-a-token'), null);

    const other = createAuth(readOptions({auth: {mails: ['cedced19@gmail.com'], jwt_secret: 'other-secret'}}));
    assert.equal(other.parse(token), null);

    auth.configure(readOptions({auth: {mails: ['someone@example.com'], jwt_secret: 'test-secret'}}));
    assert.equal(auth.parse(token), null);
    auth.configure(readOptions({auth: {mails: ['cedced19@gmail.com'], jwt_secret: 'test-secret', token_validity_hours: 1}}));
    assert.equal(auth.parse(token), 'cedced19@gmail.com');

    advance(3600 * 1000 + 1000);
    assert.equal(auth.parse(token), null);
});
