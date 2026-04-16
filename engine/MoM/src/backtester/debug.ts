import 'dotenv/config';

async function run() {
    const apiKey = process.env.DATABENTO_API_KEY;
    if (!apiKey) throw new Error("Missing DATABENTO_API_KEY");

    const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
    const params = new URLSearchParams({
        dataset: 'GLBX.MDP3',
        schema: 'ohlcv-1m',
        symbols: 'MES.c.0',
        start: '2026-02-03T10:00:00Z',
        end: '2026-02-03T11:00:00Z', // Random Tuesday!
        encoding: 'json',
        stype_in: 'continuous'
    });

    const url = `https://hist.databento.com/v0/timeseries.get_range?${params.toString()}`;
    const response = await fetch(url, { headers: { 'Authorization': authHeader } });
    const text = await response.text();
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    console.log("\n=== DATABENTO RAW JSON DEBUG ===");
    console.log("LINE 1:", lines[0]);
    console.log("LINE 2:", lines[1]);
    console.log("================================\n");
}

run();