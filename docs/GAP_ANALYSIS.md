# Análise de Gaps - CME_MINI:NQ1!

## Dados Coletados via WebSocket (2025-12-28)

| Timeframe | Candles | Início     | Fim        | Dias   | Limitado? |
| --------- | ------- | ---------- | ---------- | ------ | --------- |
| 1M        | 319     | 1999-05-31 | 2025-11-30 | ~9.720 | ❌ Todos  |
| 1W        | 1.384   | 1999-06-27 | 2025-12-28 | ~9.720 | ❌ Todos  |
| 1D        | 6.702   | 1999-06-29 | 2025-12-28 | ~9.680 | ❌ Todos  |
| 4H        | 10.000  | 2019-07-02 | 2025-12-28 | ~2.370 | ✅ 10k    |
| 1H        | 10.000  | 2024-04-17 | 2025-12-29 | ~620   | ✅ 10k    |
| 15m       | 10.000  | 2025-07-25 | 2025-12-29 | ~157   | ✅ 10k    |
| 5m        | 10.000  | 2025-11-04 | 2025-12-29 | ~54    | ✅ 10k    |
| 3m        | 10.000  | 2025-11-25 | 2025-12-29 | ~34    | ✅ 10k    |
| 1m        | 10.000  | 2025-12-16 | 2025-12-29 | ~12    | ✅ 10k    |

## Fator de Mercado Médio: 1.57x

(Dias reais = Dias teóricos × 1.57, pois mercado não opera 24/7)

## Configuração de Gaps para Playwright

```typescript
const TIMEFRAME_CONFIG: Record<string, TimeframeConfig> = {
  // Baseado em análise WebSocket (10k candles por download)
  "1": { gapCandles: 10000, timeMinutes: 1 }, // ~12 dias reais
  "3": { gapCandles: 10000, timeMinutes: 3 }, // ~34 dias reais
  "5": { gapCandles: 10000, timeMinutes: 5 }, // ~54 dias reais
  "15": { gapCandles: 10000, timeMinutes: 15 }, // ~157 dias reais
  "60": { gapCandles: 10000, timeMinutes: 60 }, // ~620 dias reais
  "240": { gapCandles: 10000, timeMinutes: 240 }, // ~2370 dias reais
};
```

## Conclusões

1. **Mensal, Semanal, Diário**: WebSocket retorna TODOS os dados (não precisa de Playwright)
2. **4H e menores**: Limite de ~10k candles por requisição via WebSocket
3. **Gap de 10k candles**: Configuração ideal confirmada para Playwright
