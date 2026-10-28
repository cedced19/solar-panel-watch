// Copies every reading of an InfluxDB 2.x bucket into VictoriaMetrics, a day at
// a time, as the app writes them: the field <field> of <measurement> becomes
// the metric <measurement>_<field>, the tags (home) become labels, timestamps
// are cut to the millisecond. Points that are not numbers are skipped.
//
// Running it again over the same days is harmless: VictoriaMetrics, started
// with -dedup.minScrapeInterval=1ms, keeps one sample per timestamp.
//
//   node lab/convert-influxdb-victoria/convert.js [--start 2026-01-01T00:00:00Z] [--stop ...]
//
// See README.md in this folder for the options and the whole migration.
const {createVictoriaClient, formatLine, isoTime} = require('../../lib/victoria-client');
const {queryFlux, rowTags, fluxString, readOptions, readSpan} = require('./influx');

const DAY_MS = 24 * 3600 * 1000;

async function convert(options) {
    const victoria = createVictoriaClient({url: options['victoria-url']});
    const span = await readSpan(options);
    if (!span) {
        console.log('The bucket holds no data.');
        return;
    }
    const batchSize = Number(options.batch);
    const maxRate = Number(options['max-rate']);
    const counts = new Map();
    let batch = [];
    let skipped = 0;
    let written = 0;

    // Waits after each request to stay below max-rate points per second: at a
    // few hundred thousand points per second, VictoriaMetrics' buffer of
    // pending rows outgrows a 250m container and the kernel kills it.
    async function send() {
        if (!batch.length) return;
        const lines = batch;
        batch = [];
        await victoria.write(lines);
        written += lines.length;
        const ahead = began + written / maxRate * 1000 - Date.now();
        if (ahead > 0) await new Promise(resolve => setTimeout(resolve, ahead));
    }

    console.log(`Copying ${isoTime(span.start)} to ${isoTime(span.stop)} from ${options['influx-url']} ` +
        `(bucket ${options['influx-bucket']}) to ${options['victoria-url']}.`);
    const began = Date.now();
    let reported = began;
    for (let from = span.start; from < span.stop; from += DAY_MS) {
        const to = Math.min(span.stop, from + DAY_MS);
        const query = `from(bucket: ${fluxString(options['influx-bucket'])})
            |> range(start: ${isoTime(from)}, stop: ${isoTime(to)})`;
        await queryFlux(options, query, (row) => {
            const line = formatLine(row._measurement, rowTags(row), {[row._field]: Number(row._value)}, Date.parse(row._time));
            if (!line) {
                skipped++;
                return;
            }
            const series = row._measurement + '_' + row._field;
            counts.set(series, (counts.get(series) || 0) + 1);
            batch.push(line);
            if (batch.length >= batchSize) return send();
        });
        await send();
        if (Date.now() - reported > 5000 || to === span.stop) {
            reported = Date.now();
            console.log(`  up to ${isoTime(to)}: ${written} points (${Math.round((reported - began) / 1000)} s)`);
        }
    }
    // Queries cached before the import do not know the days it added.
    await fetch(options['victoria-url'].replace(/\/+$/, '') + '/internal/resetRollupResultCache').catch(() => {});

    console.log(`\nCopied ${written} points, skipped ${skipped} that are not numbers.`);
    for (const [series, count] of [...counts].sort()) console.log(`  ${series}: ${count}`);
}

const USAGE = `Copies an InfluxDB 2.x bucket into VictoriaMetrics.

  node lab/convert-influxdb-victoria/convert.js [options]

  --start, --stop     [start, stop) to copy (default: all the data of the bucket)
  --batch             lines per write request (default 10000)
  --max-rate          points per second at most (default 50000)
  --victoria-url      default http://127.0.0.1:8428
  --influx-url, --influx-token, --influx-org, --influx-bucket
                      default: the former docker-compose.yml settings`;

if (require.main === module) {
    const options = readOptions({batch: {type: 'string', default: '10000'}, 'max-rate': {type: 'string', default: '50000'}});
    if (options.help) {
        console.log(USAGE);
    } else {
        convert(options).catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    }
}

module.exports = {convert};
