
# Create energy-graph.ejs

Like energy-request-hist.ejs but represent it as an unified bar plot

From the URL /energy-hist/ get the data `jsonData`.
Logic to unify the data from each calculation:
```javascript
    
    const flattened = [];
    for (const el of jsonData) {
        flattened.push(...el.result);
    }
    // Add formatted date to each element
    for (const el of flattened) {
        const dateObj = new Date(el.start_date);
        const day = String(dateObj.getDate()).padStart(2, '0');
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const year = String(dateObj.getFullYear()).slice(-2);
        el.date = `${day}-${month}-${year}`;
    }

    // Group by date and find max consumption_on_network
    const filtered = {};
    
    for (const entry of flattened) {
        if (!filtered[entry.date]) {
            filtered[entry.date] = [];
        }
        filtered[entry.date].push(entry);
    }
    
    // display chronologically each elements of filtered

```

Plot chronologically