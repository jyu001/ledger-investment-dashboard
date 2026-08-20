import { readFile, writeFile } from "node:fs/promises";

const dashboardUrl = new URL("../Ledger Dashboard.html", import.meta.url);
const runDate = new Date();
const isoDate = runDate.toISOString().slice(0, 10);
const displayDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Chicago",
}).format(runDate);
const historyStart = new Date(runDate);
historyStart.setUTCFullYear(historyStart.getUTCFullYear() - 10);
const historyStartIso = historyStart.toISOString().slice(0, 10);
const optionsEnd = new Date(runDate);
optionsEnd.setUTCMonth(optionsEnd.getUTCMonth() + 4);
const optionsEndIso = optionsEnd.toISOString().slice(0, 10);
const watchlists = {
  MARKET: ["SPY","IWM","QQQ","SMH","VIX","US10Y","PRNHX","PTTRX"],
  MACRO: ["MP","SHEL","GLD","SLV","ALB","OXY","BABA","KWEB"],
  TECH: ["GOOG","NVDA","MSFT","META","AAPL","RDDT","SPCX","TSLA"],
  CRYPTO: ["BTC","ETH","IBIT","HOOD","COIN","CRCL","BITI","ETHD"],
  SPECIAL: ["MP","BYND","SPCX","ROOT","TDOC","TUYA","IBIT","CRCL"],
};
const etfs = new Set(["SPY","QQQ","IWM","SMH","GLD","SLV","KWEB","IBIT","BITI","ETHD"]);
const mutualFunds = new Set(["PRNHX","PTTRX"]);
const excluded = new Set(["BTC","ETH","VIX","US10Y"]);
const allTickers = [...new Set(Object.values(watchlists).flat())];
const headers = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchText(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (attempt === attempts) throw error;
      await wait(attempt * 700);
    }
  }
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }
const number = value => Number(String(value ?? "").replace(/[$,%]/g, "").replaceAll(",", ""));
const assetClass = ticker => mutualFunds.has(ticker) ? "mutualfunds" : etfs.has(ticker) ? "etf" : "stocks";

async function nasdaqChart(ticker) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/chart?assetclass=${assetClass(ticker)}`;
  const payload = await fetchJson(url);
  const data = payload?.data;
  if (!data) throw new Error("no chart data");
  return {
    quote: {
      price: number(data.lastSalePrice),
      changePct: number(data.percentageChange),
      change: number(data.netChange),
      asOf: data.timeAsOf || "",
    },
    intraday: (data.chart || []).map(point => [new Date(point.x).toISOString(), Number(point.y), 0]).filter(row => Number.isFinite(row[1])),
  };
}

async function nasdaqHistory(ticker) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical?assetclass=${assetClass(ticker)}&fromdate=${historyStartIso}&todate=${isoDate}&limit=10000`;
  const payload = await fetchJson(url);
  const rows = payload?.data?.tradesTable?.rows || [];
  return rows.map(row => {
    const [month, day, year] = row.date.split("/");
    return [`${year}-${month}-${day}`, number(row.close), number(row.volume)];
  }).filter(row => Number.isFinite(row[1])).reverse();
}

