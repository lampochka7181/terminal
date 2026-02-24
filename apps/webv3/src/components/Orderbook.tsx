import { useOrderbook } from '@/hooks/useOrderbook';
import { useSelectedMarket } from '@/stores/marketStore';

export default function Orderbook() {
  const market = useSelectedMarket();
  const ob = useOrderbook(market?.address ?? null);

  const yesAsks = ob.yesAsks.slice(0, 3);
  const noAsks = ob.noAsks.slice(0, 3);
  const hasData = yesAsks.length > 0 || noAsks.length > 0;

  const bestYesAsk = yesAsks[0]?.price ?? 0;
  const bestNoAsk = noAsks[0]?.price ?? 0;
  const combined = bestYesAsk + bestNoAsk;
  const spread = Math.max(0, combined - 1);

  const yesAsksReversed = [...yesAsks].reverse();

  const maxTotal = Math.max(
    ...yesAsks.map((a: any) => a.total ?? a.size ?? 0),
    ...noAsks.map((a: any) => a.total ?? a.size ?? 0),
    1,
  );

  if (!hasData) {
    return (
      <div style={{ fontSize: 20, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'rgba(238,238,238,0.33)' }}>
        Waiting for orders...
      </div>
    );
  }

  return (
    <div style={{ fontSize: 20, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, color: 'rgba(238,238,238,0.33)', marginBottom: 4, padding: '0 4px' }}>
        <span style={{ color: 'rgba(149,255,148,0.5)' }}>YES</span>
        <span>AMOUNT</span>
        <span>TOTAL</span>
      </div>

      {yesAsksReversed.map((ask: any, i: number) => {
        const total = ask.total ?? ask.size;
        return (
          <div key={`yes-${i}`} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '3px 4px', lineHeight: '32px' }}>
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `${(total / maxTotal) * 100}%`, background: 'rgba(149,255,148,0.10)', borderRadius: 2 }} />
            <span style={{ color: '#95ff94', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{ask.price.toFixed(2)}</span>
            <span style={{ color: '#eee', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>${Math.round(ask.size * ask.price).toLocaleString()}</span>
            <span style={{ color: '#eee', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>${Math.round(total * ask.price).toLocaleString()}</span>
          </div>
        );
      })}

      <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 4px', margin: '2px 0', fontSize: 18, color: 'rgba(238,238,238,0.33)' }}>
        SPREAD: {spread.toFixed(2)}
      </div>

      {noAsks.map((ask: any, i: number) => {
        const total = ask.total ?? ask.size;
        return (
          <div key={`no-${i}`} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '3px 4px', lineHeight: '32px' }}>
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: `${(total / maxTotal) * 100}%`, background: 'rgba(255,92,95,0.10)', borderRadius: 2 }} />
            <span style={{ color: '#ff5c5f', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{ask.price.toFixed(2)}</span>
            <span style={{ color: '#eee', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>${Math.round(ask.size * ask.price).toLocaleString()}</span>
            <span style={{ color: '#eee', position: 'relative', zIndex: 1, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>${Math.round(total * ask.price).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
