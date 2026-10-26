'use strict';

const net = require('node:net');
const {execFile} = require('node:child_process');
const {readFile} = require('node:fs/promises');
const {promisify} = require('node:util');
const runFile = promisify(execFile);

function normalizeMacAddress(value) {
    const address = String(value || '').trim();
    if (!/^(?:[a-f\d]{12}|(?:[a-f\d]{2}:){5}[a-f\d]{2}|(?:[a-f\d]{2}-){5}[a-f\d]{2})$/i.test(address)) return null;
    return address.replace(/[:-]/g, '').toUpperCase().match(/.{2}/g).join(':');
}

function findIpInNeighbors(table, macAddress, subnetHost) {
    const expected = normalizeMacAddress(macAddress);
    if (!expected || net.isIP(subnetHost) !== 4) return null;
    const prefix = subnetHost.split('.').slice(0, 3).join('.') + '.';
    for (const line of String(table).split('\n')) {
        if (/\b(?:FAILED|INCOMPLETE)\b/i.test(line)) continue;
        const address = line.match(/\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b/i)?.[0];
        const ip = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
        if (normalizeMacAddress(address) === expected && net.isIP(ip || '') === 4 && ip.startsWith(prefix) &&
            ip !== subnetHost && !['0', '255'].includes(ip.split('.')[3])) return ip;
    }
    return null;
}

async function readNeighborTable() {
    const command = process.platform === 'linux' ? ['ip', ['-4', 'neigh', 'show']] :
        ['arp', process.platform === 'win32' ? ['-a'] : ['-an']];
    try {
        return (await runFile(command[0], command[1], {timeout: 1000, maxBuffer: 65536})).stdout;
    } catch {
        if (process.platform === 'linux') {
            try { return await readFile('/proc/net/arp', 'utf8'); } catch { /* Discovery is unavailable. */ }
        }
        return null;
    }
}

function probeTcp(host, port, timeout) {
    return new Promise(resolve => {
        const socket = net.createConnection({host, port});
        let finished = false;
        const timer = setTimeout(() => finish('ETIMEDOUT'), timeout);
        function finish(error) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.destroy();
            resolve({open: !error, error});
        }
        socket.once('connect', () => finish());
        socket.once('error', error => finish(error.code || 'CONNECTION_ERROR'));
    });
}

// Read-only discovery on the configured IPv4 /24; TCP probes populate its ARP table.
// macAddresses (or the single macAddress) are listed by priority, LAN first. A
// lower-priority match is only returned once the scan found no higher one, and one
// scan serves all of them: it fills the ARP table for every responding host.
async function findZendureIpByMac(options, dependencies = {}) {
    const macAddresses = [...new Set((options.macAddresses ?? [options.macAddress]).map(normalizeMacAddress).filter(Boolean))];
    if (net.isIP(options.host) !== 4 || !macAddresses.length) return {host: null};
    const readNeighbors = dependencies.readNeighbors || readNeighborTable;
    const connect = dependencies.probeTcp || probeTcp;
    let best = null;
    // Keeps the highest-priority match; true once the top-priority MAC is found.
    function search(table) {
        for (let rank = 0; rank < (best ? best.rank : macAddresses.length); rank++) {
            const host = findIpInNeighbors(table, macAddresses[rank], options.host);
            if (host) { best = {host, macAddress: macAddresses[rank], rank}; break; }
        }
        return best?.rank === 0;
    }
    const result = () => best ? {host: best.host, macAddress: best.macAddress} : {host: null};
    const unavailable = () => best ? result() : {host: null, unavailable: true};
    let table = await readNeighbors();
    if (table === null) return unavailable();
    if (search(table)) return result();
    const prefix = options.host.split('.').slice(0, 3).join('.');
    const hosts = Array.from({length: 254}, (_, index) => `${prefix}.${index + 1}`).filter(ip => ip !== options.host);
    const timeout = Math.min(options.timeout ?? 250, 250);
    for (let index = 0; index < hosts.length; index += 16) {
        const results = await Promise.all(hosts.slice(index, index + 16).map(ip => connect(ip, options.port || 80, timeout)));
        if (results.every(result => ['EPERM', 'EACCES'].includes(result.error))) return unavailable();
        table = await readNeighbors();
        if (table === null) return unavailable();
        if (search(table)) return result();
    }
    return result();
}

module.exports = {findZendureIpByMac, findIpInNeighbors, normalizeMacAddress};