const yahooCache = new Map();
async function yahooData(ticker) {
  if (!yahooCache.has(ticker)) yahooCache.set(ticker, (async () => {
    const period1 = Math.floor(new Date(`${historyStartIso}T00:00:00Z`).getTime() / 1000);
    const period2 = Math.floor(new Date(`${isoDate}T23:59:59Z`).getTime() / 1000);
    const payload = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=history`);
    const result = payload?.chart?.result?.[0];
    if (!result) throw new Error("no Yahoo chart data");
    const closes = result.indicators?.adjclose?.[0]?.adjclose || result.indicators?.quote?.[0]?.close || [];
    const history = (result.timestamp || []).map((timestamp, index) => [new Date(timestamp * 1000).toISOString().slice(0, 10), closes[index] == null ? NaN : Number(closes[index]), 0]).filter(row => Number.isFinite(row[1]) && row[1] > 0);
    if (history.length < 2) throw new Error("insufficient Yahoo history");
    const latest = history.at(-1), previous = history.at(-2), change = latest[1] - previous[1];
    return { quote: { price: latest[1], change, changePct: change / previous[1] * 100, asOf: latest[0] }, history };
  })());
  return yahooCache.get(ticker);
}

async function marketChart(ticker) {
  try {
    const result = await nasdaqChart(ticker);
    if (mutualFunds.has(ticker) && !(result.quote.price > 0)) throw new Error("invalid mutual-fund quote");
    return result;
  }
  catch { const result = await yahooData(ticker); return { quote: result.quote, intraday: [] }; }
}
async function marketHistory(ticker) {
  try {
    const result = await nasdaqHistory(ticker);
    if (mutualFunds.has(ticker) && result.length < 2) throw new Error("invalid mutual-fund history");
    return result;
  }
  catch { return (await yahooData(ticker)).history; }
}

async function nasdaqOptions(ticker) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/option-chain?assetclass=stocks&fromdate=${isoDate}&todate=${optionsEndIso}&limit=500`;
  const payload = await fetchJson(url);
  const rows = payload?.data?.table?.rows || [];
  const month = { Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12" };
  const contracts = rows.filter(row => row.expiryDate && number(row.p_Bid) > 0 && number(row.p_Ask) > 0).map(row => {
    const [mon, day] = row.expiryDate.split(" ");
    return {
      expiry: `${runDate.getUTCFullYear()}-${month[mon]}-${String(day).padStart(2, "0")}`,
      strike: number(row.strike),
      bid: number(row.p_Bid),
      ask: number(row.p_Ask),
      last: number(row.p_Last),
      volume: number(row.p_Volume) || 0,
      openInterest: number(row.p_Openinterest) || 0,
    };
  }).filter(row => row.strike >= 70 && row.strike <= 95);
  return { contracts, source: "Nasdaq option chain", asOf: displayDate };
}

async function coingeckoQuotes() {
  const payload = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true");
  return {
    BTC: { price: payload.bitcoin.usd, changePct: payload.bitcoin.usd_24h_change, change: null, asOf: "24-hour crypto market" },
    ETH: { price: payload.ethereum.usd, changePct: payload.ethereum.usd_24h_change, change: null, asOf: "24-hour crypto market" },
  };
}

async function coingeckoHistory(id) {
  const payload = await fetchJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
  return (payload.prices || []).map(([timestamp, price]) => [new Date(timestamp).toISOString().slice(0, 10), Number(price), 0]).filter(row => Number.isFinite(row[1]));
}

async function fredSeries(seriesId) {
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`);
  const rows = csv.trim().split(/\r?\n/).slice(1).map(line => {
    const [date, raw] = line.split(",");
    return [date, raw?.trim() && raw.trim() !== "." ? Number(raw) : NaN];
  }).filter(row => Number.isFinite(row[1]) && row[1] > 0);
  const latest = rows.at(-1), previous = rows.at(-2);
  return {
    quote: { price: latest[1], change: latest[1] - previous[1], changePct: (latest[1] / previous[1] - 1) * 100, asOf: latest[0] },
    history: rows.map(([date, value]) => [date, value, 0]),
  };
}

async function inBatches(items, size, worker) {
  const results = {};
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    await Promise.all(batch.map(async item => {
      try { results[item] = await worker(item); }
      catch (error) { console.warn(`No data for ${item}: ${error.message}`); }
    }));
    await wait(250);
  }
  return results;
}

const marketTickers = allTickers.filter(ticker => !excluded.has(ticker));
const chartResults = await inBatches(marketTickers, 5, marketChart);
const historyResults = await inBatches(marketTickers, 3, marketHistory);
let options = {};
try { options.SHEL = await nasdaqOptions("SHEL"); } catch (error) { console.warn(`SHEL options unavailable: ${error.message}`); }
const quotes = {};
const intraday = {};
for (const [ticker, result] of Object.entries(chartResults)) {
  if (Number.isFinite(result.quote.price)) quotes[ticker] = result.quote;
  if (result.intraday?.length) intraday[ticker] = result.intraday;
}
try { Object.assign(quotes, await coingeckoQuotes()); } catch (error) { console.warn(`Crypto data unavailable: ${error.message}`); }
try { historyResults.BTC = await coingeckoHistory("bitcoin"); } catch (error) { console.warn(`BTC history unavailable: ${error.message}`); }
try { historyResults.ETH = await coingeckoHistory("ethereum"); } catch (error) { console.warn(`ETH history unavailable: ${error.message}`); }
try { const series = await fredSeries("VIXCLS"); quotes.VIX = series.quote; historyResults.VIX = series.history; } catch (error) { console.warn(`VIX unavailable: ${error.message}`); }
try { const series = await fredSeries("DGS10"); quotes.US10Y = series.quote; historyResults.US10Y = series.history; } catch (error) { console.warn(`US10Y unavailable: ${error.message}`); }

const snapshot = { asOf: displayDate, quotes, history: historyResults, intraday, options };
const html = await readFile(dashboardUrl, "utf8");
const updated = html.replace(
  /\/\* MARKET_DATA_START \*\/[\s\S]*?\/\* MARKET_DATA_END \*\//,
  `/* MARKET_DATA_START */${JSON.stringify(snapshot)}/* MARKET_DATA_END */`,
);
if (updated === html) throw new Error("Market data marker not found");
await writeFile(dashboardUrl, updated);
console.log(`Updated ${Object.keys(quotes).length} quotes and ${Object.keys(historyResults).length} full histories through ${displayDate}.`);
