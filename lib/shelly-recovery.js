const request = require('then-request');

const DEFAULT_TIMEOUT = 250;
const DEFAULT_CONCURRENCY = 32;

function normalizeMacAddress(macAddress) {
    const normalized = String(macAddress || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    return normalized.length === 12 ? normalized : null;
}

function getHostsForSubnet(ipAddress) {
    const octets = String(ipAddress || '').split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return [];
    }

    const prefix = octets.slice(0, 3).join('.');
    return Array.from({length: 254}, (_, index) => prefix + '.' + (index + 1));
}

function requestShellyIdentity(ipAddress, requestFn, timeout) {
    return Promise.resolve(requestFn('GET', 'http://' + ipAddress + '/shelly', {timeout}))
        .then((res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return null;
            }
            const data = JSON.parse(res.getBody('utf8'));
            return normalizeMacAddress(data.mac);
        })
        .catch(() => null);
}

async function findShellyIpByMac(options) {
    const targetMacAddress = normalizeMacAddress(options.macAddress);
    const hosts = getHostsForSubnet(options.ipAddress);
    const requestFn = options.requestFn || request;
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const concurrency = Math.min(options.concurrency || DEFAULT_CONCURRENCY, hosts.length);

    if (!targetMacAddress || hosts.length === 0) {
        return null;
    }

    let nextHost = 0;
    let foundIpAddress = null;

    async function scanNextHost() {
        while (nextHost < hosts.length && foundIpAddress === null) {
            const ipAddress = hosts[nextHost++];
            const macAddress = await requestShellyIdentity(ipAddress, requestFn, timeout);
            if (macAddress === targetMacAddress) {
                foundIpAddress = ipAddress;
            }
        }
    }

    await Promise.all(Array.from({length: concurrency}, scanNextHost));
    return foundIpAddress;
}

module.exports = {
    findShellyIpByMac,
    getHostsForSubnet,
    normalizeMacAddress
};
