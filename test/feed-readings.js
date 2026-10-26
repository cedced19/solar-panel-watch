// Feeds readings held as arrays ({power1, power2, battery}, like the fixtures of
// the energy tests) to an energy accumulator, as the day query streams them.
module.exports = function feedReadings(sink, {power1 = [], power2 = [], battery = []}) {
    for (const point of power1) sink.addNetwork(point._time, point._value);
    for (const point of power2) sink.addSolar(point._time, point._value);
    for (const row of battery) sink.addBattery(row._time, row.packInputPower, row.outputPackPower, row._value);
};
