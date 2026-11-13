// Price lookup with manual overrides, carry-forward, and stale flags.
// quotes shape: { tickers: { VOO: { source, asOf, close: {date: px}, adjClose: {date: px} } } }

export class PriceBook {
  constructor(quotes = { tickers: {} }, manual = {}) {
    this.q = quotes.tickers || {};
    this.manual = manual; // {ticker: {date: price}}
    this._sorted = {};
  }
  _dates(ticker, field) {
    const key = ticker + '|' + field;
    if (!this._sorted[key]) {
      // Manual prices are a last resort and apply to both fields (they are unadjusted spot prices).
      const series = Object.assign({}, this.q[ticker]?.[field] || {}, this.manual[ticker] || {});
      this._sorted[key] = Object.keys(series).sort().map((d) => [d, series[d]]);
    }
    return this._sorted[key];
  }
  // Returns {price, date, stale, missing}. Carries the last price forward.
  lookup(ticker, date, field = 'close') {
    const arr = this._dates(ticker, field);
    if (!arr.length) return { price: null, date: null, stale: true, missing: true };
    let lo = 0, hi = arr.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][0] <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return { price: null, date: null, stale: true, missing: true };
    const [d, p] = arr[best];
    const gap = (Date.parse(date) - Date.parse(d)) / 86400000;
    return { price: p, date: d, stale: gap > 7, missing: false };
  }
  hasAny(ticker) { return this._dates(ticker, 'close').length > 0; }
}
