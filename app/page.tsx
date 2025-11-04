"use client";

import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
  CategoryScale,
} from "chart.js";
import { format } from "date-fns";

ChartJS.register(LineElement, LinearScale, PointElement, Tooltip, Legend, CategoryScale);

type TickerAllocation = {
  symbol: string;
  name: string;
  weightPct: number; // 0-100
  proxySymbol?: string; // optional proxy for history
  estYieldPct: number; // trailing yield estimate
};

type SeriesPoint = { date: Date; value: number };

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { adjclose?: Array<{ adjclose?: Array<number | null> }> };
    }>;
  };
};

const DEFAULT_PORTFOLIO: TickerAllocation[] = [
  { symbol: "SCHD", name: "Schwab U.S. Dividend Equity", weightPct: 20, estYieldPct: 3.5 },
  { symbol: "VTI", name: "Vanguard Total US Market", weightPct: 10, estYieldPct: 1.5 },
  { symbol: "VIG", name: "Vanguard Dividend Appreciation", weightPct: 10, estYieldPct: 2.0 },
  { symbol: "JEPI", name: "JPMorgan Equity Premium Income", weightPct: 15, estYieldPct: 8.0, proxySymbol: "SPY" },
  { symbol: "JEPQ", name: "JPMorgan Nasdaq Equity Premium Income", weightPct: 10, estYieldPct: 10.0, proxySymbol: "QQQ" },
  { symbol: "VNQ", name: "Vanguard Real Estate", weightPct: 10, estYieldPct: 4.0 },
  { symbol: "PFF", name: "iShares Preferred & Income Securities", weightPct: 10, estYieldPct: 6.0 },
  { symbol: "LQD", name: "iShares iBoxx $ Inv Grade Corporate Bond", weightPct: 10, estYieldPct: 4.5 },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond", weightPct: 5, estYieldPct: 4.5 },
];

const START_PORTFOLIO_VALUE = 2_500_000; // $2.5M
const TARGET_ANNUAL_INCOME = 120_000; // $120k

async function fetchYahooMonthlyAdjClose(symbol: string, range: string = "10y"): Promise<SeriesPoint[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1mo&events=div%2Csplit`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${symbol}`);
  const data = (await res.json()) as YahooChartResponse;
  const r = data.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const points: SeriesPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const a = adj[i];
    if (a == null) continue;
    points.push({ date: new Date((ts[i] as number) * 1000), value: a as number });
  }
  // filter out the last partial month if today is too early in the month
  return points.filter((p) => !Number.isNaN(p.value));
}

function blendWithProxy(primary: SeriesPoint[], proxy: SeriesPoint[]): SeriesPoint[] {
  if (primary.length === 0) return proxy;
  const primaryStartDate = primary[0].date;
  const proxyBefore = proxy.filter((p) => p.date < primaryStartDate);
  if (proxyBefore.length === 0) return primary;
  // scale proxy earlier portion to match first primary value
  const firstPrimary = primary[0].value;
  const lastProxyBefore = proxyBefore[proxyBefore.length - 1].value;
  const scale = firstPrimary / lastProxyBefore;
  const scaledProxy = proxyBefore.map((p) => ({ date: p.date, value: p.value * scale }));
  return [...scaledProxy, ...primary];
}

function toMonthlyReturns(series: SeriesPoint[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].value;
    const curr = series[i].value;
    rets.push(curr / prev - 1);
  }
  return rets;
}

function weightedPortfolioReturns(returnsBySymbol: Record<string, number[]>, allocations: TickerAllocation[]): number[] {
  const length = Math.min(
    ...allocations.map((a) => returnsBySymbol[a.symbol]?.length ?? 0)
  );
  const weights = allocations.map((a) => a.weightPct / 100);
  const symbols = allocations.map((a) => a.symbol);
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    let r = 0;
    for (let j = 0; j < symbols.length; j++) {
      const s = symbols[j];
      r += (returnsBySymbol[s][i] ?? 0) * weights[j];
    }
    result.push(r);
  }
  return result;
}

function seriesFromReturns(startValue: number, monthlyReturns: number[]): SeriesPoint[] {
  let v = startValue;
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - monthlyReturns.length);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < monthlyReturns.length; i++) {
    v *= 1 + monthlyReturns[i];
    const d = new Date(startDate);
    d.setMonth(startDate.getMonth() + i + 1);
    out.push({ date: d, value: v });
  }
  return out;
}

