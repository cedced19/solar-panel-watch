const {DatabaseSync} = require('node:sqlite');

// One energy summary per local calendar day (YYYY-MM-DD, server timezone).
// Values are the kWh fields returned by computeEnergy() (and the coverage of
// each series and the highest battery level, in percent); a day without grid
// data keeps null values so that it is not queried again.
const ENERGY_FIELDS = ['consumption_on_network', 'introduced_on_network', 'solar_panel',
    'battery_discharging', 'battery_charging', 'charging_energy_from_network', 'house_consumption',
    'devices_consumption', 'coverage_network', 'coverage_solar', 'coverage_battery', 'battery_max_soc'];
const COLUMNS = ['day', 'start_date', 'end_date', ...ENERGY_FIELDS, 'complete', 'computed_at', 'source'];

function createEnergyDayStore(filename) {
    const db = new DatabaseSync(filename);
    // Wait for another process (the converter, parallel tests) holding the file.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS energy_day (
        day TEXT PRIMARY KEY,
        start_date TEXT,
        end_date TEXT,
        consumption_on_network REAL,
        introduced_on_network REAL,
        solar_panel REAL,
        battery_discharging REAL,
        battery_charging REAL,
        charging_energy_from_network REAL,
        house_consumption REAL,
        devices_consumption REAL,
        coverage_network REAL,
        coverage_solar REAL,
        coverage_battery REAL,
        battery_max_soc REAL,
        complete INTEGER NOT NULL,
        computed_at TEXT NOT NULL,
        source TEXT NOT NULL
    )`);
    // Files created before a field existed get its column, null for the stored days.
    const existing = db.prepare('PRAGMA table_info(energy_day)').all().map(column => column.name);
    for (const field of ENERGY_FIELDS.filter(field => !existing.includes(field))) {
        db.exec(`ALTER TABLE energy_day ADD COLUMN ${field} REAL`);
    }

    const placeholders = COLUMNS.map(column => '@' + column).join(', ');
    const updates = COLUMNS.slice(1).map(column => column + ' = excluded.' + column).join(', ');
    const statements = {
        get: db.prepare('SELECT * FROM energy_day WHERE day = ?'),
        range: db.prepare('SELECT * FROM energy_day WHERE day >= ? AND day <= ? ORDER BY day'),
        all: db.prepare('SELECT * FROM energy_day ORDER BY day'),
        days: db.prepare('SELECT day, complete, consumption_on_network IS NOT NULL AS has_data FROM energy_day ORDER BY day'),
        put: db.prepare(`INSERT INTO energy_day (${COLUMNS.join(', ')}) VALUES (${placeholders})
            ON CONFLICT(day) DO UPDATE SET ${updates}`),
        insertIfAbsent: db.prepare(`INSERT INTO energy_day (${COLUMNS.join(', ')}) VALUES (${placeholders})
            ON CONFLICT(day) DO NOTHING`)
    };

    function fromRow(row) {
        if (!row) return null;
        return {...row, complete: row.complete === 1};
    }

    function toRow(day, summary, {complete, source, computedAt = new Date()}) {
        const row = {
            day,
            start_date: summary && summary.start_date ? new Date(summary.start_date).toISOString() : null,
            end_date: summary && summary.end_date ? new Date(summary.end_date).toISOString() : null,
            complete: complete ? 1 : 0,
            computed_at: new Date(computedAt).toISOString(),
            source
        };
        for (const field of ENERGY_FIELDS) {
            const value = summary ? summary[field] : null;
            row[field] = Number.isFinite(value) ? value : null;
        }
        return row;
    }

    return {
        get(day) {
            return fromRow(statements.get.get(day));
        },
        // Both bounds are inclusive; an omitted bound leaves that side open.
        range(start, end) {
            if (!start && !end) return statements.all.all().map(fromRow);
            return statements.range.all(start || '0000-00-00', end || '9999-99-99').map(fromRow);
        },
        days() {
            return statements.days.all().map(row => ({
                day: row.day, complete: row.complete === 1, has_data: row.has_data === 1
            }));
        },
        put(day, summary, options) {
            statements.put.run(toRow(day, summary, options));
            return this.get(day);
        },
        // Returns true when the day was written, false when it already existed.
        insertIfAbsent(day, summary, options) {
            return statements.insertIfAbsent.run(toRow(day, summary, options)).changes === 1;
        },
        close() {
            db.close();
        }
    };
}

module.exports = {createEnergyDayStore, ENERGY_FIELDS};
