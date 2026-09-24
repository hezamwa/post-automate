// The /admin/budget breakdown (article-workflow §8): month-to-date spend by task, by model
// (with cached tokens) and by run outcome, and what one published article costs.

export interface Breakdown {
  byTaskType: { taskType: string; usd: number; calls: number }[];
  byModel: { provider: string; model: string; usd: number; calls: number; cacheReadTokens: number; cacheWriteTokens: number }[];
  byRunOutcome: Record<string, number>;
  publishedArticles: number;
  costPerPublishedArticleUsd: number | null;
  directCostPerPublishedArticleUsd: number | null;
}

const usd = (n: number | null, digits = 3) => (n == null ? "—" : `$${n.toFixed(digits)}`);

export function BudgetBreakdown({ data }: { data: Breakdown }) {
  const outcomes = Object.entries(data.byRunOutcome).filter(([, v]) => v > 0);
  return (
    <div className="panel">
      <h2>Spend breakdown (this month)</h2>
      <p>
        <strong>{data.publishedArticles}</strong> published · cost per published article{" "}
        <strong>{usd(data.costPerPublishedArticleUsd)}</strong>{" "}
        <span className="muted">(direct, published runs only: {usd(data.directCostPerPublishedArticleUsd)})</span>
      </p>
      <table>
        <thead><tr><th>Task</th><th>Calls</th><th>USD</th></tr></thead>
        <tbody>
          {data.byTaskType.map((t) => (
            <tr key={t.taskType}><td>{t.taskType}</td><td>{t.calls}</td><td>{usd(t.usd)}</td></tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead><tr><th>Model</th><th>Calls</th><th>Cached read / write tokens</th><th>USD</th></tr></thead>
        <tbody>
          {data.byModel.map((m) => (
            <tr key={`${m.provider}/${m.model}`}>
              <td>{m.provider}/{m.model}</td>
              <td>{m.calls}</td>
              <td className="muted">{m.cacheReadTokens} / {m.cacheWriteTokens}</td>
              <td>{usd(m.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        By run outcome: {outcomes.map(([k, v]) => `${k.replace("_", " ")} ${usd(v, 2)}`).join(" · ") || "—"}
      </p>
    </div>
  );
}
