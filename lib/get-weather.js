const config = require('../config.json');
const request = require('then-request');

// Get historical weather data for a date range
function getHistoricalWeather(startDate, endDate, cb) {
    if (!config.latitude || !config.longitude) {
        return cb(new Error('Weather location configuration missing'));
    }
    
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${config.latitude}&longitude=${config.longitude}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,sunshine_duration&timezone=${config.timezone || 'auto'}`;
    
    request('GET', url).done(function (res) {
        try {
            const data = JSON.parse(res.getBody('utf8'));
            
            if (!data.daily || !data.daily.time) {
                return cb(null, []);
            }
            
            // Transform Open-Meteo format to our format
            const historicalData = [];
            for (let i = 0; i < data.daily.time.length; i++) {
                const sunshineDurationSeconds = data.daily.sunshine_duration[i] || 0;
                historicalData.push({
                    date: new Date(data.daily.time[i]),
                    max_temp: data.daily.temperature_2m_max[i] || 0,
                    min_temp: data.daily.temperature_2m_min[i] || 0,
                    sunshine_duration: sunshineDurationSeconds / 3600, // Convert to hours
                    sunshine_duration_seconds: sunshineDurationSeconds
                });
            }
            
            cb(null, historicalData);
        } catch (err) {
            cb(err);
        }
    });
}

module.exports = { 
    getHistoricalWeather: getHistoricalWeather
};
