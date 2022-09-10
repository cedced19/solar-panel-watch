const data = require('./data-5d.json');

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



let dates = getDaysInPeriod(data[0], '_time');
let sumList = [];

function getNetworkStats(startDate,endDate,network_data) {
    let sumConsumption = 0;
    let sumIntroducted = 0;

    const dataFiltred = network_data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });

    dataFiltred.forEach(function(el) {
        if (el._value > 0) {  
            sumConsumption += el._value*(15)/(60*60*1000)
        } else {
            sumIntroducted += el._value*(15)/(60*60*1000)
        }
    });

    return [sumConsumption, sumIntroducted]
}

function getSolarPanelStats(startDate,endDate,solar_panel_data) {
    let sum = 0;

    const dataFiltred = solar_panel_data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });

    dataFiltred.forEach(function(el) { 
        sum += el._value*(15)/(60*60*1000)
    });

    return sum
}

const network_data = data[0];
const solar_panel_data = data[1];

dates.forEach(function(days) {
    const startDate = days[0];
    const endDate = days[1];
    
    const data_filtred = network_data.filter(function (el) {
        let date = new Date(el._time);
        return (date >= startDate && date <= endDate);
    });
    const startDateReal = new Date(data_filtred[0]._time);
    const endDateReal = new Date(data_filtred[data_filtred.length-1]._time);

    let [sumConsumption, sumIntroducted] = getNetworkStats(startDate,endDate,network_data);
    let sumSolarPanel = getSolarPanelStats(startDate,endDate,solar_panel_data);
    sumList.push([startDateReal, endDateReal, sumConsumption, sumIntroducted, sumSolarPanel])
});
console.log(sumList);