function buildDateFromTuple(tuple) {
    const d = new Date();
    d.setUTCHours(0);
    d.setMinutes(0);
    d.setSeconds(0);
    d.setMilliseconds(0);
    d.setDate(tuple[0]);
    d.setMonth(tuple[1]);
    d.setFullYear(tuple[2]);
    return d;
}

function buildTupleFromDate(date) {
    date = new Date(date)
    return [date.getDate(), date.getMonth(), date.getFullYear()]
}

function getDaysInPeriod(data, field) {
    let tuples = [];
    data.forEach(function(el) {
        tuple = buildTupleFromDate(el[field]);
        if (tuples.some(function(a) {
            return a[0] == tuple[0] && a[1] == tuple[1] && a[2] == tuple[2];
        }) == false) {
            tuples.push(tuple);
        }
    });
    let dates = []
    for (k in tuples) {
        day = buildDateFromTuple(tuples[k]);
        next_day = new Date(day);
        next_day.setDate(day.getDate()+1);
        dates.push([day, next_day]) 
    }
    return dates;
}

function getNetworkStats(startDate,endDate,network_data) {
    let sumConsumption = 0;
    let sumIntroducted = 0;

    const dataFiltred = network_data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });

    dataFiltred.forEach(function(el) {
        if (el._value > 0) {  
            sumConsumption += el._value*(15)
        } else {
            sumIntroducted += el._value*(15)
        }
    });

    return [sumConsumption, sumIntroducted]
}

function getSimpleStats(startDate,endDate,data) {
    let sum = 0;

    const dataFiltred = data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });

    dataFiltred.forEach(function(el) { 
        sum += el._value*(15)
    });

    return sum
}

function buildHouseData(network_data, solar_panel_data) {
    const res = JSON.parse(JSON.stringify(network_data));; 
    for (k in res) {
        res[k]._value = network_data[k]._value + solar_panel_data[k]._value
    }
    return res;
}


function compute_energy(network_data, solar_panel_data) {
    const house_data = buildHouseData(network_data, solar_panel_data);

    let dates = getDaysInPeriod(network_data, '_time');
    let sumList = [];

    dates.forEach(function(days) {
        const startDate = days[0];
        const endDate = days[1];
        
        const data_filtred = network_data.filter(function (el) {
            let date = new Date(el._time);
            return (date >= startDate && date <= endDate);
        });
        if (data_filtred.length > 0) {
            const startDateReal = new Date(data_filtred[0]._time);
            const endDateReal = new Date(data_filtred[data_filtred.length-1]._time);

            let [sumConsumption, sumIntroducted] = getNetworkStats(startDate,endDate,network_data);
            let sumSolarPanel = getSimpleStats(startDate,endDate,solar_panel_data);
            let sumHouseData = getSimpleStats(startDate,endDate,house_data);
            sumList.push({start_date: startDateReal, end_date: endDateReal, consumption_on_network: sumConsumption/(60*60*1000), introduced_on_network: sumIntroducted/(60*60*1000), solar_panel: sumSolarPanel/(60*60*1000), house_consumption: sumHouseData/(60*60*1000)})
        }
    });
    return sumList;
}

module.exports = compute_energy;

if (typeof require !== 'undefined' && require.main === module) {
    const data = require('./data-5d.json');
    const network_data = data[0];
    const solar_panel_data = data[1];
    console.log(compute_energy(network_data, solar_panel_data));
}