function fmtUSD(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

export default function Page() {
  const [allocs, setAllocs] = useState<TickerAllocation[]>(DEFAULT_PORTFOLIO);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portfolioSeries, setPortfolioSeries] = useState<SeriesPoint[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [annualIncome, setAnnualIncome] = useState<number>(0);

  const totalWeight = useMemo(() => allocs.reduce((s, a) => s + a.weightPct, 0), [allocs]);
  const estYield = useMemo(() => allocs.reduce((s, a) => s + (a.weightPct / 100) * a.estYieldPct, 0), [allocs]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        // fetch all series in parallel
        const symbols = Array.from(new Set(allocs.map((a) => a.symbol)));
        const proxySymbols = Array.from(
          new Set(allocs.map((a) => a.proxySymbol).filter(Boolean) as string[])
        );

        const symbolSet = Array.from(new Set([...symbols, ...proxySymbols]));

        const seriesMapEntries = await Promise.all(
          symbolSet.map(async (s) => {
            try {
              const data = await fetchYahooMonthlyAdjClose(s);
              return [s, data] as const;
            } catch (e) {
              console.error("fetch error", s, e);
              return [s, [] as SeriesPoint[]] as const;
            }
          })
        );
        const seriesMap = Object.fromEntries(seriesMapEntries) as Record<string, SeriesPoint[]>;

        // build per-symbol longer series with proxy if needed
        const fullSeries: Record<string, SeriesPoint[]> = {};
        for (const a of allocs) {
          const prim = seriesMap[a.symbol] ?? [];
          const proxy = a.proxySymbol ? seriesMap[a.proxySymbol] ?? [] : [];
          fullSeries[a.symbol] = a.proxySymbol ? blendWithProxy(prim, proxy) : prim;
        }

        // compute monthly returns per symbol
        const returnsBySymbol: Record<string, number[]> = {};
        for (const a of allocs) {
          returnsBySymbol[a.symbol] = toMonthlyReturns(fullSeries[a.symbol] ?? []);
        }

        const portMonthly = weightedPortfolioReturns(returnsBySymbol, allocs);
        const portSeries = seriesFromReturns(START_PORTFOLIO_VALUE, portMonthly);
        setPortfolioSeries(portSeries);
        setLabels(portSeries.map((p) => format(p.date, "MMM yyyy")));

        // income estimate from weighted yields on current value
        const income = (estYield / 100) * START_PORTFOLIO_VALUE;
        setAnnualIncome(income);
      } catch (e: any) {
        setError(e?.message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [allocs, estYield]);

  const lastValue = portfolioSeries.at(-1)?.value ?? START_PORTFOLIO_VALUE;

  const forecastSeries = useMemo(() => {
    // 5-year forward projection using last 5-year CAGR of portfolio monthly returns
    if (portfolioSeries.length < 60) return [] as SeriesPoint[];
    const first = portfolioSeries[portfolioSeries.length - 60].value;
    const last = portfolioSeries[portfolioSeries.length - 1].value;
    const years = 5;
    const cagr = Math.pow(last / first, 1 / 5) - 1;
    const monthly = Math.pow(1 + cagr, 1 / 12) - 1;
    let v = last;
    const out: SeriesPoint[] = [];
    for (let i = 0; i < years * 12; i++) {
      v *= 1 + monthly;
      const d = new Date();
      d.setMonth(d.getMonth() + i + 1);
      out.push({ date: d, value: v });
    }
    return out;
  }, [portfolioSeries]);

  const chartData = useMemo(() => ({
    labels,
    datasets: [
      {
        label: "Backtest Value",
        data: portfolioSeries.map((p) => p.value),
        borderColor: "#0284c7",
        backgroundColor: "rgba(2,132,199,0.15)",
        tension: 0.2,
      },
      ...(forecastSeries.length
        ? [
            {
              label: "Forecast (5y)",
              data: [...new Array(portfolioSeries.length - 1).fill(null), ...forecastSeries.map((p) => p.value)],
              borderColor: "#16a34a",
              backgroundColor: "rgba(22,163,74,0.15)",
              borderDash: [6, 6],
              tension: 0.2,
            },
          ]
        : []),
    ],
  }), [labels, portfolioSeries, forecastSeries]);

  const totalIncomeBadgeClass = annualIncome >= TARGET_ANNUAL_INCOME ? "badge badge-green" : "badge badge-amber";

  return (
    <div className="container">
      <div className="grid" style={{ gap: 20 }}>
        <div className="card">
          <div className="h1">Income Flywheel Portfolio</div>
          <div className="muted">$2.5M base. Target income: {fmtUSD(TARGET_ANNUAL_INCOME)}. Emphasize compounding and growth.</div>
        </div>

        <div className="grid grid-3">
          <div className="card">
            <div className="h2">Summary</div>
            <div className="grid" style={{ gap: 8 }}>
              <div className="flex"><span className="muted">Portfolio Value</span><strong style={{ marginLeft: "auto" }}>{fmtUSD(lastValue)}</strong></div>
              <div className="flex"><span className="muted">Est. Yield</span><strong style={{ marginLeft: "auto" }}>{estYield.toFixed(2)}%</strong></div>
              <div className="flex"><span className="muted">Est. Annual Income</span><strong style={{ marginLeft: "auto" }}>{fmtUSD(annualIncome)}</strong></div>
              <div className="flex"><span className="muted">Target Status</span><span className={totalIncomeBadgeClass}>{annualIncome >= TARGET_ANNUAL_INCOME ? "Meets target" : "Below target"}</span></div>
            </div>
            <div className="small muted" style={{ marginTop: 12 }}>Note: Yield is an estimate based on trailing yields for each ETF; actual income varies.</div>
          </div>

          <div className="card" style={{ gridColumn: "span 2" }}>
            <div className="h2">Backtest 10y and 5y Projection</div>
            {error && <div style={{ color: "#b91c1c", marginBottom: 8 }}>Error: {error}</div>}
            {loading ? <div>Loading...</div> : (
              <Line
                data={chartData}
                options={{
                  responsive: true,
                  plugins: {
                    legend: { position: "top" as const },
                    tooltip: { mode: "index", intersect: false },
                  },
                  scales: {
                    y: { ticks: { callback: (v) => `$${Number(v).toLocaleString()}` } },
                  },
                }}
              />
            )}
          </div>
        </div>

        <div className="card">
          <div className="h2">Recommended Tickers and Allocations</div>
          <div className="muted" style={{ marginBottom: 8 }}>Adjust weights to taste; total should equal 100%.</div>
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th className="right">Weight %</th>
                <th className="right">Est. Yield %</th>
                <th className="right">Allocation $</th>
                <th className="right">Est. Income $</th>
              </tr>
            </thead>
            <tbody>
              {allocs.map((a, idx) => {
                const allocUSD = (a.weightPct / 100) * START_PORTFOLIO_VALUE;
                const incomeUSD = allocUSD * (a.estYieldPct / 100);
                return (
                  <tr key={a.symbol}>
                    <td><strong>{a.symbol}</strong>{a.proxySymbol ? <span className="small muted"> (proxy: {a.proxySymbol})</span> : null}</td>
                    <td>{a.name}</td>
                    <td className="right">
                      <input
                        className="input"
                        type="number"
                        step={0.5}
                        value={a.weightPct}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setAllocs((prev) => prev.map((p, j) => j === idx ? { ...p, weightPct: v } : p));
                        }}
                        style={{ width: 90, textAlign: "right" }}
                      />
                    </td>
                    <td className="right">
                      <input
                        className="input"
                        type="number"
                        step={0.1}
                        value={a.estYieldPct}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setAllocs((prev) => prev.map((p, j) => j === idx ? { ...p, estYieldPct: v } : p));
                        }}
                        style={{ width: 90, textAlign: "right" }}
                      />
                    </td>
                    <td className="right">{fmtUSD(allocUSD)}</td>
                    <td className="right">{fmtUSD(incomeUSD)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}><strong>Total</strong></td>
                <td className="right"><strong>{totalWeight.toFixed(1)}%</strong></td>
                <td className="right"><strong>{estYield.toFixed(2)}%</strong></td>
                <td className="right"><strong>{fmtUSD(START_PORTFOLIO_VALUE)}</strong></td>
                <td className="right"><strong>{fmtUSD(annualIncome)}</strong></td>
              </tr>
            </tfoot>
          </table>
          <div className="small muted" style={{ marginTop: 8 }}>
            Disclosure: Hypothetical model for educational purposes only. Not investment advice. Past performance does not guarantee future results.
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="h2">Income Flywheel</div>
            <ul>
              <li>Reinvest a portion of income into growth sleeves (VTI, VIG) to compound.</li>
              <li>Use high-yield sleeve (JEPI, JEPQ, PFF, VNQ) to fund withdrawals.</li>
              <li>Rebalance annually to maintain risk and income targets.</li>
            </ul>
          </div>
          <div className="card">
            <div className="h2">Assumptions</div>
            <ul>
              <li>Backtest uses Yahoo adjusted close (total-return approximation).</li>
              <li>Where history is short (JEPI/JEPQ), proxies SPY/QQQ are blended.</li>
              <li>Forecast uses trailing 5-year CAGR extrapolated monthly for 5 years.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
